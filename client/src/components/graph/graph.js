import React from "react";
import * as d3 from "d3";
import { connect, shallowEqual } from "react-redux";
import { mat3, vec2 } from "gl-matrix";
import _regl from "regl";
import memoize from "memoize-one";
import Async from "react-async";
import { Button, Card, Elevation } from "@blueprintjs/core";
import { Popover2 } from "@blueprintjs/popover2";
import Sankey from "../sankey";
import setupSVGandBrushElements from "./setupSVGandBrush";
import _camera from "../../util/camera";
import _drawPoints from "./drawPointsRegl";
import {
  createColorTable,
  createColorQuery,
} from "../../util/stateManager/colorHelpers";
import * as globals from "../../globals";

import GraphOverlayLayer from "./overlays/graphOverlayLayer";
import CentroidLabels from "./overlays/centroidLabels";
import actions from "../../actions";
import renderThrottle from "../../util/renderThrottle";

import {
  flagBackground,
  flagSelected,
  flagHighlight,
} from "../../util/glHelpers";

/*
Simple 2D transforms control all point painting.  There are three:
  * model - convert from underlying per-point coordinate to a layout.
    Currently used to move from data to webgl coordinate system.
  * camera - apply a 2D camera transformation (pan, zoom)
  * projection - apply any transformation required for screen size and layout
*/
function createProjectionTF(viewportWidth, viewportHeight) {
  /*
  the projection transform accounts for the screen size & other layout
  */
  const fractionToUse = 0.95; // fraction of min dimension to use
  const topGutterSizePx = 32; // top gutter for tools
  const bottomGutterSizePx = 32; // bottom gutter for tools
  const heightMinusGutter =
    viewportHeight - topGutterSizePx - bottomGutterSizePx;
  const minDim = Math.min(viewportWidth, heightMinusGutter);
  const aspectScale = [
    (fractionToUse * minDim) / viewportWidth,
    (fractionToUse * minDim) / viewportHeight,
  ];
  const m = mat3.create();
  mat3.fromTranslation(m, [
    0,
    (bottomGutterSizePx - topGutterSizePx) / viewportHeight / aspectScale[1],
  ]);
  mat3.scale(m, m, aspectScale);
  return m;
}

function createModelTF() {
  /*
  preallocate coordinate system transformation between data and gl.
  Data arrives in a [0,1] range, and we operate elsewhere in [-1,1].
  */
  const m = mat3.fromScaling(mat3.create(), [2, 2]);
  mat3.translate(m, m, [-0.5, -0.5]);
  return m;
}

@connect((state) => ({
  annoMatrix: state.annoMatrix,
  crossfilter: state.obsCrossfilter,
  selectionTool: state.graphSelection.tool,
  currentSelection: state.graphSelection.selection,
  layoutChoice: state.layoutChoice,
  graphInteractionMode: state.controls.graphInteractionMode,
  colors: state.colors,
  pointDilation: state.pointDilation,
  genesets: state.genesets.genesets,
  multiselect: state.graphSelection.multiselect,
}))
class Graph extends React.Component {
  static createReglState(canvas) {
    /*
    Must be created for each canvas
    */
    // setup canvas, webgl draw function and camera
    const camera = _camera(canvas);
    const regl = _regl(canvas);
    const drawPoints = _drawPoints(regl);

    // preallocate webgl buffers
    const pointBuffer = regl.buffer();
    const colorBuffer = regl.buffer();
    const flagBuffer = regl.buffer();

    return {
      camera,
      regl,
      drawPoints,
      pointBuffer,
      colorBuffer,
      flagBuffer,
    };
  }

  static watchAsync(props, prevProps) {
    return !shallowEqual(props.watchProps, prevProps.watchProps);
  }

  myRef = React.createRef();

  computePointPositions = memoize((X, Y, modelTF) => {
    /*
    compute the model coordinate for each point
    */
    const positions = new Float32Array(2 * X.length);
    for (let i = 0, len = X.length; i < len; i += 1) {
      const p = vec2.fromValues(X[i], Y[i]);
      vec2.transformMat3(p, p, modelTF);
      positions[2 * i] = p[0];
      positions[2 * i + 1] = p[1];
    }
    return positions;
  });

  computePointColors = memoize((rgb) => {
    /*
    compute webgl colors for each point
    */
    const colors = new Float32Array(3 * rgb.length);
    for (let i = 0, len = rgb.length; i < len; i += 1) {
      colors.set(rgb[i], 3 * i);
    }
    return colors;
  });

