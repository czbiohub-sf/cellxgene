import React from "react";
import { connect } from "react-redux";
import {
  Button,
  Menu,
  MenuItem,
  Popover,
  Position,
  Tooltip,
  Icon,
  PopoverInteractionKind,
  Intent,
} from "@blueprintjs/core";
import { IconNames } from "@blueprintjs/icons";

import * as globals from "../../../globals";
import actions from "../../../actions";

@connect((state) => ({
  annotations: state.annotations,
  userLoggedIn: state.controls.userInfo ? true : false
}))
class AnnoMenuCategory extends React.PureComponent {
  constructor(props) {
    super(props);
    this.state = {};
  }

  activateAddNewLabelMode = () => {
    const { dispatch, metadataField } = this.props;
    dispatch({
      type: "annotation: activate add new label mode",
      data: metadataField,
    });
  };

  activateEditCategoryMode = () => {
    const { dispatch, metadataField } = this.props;

    dispatch({
      type: "annotation: activate category edit mode",
      data: metadataField,
    });
  };

  handleDeleteCategory = () => {
    const { dispatch, metadataField } = this.props;
    dispatch(actions.annotationDeleteCategoryAction(metadataField));
  };

  render() {
    const {
      metadataField,
      annotations,
      isUserAnno,
      createText,
      editText,
      deleteText,
      disableDelete,
      toggleText,
      disableToggle,
      histToggler,
      removeHistZeros,
      userLoggedIn
    } = this.props;

    return (
      <>
        {isUserAnno ? (
          <>
            <Tooltip
              content={createText}
              position="bottom"
              hoverOpenDelay={globals.tooltipHoverOpenDelay}
            >
              <Button
                style={{ marginLeft: 0, marginRight: 2 }}
                data-testclass="handleAddNewLabelToCategory"
                data-testid={`${metadataField}:add-new-label-to-category`}
                icon={<Icon icon="plus" iconSize={10} />}
                onClick={this.activateAddNewLabelMode}
                small
                minimal
              />
            </Tooltip>
            <Popover
              interactionKind={PopoverInteractionKind.HOVER}
              boundary="window"
              position={Position.RIGHT_TOP}
              content={
                <Menu>
                  <MenuItem
                    icon="edit"
                    disabled={!userLoggedIn || annotations.isEditingCategoryName}
                    data-testclass="activateEditCategoryMode"
                    data-testid={`${metadataField}:edit-category-mode`}
                    onClick={this.activateEditCategoryMode}
                    text={editText}
                  />
                  <MenuItem
                    icon={"vertical-bar-chart-desc"}
                    data-testclass="handleToggleHistZeros"
                    data-testid={`${metadataField}:toggle-hist-zeros`}
                    onClick={histToggler}
                    text={toggleText}
                    disabled={disableToggle}
                    active={removeHistZeros}
                  />                     
                  <MenuItem
                    icon={IconNames.TRASH}
                    intent={Intent.DANGER}
                    data-testclass="handleDeleteCategory"
                    data-testid={`${metadataField}:delete-category`}
                    onClick={this.handleDeleteCategory}
                    text={deleteText}
                    disabled={(disableDelete ?? false )|| !userLoggedIn}
                  />               
                </Menu>
              }
            >
              <Button
                style={{ marginLeft: 0, marginRight: 5 }}
                data-testclass="seeActions"
                data-testid={`${metadataField}:see-actions`}
                icon={<Icon icon="more" iconSize={10} />}
                small
                minimal
              />
            </Popover>
          </>
        ) : null}
      </>
    );
  }
}

export default AnnoMenuCategory;
