import type { CopilotChatSuggestionViewProps } from "@copilotkit/react-core/v2";

type StarterSuggestion = CopilotChatSuggestionViewProps["suggestions"][number];

/** Draws editable controls, so it needs generated interfaces switched on for this installation. */
export const INTERACTIVE_STARTER: StarterSuggestion = {
  title: "做一份出行预算",
  message:
    "在这段对话里做一份可交互的周末出行预算。先填交通 100 元、住宿 200 元、餐饮 80 元。让我能修改每一项费用，并立刻看到总额更新。用清楚标明的示例金额，不要用实时价格。",
  isLoading: false,
};

/**
 * A tour of what a Bot does best: search with a chart, its own computer, a connected app, and an
 * interface it draws. Starter requests are ordinary user messages, never Bot instructions or
 * generated suggestions.
 */
export const STARTER_SUGGESTIONS: CopilotChatSuggestionViewProps["suggestions"] =
  [
    {
      title: "把 Hacker News 做成图表",
      message:
        "用网页搜索找出 Hacker News 首页现在排名前 10 的文章。按得分给我画一张柱状图，再列出每篇的得分和链接。",
      isLoading: false,
    },
    {
      title: "用 Google 地图查路线",
      message:
        "用你的浏览器打开 Google 地图，查一下大英博物馆周六的开放时间。再查从国王十字车站步行过去的路线，一步一步列出来，并告诉我几点出发能在开门时到达。不要登录，也不要改动任何东西。",
      isLoading: false,
    },
    {
      title: "整理我的收件箱",
      message:
        "用 Gmail 读一下我过去 24 小时的邮件，告诉我最需要我处理的 2 封以及原因。不要把任何邮件标为已读，也不要改动任何东西。如果 Gmail 还没连接，先在这里帮我连接，然后继续这个请求。",
      isLoading: false,
    },
    INTERACTIVE_STARTER,
  ];

export type StarterTourState = {
  starterTourChannelId?: string;
};

/** Before a conversation exists, offer the unclaimed tour. Afterwards, only its saved conversation. */
export function showStarterTour(
  state: StarterTourState,
  channelId?: string,
): boolean {
  return channelId
    ? state.starterTourChannelId === channelId
    : state.starterTourChannelId === undefined;
}