  computeSelectedFlags = memoize(
    (crossfilter, colorMode, colorDf, _flagSelected, _flagUnselected) => {
      const x = crossfilter.fillByIsSelected(
        new Float32Array(crossfilter.size()),
        _flagSelected,
        _flagUnselected
      );
      if (colorDf && colorMode !== "color by categorical metadata") {
        const col = colorDf.icol(0).asArray();
        for (let i = 0, len = x.length; i < len; i += 1) {
          if (col[i]===0){
            x[i] = 0;
          }
        }
      }
      return x;
    }
  );

  computeHighlightFlags = memoize(
    (nObs, pointDilationData, pointDilationLabel) => {
      const flags = new Float32Array(nObs);
      if (pointDilationData) {
        for (let i = 0, len = flags.length; i < len; i += 1) {
          if (pointDilationData[i] === pointDilationLabel) {
            flags[i] = flagHighlight;
          }
        }
      }
      return flags;
    }
  );

  computeColorByFlags = memoize((nObs, colorByData) => {
    const flags = new Float32Array(nObs);
    if (colorByData) {
      for (let i = 0, len = flags.length; i < len; i += 1) {
        const val = colorByData[i];
        if (typeof val === "number" && !Number.isFinite(val)) {
          flags[i] = flagBackground;
        }
      }
    }
    return flags;
  });

  computePointFlags = memoize(
    (crossfilter, colorByData, colorMode, colorDf, pointDilationData, pointDilationLabel) => {
      /*
      We communicate with the shader using three flags:
      - isNaN -- the value is a NaN. Only makes sense when we have a colorAccessor
      - isSelected -- the value is selected
      - isHightlighted -- the value is highlighted in the UI (orthogonal from selection highlighting)

      Due to constraints in webgl vertex shader attributes, these are encoded in a float, "kinda"
      like bitmasks.

      We also have separate code paths for generating flags for categorical and
      continuous metadata, as they rely on different tests, and some of the flags
      (eg, isNaN) are meaningless in the face of categorical metadata.
      */
      const nObs = crossfilter.size();
      const flags = new Float32Array(nObs);

      const selectedFlags = this.computeSelectedFlags(
        crossfilter,
        colorMode,
        colorDf, 
        flagSelected,
        0
      );
      const highlightFlags = this.computeHighlightFlags(
        nObs,
        pointDilationData,
        pointDilationLabel
      );
      const colorByFlags = this.computeColorByFlags(nObs, colorByData);
      for (let i = 0; i < nObs; i += 1) {
        flags[i] = selectedFlags[i] + highlightFlags[i] + colorByFlags[i];
      }

      return flags;
    }
  );

  constructor(props) {
    super(props);
    const viewport = this.getViewportDimensions();
    this.reglCanvas = null;
    this.cachedAsyncProps = null;
    const modelTF = createModelTF();
    this.state = {
      toolSVG: null,
      tool: null,
      container: null,
      viewport,

      // projection
      camera: null,
      modelTF,
      modelInvTF: mat3.invert([], modelTF),
      projectionTF: createProjectionTF(viewport.width, viewport.height),
      renderedMetadata: (
        <Card interactive elevation={Elevation.TWO}>
          {`No cells in range.`}
        </Card>
      ),
      // regl state
      regl: null,
      drawPoints: null,
      pointBuffer: null,
      colorBuffer: null,
      flagBuffer: null,

      // component rendering derived state - these must stay synchronized
      // with the reducer state they were generated from.
      layoutState: {
        layoutDf: null,
        layoutChoice: null,
      },
      colorState: {
        colors: null,
        colorDf: null,
        colorTable: null,
      },
      pointDilationState: {
        pointDilation: null,
        pointDilationDf: null,
      },
    };
  }

  componentDidMount() {
    window.addEventListener("resize", this.handleResize);
    this.myRef.current.addEventListener("wheel", this.handleLidarWheelEvent, {
      passive: false,
    });
  }

  componentDidUpdate(prevProps, prevState) {
    const {
      selectionTool,
      currentSelection,
      graphInteractionMode,
    } = this.props;
    const { toolSVG, viewport } = this.state;
    const hasResized =
      prevState.viewport.height !== viewport.height ||
      prevState.viewport.width !== viewport.width;
    let stateChanges = {};

    if (
      (viewport.height && viewport.width && !toolSVG) || // first time init
      hasResized || //  window size has changed we want to recreate all SVGs
      selectionTool !== prevProps.selectionTool || // change of selection tool
      prevProps.graphInteractionMode !== graphInteractionMode // lasso/zoom mode is switched
    ) {
      stateChanges = {
        ...stateChanges,
        ...this.createToolSVG(),
      };
    }

    /*
    if the selection tool or state has changed, ensure that the selection
    tool correctly reflects the underlying selection.
    */
    if (
      currentSelection !== prevProps.currentSelection ||
      graphInteractionMode !== prevProps.graphInteractionMode ||
      stateChanges.toolSVG
    ) {
      const { tool, container } = this.state;
      this.selectionToolUpdate(
        stateChanges.tool ? stateChanges.tool : tool,
        stateChanges.container ? stateChanges.container : container
      );
    }
    if (Object.keys(stateChanges).length > 0) {
      // eslint-disable-next-line react/no-did-update-set-state --- Preventing update loop via stateChanges and diff checks
      this.setState(stateChanges);
    }
  }

