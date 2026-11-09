import type { Skin } from "../types";
import { OpenDuetFrame } from "./frame";
import { TASKS_SCREEN } from "./places";
import { TasksScreen } from "./tasks-screen";

export const openduet: Skin = {
  id: "openduet",
  name: "OpenDuet",
  description:
    "员工随时向你汇报进展，界面是一列手机形状的窄栏。",
  Frame: OpenDuetFrame,
  screens: { [TASKS_SCREEN]: TasksScreen },
};
