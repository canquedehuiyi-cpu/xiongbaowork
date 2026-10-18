/**
 * What a person reads a component as, which is not what it is registered as.
 *
 * The registry title travels with the component: the server's headless registry holds the same
 * title for the same name, and the model is told about components by that registry. Translating it
 * there would make the two disagree. So the screens that list components draw this name instead,
 * keyed by the component's `name`, and anything not in here — a component written in the
 * playground, or one a later build adds — is shown with the title it came with.
 */
const DISPLAY_TITLES: Record<string, string> = {
  askApproval: "审批",
  askChoice: "选择",
  askForm: "表单",
  showActivityReport: "活动报告",
  showAreaChart: "面积图",
  showBarChart: "柱状图",
  showChecklist: "清单",
  showLineChart: "折线图",
  showMetrics: "关键数据",
  showNotice: "提示",
  showPieChart: "环形图",
  showProgress: "目标进度",
  showQuote: "引用",
  showRecord: "记录",
  showTable: "数据表格",
};

export function componentDisplayTitle(component: {
  name: string;
  title: string;
}): string {
  return DISPLAY_TITLES[component.name] ?? component.title;
}
