import uniq from "lodash.uniq";
import filter from "lodash.filter";

const Controls = (
  state = {
    // data loading flag
    loading: true,
    error: null,
    refresher: false,
    // all of the data + selection state
    userDefinedGenes: [],
    userDefinedGenesLoading: false,
    isSubsetted: false,
    resettingInterface: false,
    graphInteractionMode: "select",
    opacityForDeselectedCells: 0.2,
    scatterplotXXaccessor: null, // just easier to read
    scatterplotYYaccessor: null,
    graphRenderCounter: 0 /* integer as <Component key={graphRenderCounter} - a change in key forces a remount */,
    allGenes: null,
    datasetDrawer: false,
    userInfo: null,
    hostedMode: false
  },
  action
) => {
  /*
  For now, log anything looking like an error to the console.
  */
  if (action.error || /error/i.test(action.type)) {
    console.error(action.error);
  }

  switch (action.type) {
    case "initial data load start": {
      return { ...state, loading: true, isSubsetted: false, };
    }
    case "initial data load complete": {
      /* now fully loaded */
      return {
        ...state,
        loading: false,
        error: null,
        resettingInterface: false,
        isSubsetted: false,
        allGenes: action.allGenes ?? null
      };
    }
    case "init: set up websockets": {
      return {
        ...state,
        [action.name]: action.ws
      };
    }    
    case "reset subset": {
      return {
        ...state,
        resettingInterface: false,
        isSubsetted: false,
      };
    }
    case "subset to selection": {
      return {
        ...state,
        loading: false,
        error: null,
        isSubsetted: true,
      };
    }
    case "set user info": {
      return {
        ...state,
        userInfo: action.userInfo
      }
    }
    case "set hosted mode": {
      return {
        ...state,
        hostedMode: action.hostedMode
      }
    }    
    case "request user defined gene started": {
      return {
        ...state,
        userDefinedGenesLoading: true,
      };
    }
    case "request user defined gene error": {
      return {
        ...state,
        userDefinedGenesLoading: false,
      };
    }
    case "request user defined gene success": {
      const { userDefinedGenes } = state;
      const _userDefinedGenes = uniq(
        userDefinedGenes.concat(action.data.genes)
      );
      return {
        ...state,
        userDefinedGenes: _userDefinedGenes,
        userDefinedGenesLoading: false,
      };
    }
    case "clear user defined gene": {
      const { userDefinedGenes } = state;
      const newUserDefinedGenes = filter(
        userDefinedGenes,
        (d) => d !== action.data
      );
      return {
        ...state,
        userDefinedGenes: newUserDefinedGenes,
      };
    }
    case "initial data load error": {
      return {
        ...state,
        loading: false,
        error: action.error,
      };
    }
    case "app: refresh": {
      const { refresher } = state;
      return {
        ...state,
        refresher: !refresher,
        isSubsetted: false,
      }
    }
    /*******************************
             User Events
     *******************************/
    case "change graph interaction mode":
      return {
        ...state,
        graphInteractionMode: action.data,
      };
    case "change opacity deselected cells in 2d graph background":
      return {
        ...state,
        opacityForDeselectedCells: action.data,
      };
    case "increment graph render counter": {
      const c = state.graphRenderCounter + 1;
      return {
        ...state,
        graphRenderCounter: c,
      };
    }

    /*******************************
              Scatterplot
    *******************************/
    case "set scatterplot x":
      return {
        ...state,
        scatterplotXXaccessor: action.data,
      };
    case "set scatterplot y":
      return {
        ...state,
        scatterplotYYaccessor: action.data,
      };
    case "clear scatterplot":
      return {
        ...state,
        scatterplotXXaccessor: null,
        scatterplotYYaccessor: null,
      };

    /**************************
          Dataset Drawer
     **************************/
    case "toggle dataset drawer":
      return { ...state, datasetDrawer: !state.datasetDrawer };

    default:
      return state;
  }
};

export default Controls;