  componentWillUnmount() {
    window.removeEventListener("resize", this.handleResize);
    this.myRef.current.removeEventListener(
      "wheel",
      this.handleLidarWheelEvent,
      { passive: false }
    );
  }

  handleResize = () => {
    const { state } = this.state;
    const viewport = this.getViewportDimensions();
    const projectionTF = createProjectionTF(viewport.width, viewport.height);
    this.setState({
      ...state,
      viewport,
      projectionTF,
    });
  };

  handleCanvasEvent = (e) => {
    const { camera, projectionTF } = this.state;
    if (e.type !== "wheel") e.preventDefault();
    if (camera.handleEvent(e, projectionTF)) {
      this.renderCanvas();
      this.setState((state) => {
        return { ...state, updateOverlay: !state.updateOverlay };
      });
    }
  };

  handleLidarWheelEvent = (e) => {
    const { graphInteractionMode } = this.props;
    if (graphInteractionMode === "lidar") {
      const { lidarRadius } = this.state;
      e.preventDefault();
      const offset = e.deltaY < 0 ? -1.5 : 1.5;

      const radius = (lidarRadius ?? 20) + offset;
      this.setState((state) => {
        return { ...state, lidarRadius: radius < 10 ? 10 : radius };
      });
    }
  };

  handleLidarEvent = (e) => {
    if (e.type === "mousemove") {
      if (e.target.id === "lidar-layer") {
        this.setState((state) => {
          return { ...state, lidarFocused: true };
        });
      }
      const rect = e.target.getBoundingClientRect();
      const screenX = e.pageX - rect.left;
      const screenY = e.pageY - rect.top;
      const point = this.mapScreenToPoint([screenX, screenY]);
      this.setState((state) => {
        return {
          ...state,
          screenX,
          screenY,
          pointX: point[0],
          pointY: point[1],
        };
      });
    } else if(e.type === "mousedown") {

      this.fetchLidarCrossfilter();
      
    } else if (e.type === "mouseleave") {
      this.setState((state) => {
        return { ...state, lidarFocused: false, renderedMetadata: (
          <Card interactive elevation={Elevation.TWO}>
            {`No cells in range.`}
          </Card>
        )};
      });
    }
  };

  handleBrushDragAction() {
    /*
      event describing brush position:
      @-------|
      |       |
      |       |
      |-------@
    */
    // ignore programatically generated events
    if (d3.event.sourceEvent === null || !d3.event.selection) return;

    const { dispatch, layoutChoice } = this.props;
    const s = d3.event.selection;
    const northwest = this.mapScreenToPoint(s[0]);
    const southeast = this.mapScreenToPoint(s[1]);
    const [minX, maxY] = northwest;
    const [maxX, minY] = southeast;
    dispatch(
      actions.graphBrushChangeAction(layoutChoice.current, {
        minX,
        minY,
        maxX,
        maxY,
        northwest,
        southeast,
      })
    );
  }

  handleBrushStartAction() {
    // Ignore programatically generated events.
    if (!d3.event.sourceEvent) return;

    const { dispatch } = this.props;
    dispatch(actions.graphBrushStartAction());
  }

  handleBrushEndAction() {
    // Ignore programatically generated events.
    if (!d3.event.sourceEvent) return;

    /*
    coordinates will be included if selection made, null
    if selection cleared.
    */
    const { dispatch, layoutChoice } = this.props;
    const s = d3.event.selection;
    if (s) {
      const northwest = this.mapScreenToPoint(s[0]);
      const southeast = this.mapScreenToPoint(s[1]);
      const [minX, maxY] = northwest;
      const [maxX, minY] = southeast;
      dispatch(
        actions.graphBrushEndAction(layoutChoice.current, {
          minX,
          minY,
          maxX,
          maxY,
          northwest,
          southeast,
        })
      );
    } else {
      dispatch(actions.graphBrushDeselectAction(layoutChoice.current));
    }
  }

