/*
Color By UI state
*/

const ColorsReducer = (
  state = {
    colorMode: null /* by continuous, by expression */,
    colorAccessor: null /* tissue, Apod */,
    colorAccessor2: null,
    showJointExpr: false
  },
  action
) => {
  switch (action.type) {
    case "universe: user color load success": {
      const { userColors } = action;
      return {
        ...state,
        userColors,
      };
    }

    case "annotation: category edited": {
      const { colorAccessor } = state;
      if (action.metadataField !== colorAccessor) {
        return state;
      }
      /* else update colorAccessor */
      return {
        ...state,
        colorAccessor: action.newCategoryText,
        colorAccessor2: null,
      };
    }

    case "annotation: delete category": {
      const { colorAccessor } = state;
      if (action.metadataField !== colorAccessor) {
        return state;
      }
      /* else reset */
      return {
        ...state,
        colorMode: null,
        colorAccessor: null,
        colorAccessor2: null,
      };
    }

    case "reset colorscale": {
      return {
        ...state,
        colorMode: null,
        colorAccessor: null,
        colorAccessor2: null,
      };
    }
    case "color by categorical metadata":
    case "color by continuous metadata": {
      /* toggle between this mode and reset */
      const resetCurrent =
        action.type === state.colorMode &&
        action.colorAccessor === state.colorAccessor;
      const colorMode = !resetCurrent ? action.type : null;
      const colorAccessor = !resetCurrent ? action.colorAccessor : null;

      return {
        ...state,
        colorMode,
        colorAccessor,
        colorAccessor2: null
      };
    }

    case "color by expression": {
      /* toggle between this mode and reset */
      const { type, gene } = action;
      const resetCurrent = (type === state.colorMode && gene === state.colorAccessor);
      const resetCurrent2 = (type === state.colorMode && gene === state.colorAccessor2);
         
      
      let colorAccessor = state.colorAccessor;
      let colorMode = state.colorMode;
      let colorAccessor2 = state.colorAccessor2;

      if ((resetCurrent || resetCurrent2) && (colorAccessor && !colorAccessor2 || !colorAccessor && colorAccessor2)) {
        colorMode = null;
        colorAccessor = null;
        colorAccessor2 = null;
      } else if (resetCurrent && colorAccessor2) {
          colorAccessor = colorAccessor2;
          colorAccessor2 = null;
          colorMode = type;
      } else if (resetCurrent) {
        colorAccessor = null;
        colorMode = null;
      } else if (resetCurrent2) {
        colorAccessor2 = null;
      } else if (state.showJointExpr && colorAccessor) {
        colorAccessor2 = gene;
        colorMode = type;
      } else if (state.showJointExpr) {
        colorAccessor = gene;
        colorMode = type;
      } else {
        colorAccessor = gene;
        colorAccessor2 = null;
        colorMode = type;
      }
      return {
        ...state,
        colorMode,
        colorAccessor,
        colorAccessor2
      };
    }
    case "color by geneset mean expression": {
      /* toggle between this mode and reset */

      const resetCurrent =
        action.type === state.colorMode &&
        action.geneset === state.colorAccessor;
      
      const colorMode = !resetCurrent ? action.type : null;
      const colorAccessor = !resetCurrent ? action.geneset : null;
      return {
        ...state,
        colorMode,
        colorAccessor,
        colorAccessor2: null
      };
    }
    case "toggle joint expression": {
      return {
        ...state,
        colorAccessor2: null,
        showJointExpr: !state.showJointExpr
      }
    }
    default: {
      return state;
    }
  }
};

export default ColorsReducer;