  handleBrushDeselectAction() {
    const { dispatch, layoutChoice } = this.props;
    dispatch(actions.graphBrushDeselectAction(layoutChoice.current));
  }

  handleLassoStart() {
    const { dispatch, layoutChoice } = this.props;
    dispatch(actions.graphLassoStartAction(layoutChoice.current));
  }

  // when a lasso is completed, filter to the points within the lasso polygon
  handleLassoEnd(polygon) {
    const minimumPolygonArea = 10;
    const { dispatch, layoutChoice, multiselect } = this.props;

    if (
      polygon.length < 3 ||
      Math.abs(d3.polygonArea(polygon)) < minimumPolygonArea
    ) {
      // if less than three points, or super small area, treat as a clear selection.
      dispatch(actions.graphLassoDeselectAction(layoutChoice.current));
    } else {
      dispatch(
        actions.graphLassoEndAction(
          layoutChoice.current,
          polygon.map((xy) => this.mapScreenToPoint(xy)),
          multiselect
        )
      );
    }
  }

  handleLassoCancel() {
    const { dispatch, layoutChoice } = this.props;
    dispatch(actions.graphLassoCancelAction(layoutChoice.current));
  }

  handleLassoDeselectAction() {
    const { dispatch, layoutChoice } = this.props;
    dispatch(actions.graphLassoDeselectAction(layoutChoice.current));
  }

  handleDeselectAction() {
    const { selectionTool } = this.props;
    if (selectionTool === "brush") this.handleBrushDeselectAction();
    if (selectionTool === "lasso") this.handleLassoDeselectAction();
  }

  handleOpacityRangeChange(e) {
    const { dispatch } = this.props;
    dispatch({
      type: "change opacity deselected cells in 2d graph background",
      data: e.target.value,
    });
  }

  setReglCanvas = (canvas) => {
    this.reglCanvas = canvas;
    this.setState({
      ...Graph.createReglState(canvas),
    });
  };

  getViewportDimensions = () => {
    const { viewportRef } = this.props;
    return {
      height: viewportRef.clientHeight,
      width: viewportRef.clientWidth,
    };
  };

  createToolSVG = () => {
    /*
    Called from componentDidUpdate. Create the tool SVG, and return any
    state changes that should be passed to setState().
    */
    const { selectionTool, graphInteractionMode } = this.props;
    const { viewport } = this.state;

    /* clear out whatever was on the div, even if nothing, but usually the brushes etc */
    const lasso = d3.select("#lasso-layer");

    const lidar = d3.select("#lidar-layer");
    if (!lidar.empty()) {
      lidar.selectAll(".lidar-group").remove();
    }
    if (lasso.empty()) return {}; // still initializing
    lasso.selectAll(".lasso-group").remove();

    // Don't render or recreate toolSVG if currently in zoom mode
    if (graphInteractionMode !== "select" && graphInteractionMode !== "lidar") {
      // don't return "change" of state unless we are really changing it!
      const { toolSVG } = this.state;
      if (toolSVG === undefined) return {};
      return { toolSVG: undefined };
    }

    let handleStart;
    let handleDrag;
    let handleEnd;
    let handleCancel;
    if (selectionTool === "brush") {
      handleStart = this.handleBrushStartAction.bind(this);
      handleDrag = this.handleBrushDragAction.bind(this);
      handleEnd = this.handleBrushEndAction.bind(this);
    } else {
      handleStart = this.handleLassoStart.bind(this);
      handleEnd = this.handleLassoEnd.bind(this);
      handleCancel = this.handleLassoCancel.bind(this);
    }

    const { svg: newToolSVG, tool, container } = setupSVGandBrushElements(
      selectionTool,
      handleStart,
      handleDrag,
      handleEnd,
      handleCancel,
      viewport
    );

    return { toolSVG: newToolSVG, tool, container };
  };

  fetchAsyncProps = async (props) => {
    const {
      annoMatrix,
      colors: colorsProp,
      layoutChoice,
      crossfilter,
      pointDilation,
      viewport,
    } = props.watchProps;
    const { modelTF } = this.state;

    const [layoutDf, colorDf, pointDilationDf] = await this.fetchData(
      annoMatrix,
      layoutChoice,
      colorsProp,
      pointDilation
    );

    const { currentDimNames } = layoutChoice;
    const X = layoutDf.col(currentDimNames[0]).asArray();
    const Y = layoutDf.col(currentDimNames[1]).asArray();

    const positions = this.computePointPositions(X, Y, modelTF);
    const colorTable = this.updateColorTable(colorsProp, colorDf);
    const colors = this.computePointColors(colorTable.rgb);

    const { colorAccessor } = colorsProp;
    const colorByData = colorDf?.col(colorAccessor)?.asArray();

    const {
      metadataField: pointDilationCategory,
      categoryField: pointDilationLabel,
    } = pointDilation;
    const pointDilationData = pointDilationDf
      ?.col(pointDilationCategory)
      ?.asArray();

    const flags = this.computePointFlags(
      crossfilter,
      colorByData,
      colorsProp.colorMode,
      colorDf,
      pointDilationData,
      pointDilationLabel
    );
    this.setState((state) => {
      return { ...state, colorState: { colors, colorDf, colorTable } };
    });

    const { width, height } = viewport;


    return {
      positions,
      colors,
      flags,
      width,
      height,
    };
  };

  async fetchData(annoMatrix, layoutChoice, colors, pointDilation) {
    /*
    fetch all data needed.  Includes:
      - the color by dataframe
      - the layout dataframe
      - the point dilation dataframe
    */
    const { metadataField: pointDilationAccessor } = pointDilation;

    const promises = [];
    // layout

    promises.push(annoMatrix.fetch("emb", layoutChoice.current));

    // color
    const query = this.createColorByQuery(colors);
    if (query) {
      promises.push(annoMatrix.fetch(...query));
    } else {
      promises.push(Promise.resolve(null));
    }

    // point highlighting
    if (pointDilationAccessor) {
      promises.push(annoMatrix.fetch("obs", pointDilationAccessor));
    } else {
      promises.push(Promise.resolve(null));
    }

    return Promise.all(promises);
  }

  fetchLidarCrossfilter() {
    const { lidarRadius, pointX, pointY, screenX, screenY } = this.state;
    const { crossfilter, layoutChoice } = this.props;

    const dummyPoint = this.mapScreenToPoint([
      screenX - (lidarRadius ?? 20),
      screenY,
    ]);
    const radius = Math.sqrt(
      (dummyPoint[0] - pointX) ** 2 + (dummyPoint[1] - pointY) ** 2
    );
    const selection = {
      mode: "within-lidar",
      center: [pointX, pointY],
      radius,
    };
    crossfilter.select("emb", layoutChoice.current, selection).then((cf) => {
      let count = 0;
      if (cf) {
        const dim =
          cf.obsCrossfilter.dimensions[
            `emb/${layoutChoice.current}_0:${layoutChoice.current}_1`
          ];
        if (!dim) {
          return;
        }
        const { ranges } = dim.selection;
        ranges.forEach((range) => {
          count += range[1] - range[0];
        });
      }
      this.setState((state) => {
        return { ...state, numCellsInLidar: count, lidarCrossfilter: cf };
      });

      const metadata = this.renderMetadata()
      this.setState((state) => {
        return { ...state, renderedMetadata: metadata };
      });

    });
  }

  brushToolUpdate(tool, container) {
    /*
    this is called from componentDidUpdate(), so be very careful using
    anything from this.state, which may be updated asynchronously.
    */
    const { currentSelection } = this.props;
    if (container) {
      const toolCurrentSelection = d3.brushSelection(container.node());

      if (currentSelection.mode === "within-rect") {
        /*
        if there is a selection, make sure the brush tool matches
        */
        const screenCoords = [
          this.mapPointToScreen(currentSelection.brushCoords.northwest),
          this.mapPointToScreen(currentSelection.brushCoords.southeast),
        ];
        if (!toolCurrentSelection) {
          /* tool is not selected, so just move the brush */
          container.call(tool.move, screenCoords);
        } else {
          /* there is an active selection and a brush - make sure they match */
          /* this just sums the difference of each dimension, of each point */
          let delta = 0;
          for (let x = 0; x < 2; x += 1) {
            for (let y = 0; y < 2; y += 1) {
              delta += Math.abs(
                screenCoords[x][y] - toolCurrentSelection[x][y]
              );
            }
          }
          if (delta > 0) {
            container.call(tool.move, screenCoords);
          }
        }
      } else if (toolCurrentSelection) {
        /* no selection, so clear the brush tool if it is set */
        container.call(tool.move, null);
      }
    }
  }

  lassoToolUpdate(tool) {
    /*
    this is called from componentDidUpdate(), so be very careful using
    anything from this.state, which may be updated asynchronously.
    */
    const { currentSelection } = this.props;
    if (currentSelection.mode === "within-polygon") {
      /*
      if there is a current selection, make sure the lasso tool matches
      */
      const polygon = currentSelection.polygon.map((p) =>
        this.mapPointToScreen(p)
      );
      tool.move(polygon);
    } else {
      tool.reset();
    }
  }

  selectionToolUpdate(tool, container) {
    /*
    this is called from componentDidUpdate(), so be very careful using
    anything from this.state, which may be updated asynchronously.
    */
    const { selectionTool } = this.props;
    switch (selectionTool) {
      case "brush":
        this.brushToolUpdate(tool, container);
        break;
      case "lasso":
        this.lassoToolUpdate(tool, container);
        break;
      default:
        /* punt? */
        break;
    }
  }

  mapScreenToPoint(pin) {
    /*
    Map an XY coordinates from screen domain to cell/point range,
    accounting for current pan/zoom camera.
    */

    const { camera, projectionTF, modelInvTF, viewport } = this.state;
    const cameraInvTF = camera.invView();

    /* screen -> gl */
    const x = (2 * pin[0]) / viewport.width - 1;
    const y = 2 * (1 - pin[1] / viewport.height) - 1;

    const xy = vec2.fromValues(x, y);
    const projectionInvTF = mat3.invert(mat3.create(), projectionTF);
    vec2.transformMat3(xy, xy, projectionInvTF);
    vec2.transformMat3(xy, xy, cameraInvTF);
    vec2.transformMat3(xy, xy, modelInvTF);
    return xy;
  }

  mapPointToScreen(xyCell) {
    /*
    Map an XY coordinate from cell/point domain to screen range.  Inverse
    of mapScreenToPoint()
    */

    const { camera, projectionTF, modelTF, viewport } = this.state;
    const cameraTF = camera.view();

    const xy = vec2.transformMat3(vec2.create(), xyCell, modelTF);
    vec2.transformMat3(xy, xy, cameraTF);
    vec2.transformMat3(xy, xy, projectionTF);

    return [
      Math.round(((xy[0] + 1) * viewport.width) / 2),
      Math.round(-((xy[1] + 1) / 2 - 1) * viewport.height),
    ];
  }

  renderCanvas = renderThrottle(() => {
    const {
      regl,
      drawPoints,
      colorBuffer,
      pointBuffer,
      flagBuffer,
      camera,
      projectionTF,
    } = this.state;
    this.renderPoints(
      regl,
      drawPoints,
      colorBuffer,
      pointBuffer,
      flagBuffer,
      camera,
      projectionTF
    );
  });

  updateReglAndRender(asyncProps, prevAsyncProps) {
    const { positions, colors, flags, height, width } = asyncProps;
    this.cachedAsyncProps = asyncProps;
    const { pointBuffer, colorBuffer, flagBuffer } = this.state;
    let needToRenderCanvas = false;

    if (height !== prevAsyncProps?.height || width !== prevAsyncProps?.width) {
      needToRenderCanvas = true;
    }
    if (positions !== prevAsyncProps?.positions) {
      pointBuffer({ data: positions, dimension: 2 });
      needToRenderCanvas = true;
    }
    if (colors !== prevAsyncProps?.colors) {
      colorBuffer({ data: colors, dimension: 3 });
      needToRenderCanvas = true;
    }
    if (flags !== prevAsyncProps?.flags) {
      flagBuffer({ data: flags, dimension: 1 });
      needToRenderCanvas = true;
    }
    if (needToRenderCanvas) this.renderCanvas();
  }

  updateColorTable(colors, colorDf) {
    const { annoMatrix } = this.props;
    const { schema } = annoMatrix;

    /* update color table state */
    if (!colors || !colorDf) {
      return createColorTable(
        null, // default mode
        null,
        null,
        schema,
        null
      );
    }

    const { colorAccessor, userColors, colorMode } = colors;
    return createColorTable(
      colorMode,
      colorAccessor,
      colorDf,
      schema,
      userColors
    );
  }

  createColorByQuery(colors) {
    const { annoMatrix, genesets } = this.props;
    const { schema } = annoMatrix;
    const { colorMode, colorAccessor } = colors;
    return createColorQuery(colorMode, colorAccessor, schema, genesets);
  }

  renderMetadata() {
    const { annoMatrix, colors } = this.props;
    const { colorState, lidarCrossfilter, numCellsInLidar } = this.state;
    if (colors.colorMode && colorState.colorDf) {
      const { colorDf: colorData, colorTable } = colorState;
      const { colorAccessor, colorMode } = colors;
      if (colorMode === "color by categorical metadata" && lidarCrossfilter) {
        const arr = new Array(annoMatrix.nObs);
        lidarCrossfilter.fillByIsSelected(arr, 1, 0);
        let df;
        try {
          df = colorData.withCol("New", arr);
        } catch (e) {
          return (
            <Card interactive elevation={Elevation.TWO}>
              {`Hovering over ${numCellsInLidar ?? 0} cells.`}
            </Card>
          );
        }

        const dfcol = df.col(colorAccessor);
        let els;
        let nums;
        if (dfcol) {
          const { categories, categoryCounts } = dfcol.summarizeCategorical();
          const groupBy = df.col("New");
          const occupancyMap = df
            .col(colorAccessor)
            .histogramCategorical(groupBy);
          const occupancy = occupancyMap.get(1);
          const colorDict = {};
          colorData
            .col(colorAccessor)
            .asArray()
            .forEach((val, index) => {
              colorDict[val] = colorTable.rgb[index];
            });
          if (occupancy) {
            els = [];
            nums = [];
            for (const key of categories) {
              if (occupancy.get(key)) {
                const c = colorDict[key];
                const color = c
                  ? `rgb(${c.map((x) => (x * 255).toFixed(0))})`
                  : "black";
                const num = occupancy.get(key, 0) ?? 0
                nums.push(parseInt(num))
                els.push(
                  <div
                    key={key}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      flexDirection: "row",
                    }}
                  >
                    <strong
                      style={{
                        color: `${color}`,
                      }}
                    >
                      {key?.toString()?.concat(" ")}
                    </strong>
                    <div style={{ paddingLeft: "10px" }}>
                      {`${num} / ${
                        categoryCounts.get(key) ?? 0
                      }`}
                    </div>
                  </div>
                );
              }
            }
            const dsu = (arr1, arr2) => arr1
                          .map((item, index) => [arr2[index], item]) 
                          .sort(([arg1], [arg2]) => arg2 - arg1) 
                          .map(([, item]) => item); 
            
            els = dsu(els, nums);

          }
        }

        return (
          <Card interactive elevation={Elevation.TWO}>
            {els ?? `No cells in range`}
          </Card>
        );
      }
      if (lidarCrossfilter) {
        const arr = new Array(annoMatrix.nObs);
        lidarCrossfilter.fillByIsSelected(arr, 1, 0);
        const col = colorData.col(colorData.colIndex.rindex[0]).asArray();
        const subsetArray = [];
        for (let i = 0; i < arr.length; i += 1) {
          if (arr[i]) {
            subsetArray.push(col[i]);
          }
        }
        let mean;
        let std;
        if (subsetArray.length > 0) {
          const n = subsetArray.length;
          mean = subsetArray.reduce((a, b) => a + b) / n;
          std = Math.sqrt(
            subsetArray.map((x) => (x - mean) ** 2).reduce((a, b) => a + b) / n
          );
        } else {
          mean = 0;
          std = 0;
        }
        return (
          <Card interactive elevation={Elevation.TWO}>
            <div style={{ paddingBottom: "10px" }}>
              <strong>{colorAccessor}</strong>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                flexDirection: "row",
              }}
            >
              <div>
                <strong>Mean</strong>
              </div>
              <div style={{ paddingLeft: "10px" }}>
                <strong>Std. Dev.</strong>
              </div>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                flexDirection: "row",
              }}
            >
              <div>{mean.toFixed(3)}</div>
              <div style={{ paddingLeft: "10px" }}>{std.toFixed(3)}</div>
            </div>
          </Card>
        );
      }
    }
    return (
      <Card interactive elevation={Elevation.TWO}>
        {`Hovering over ${numCellsInLidar ?? 0} cells.`}
      </Card>
    );
  }

  renderPoints(
    regl,
    drawPoints,
    colorBuffer,
    pointBuffer,
    flagBuffer,
    camera,
    projectionTF
  ) {
    const { annoMatrix } = this.props;
    if (!this.reglCanvas || !annoMatrix) return;

    const { schema } = annoMatrix;
    const cameraTF = camera.view();
    const projView = mat3.multiply(mat3.create(), projectionTF, cameraTF);
    const { width, height } = this.reglCanvas;
    regl.poll();
    regl.clear({
      depth: 1,
      color: [1, 1, 1, 1],
    });
    drawPoints({
      distance: camera.distance(),
      color: colorBuffer,
      position: pointBuffer,
      flag: flagBuffer,
      count: annoMatrix.nObs,
      projView,
      nPoints: schema.dataframe.nObs,
      minViewportDimension: Math.min(width, height),
    });
    regl._gl.flush();
  }

  render() {
    const {
      graphInteractionMode,
      annoMatrix,
      colors,
      layoutChoice,
      pointDilation,
      crossfilter,
      sankeyPlotMode
    } = this.props;
    const {
      modelTF,
      lidarFocused,
      screenX,
      screenY,
      projectionTF,
      camera,
      viewport,
      regl,
      lidarRadius,
      renderedMetadata
    } = this.state;

    const radius = lidarRadius ?? 20;
    const cameraTF = camera?.view()?.slice();
    return (
      <div
        id="graph-wrapper"
        style={{
          position: "relative",
          top: 0,
          left: 0,
          display: sankeyPlotMode ? "none" : "inherit",
        }}
        ref={this.myRef}
      >
        <GraphOverlayLayer
          width={viewport.width}
          height={viewport.height}
          cameraTF={cameraTF}
          modelTF={modelTF}
          projectionTF={projectionTF}
          handleCanvasEvent={
            graphInteractionMode === "zoom" ? this.handleCanvasEvent : undefined
          }
        >
          <CentroidLabels />
        </GraphOverlayLayer>
        <svg
          id="lasso-layer"
          data-testid="layout-overlay"
          className="graph-svg"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            zIndex: 1,
          }}
          width={viewport.width}
          height={viewport.height}
          pointerEvents={graphInteractionMode === "select" ? "auto" : "none"}
        />
        <Popover2
          placement="top-left"
          minimal
          content={renderedMetadata}
          isOpen={graphInteractionMode === "lidar" && lidarFocused}
        >
          <svg
            id="lidar-layer"
            className="graph-svg"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              zIndex: 2,
            }}
            width={viewport.width}
            height={viewport.height}
            pointerEvents={graphInteractionMode === "lidar" ? "auto" : "none"}
            onMouseDown={this.handleLidarEvent}
            onMouseUp={this.handleLidarEvent}
            onMouseMove={this.handleLidarEvent}
            onMouseLeave={this.handleLidarEvent}
            onDoubleClick={this.handleLidarEvent}
          />
        </Popover2>
        <canvas
          width={viewport.width}
          height={viewport.height}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            padding: 0,
            margin: 0,
            shapeRendering: "crispEdges",
          }}
          className="graph-canvas"
          data-testid="layout-graph"
          ref={this.setReglCanvas}
          onMouseDown={this.handleCanvasEvent}
          onMouseUp={this.handleCanvasEvent}
          onMouseMove={this.handleCanvasEvent}
          onDoubleClick={this.handleCanvasEvent}
          onWheel={this.handleCanvasEvent}
        />

        {graphInteractionMode === "lidar" && lidarFocused ? (
          <div
            style={{
              position: "absolute",
              left: `${screenX - radius}px`,
              top: `${screenY - radius}px`,
              width: `${radius * 2}px`,
              height: `${radius * 2}px`,
              borderColor: "black",
              borderWidth: "0.1px",
              borderStyle: "solid",
              borderRadius: "50%",
              paddingLeft: `${radius / 2}px`,
              paddingTop: `${radius / 2}px`,
            }}
          />
        ) : null}
        <Async
          watchFn={Graph.watchAsync}
          promiseFn={this.fetchAsyncProps}
          watchProps={{
            annoMatrix,
            colors,
            layoutChoice,
            pointDilation,
            crossfilter,
            viewport,
          }}
        >
          <Async.Pending initial>
            <StillLoading
              displayName={layoutChoice.current}
              width={viewport.width}
              height={viewport.height}
            />
          </Async.Pending>
          <Async.Rejected>
            {(error) => (
              <ErrorLoading
                displayName={layoutChoice.current}
                error={error}
                width={viewport.width}
                height={viewport.height}
              />
            )}
          </Async.Rejected>
          <Async.Fulfilled>
            {(asyncProps) => {
              if (regl && !shallowEqual(asyncProps, this.cachedAsyncProps)) {
                this.updateReglAndRender(asyncProps, this.cachedAsyncProps);
              }
              return null;
            }}
          </Async.Fulfilled>
        </Async>
      </div>
    );
  }
}

const ErrorLoading = ({ displayName, error, width, height }) => {
  console.log(error); // log to console as this is an unepected error
  return (
    <div
      style={{
        position: "fixed",
        fontWeight: 500,
        top: height / 2,
        left: globals.leftSidebarWidth + width / 2 - 50,
      }}
    >
      <span>{`Failure loading ${displayName}`}</span>
    </div>
  );
};

const StillLoading = ({ displayName, width, height }) => {
  /*
  Render a busy/loading indicator
  */
  return (
    <div
      style={{
        position: "fixed",
        fontWeight: 500,
        top: height / 2,
        width,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          justifyItems: "center",
          alignItems: "center",
        }}
      >
        <Button minimal loading intent="primary" />
        <span style={{ fontStyle: "italic" }}>Loading {displayName}</span>
      </div>
    </div>
  );
};

export default Graph;
