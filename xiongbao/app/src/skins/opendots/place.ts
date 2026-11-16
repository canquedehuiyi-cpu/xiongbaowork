import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { channelQueryOptions } from "@/lib/channels/queries";
import { appConfig } from "@/lib/generated/application-config";

/** Which part of OpenDots' sidebar a page belongs to, so the right row is lit. */
export type Section =
  | "chat"
  | "routines"
  | "memories"
  | "bots"
  | "capabilities"
  | "connections"
  | "tasks"
  | "autonomous"
  | "reachability"
  | "pipelines"
  | "other";

/**
 * What the frame needs to know about the page inside it: its name for the breadcrumbs, and the one
 * Bot it is about when it is about exactly one. Read from the URL and the caches the page itself
 * fills, so the frame never asks the server anything the page did not.
 */
export type Place = {
  section: Section;
  /** The page's name, the last breadcrumb. */
  label: string;
  /** A sub-page under the label, such as a Bot page's tab. */
  detail?: string;
  /** The single Bot this page is about, or undefined. */
  botId?: string;
  channelId?: string;
  /**
   * The page draws OpenBot's own Computer pane, opened by `?watch`. The frame's computer toggle
   * drives that pane rather than opening a second one beside it.
   */
  ownsWatch: boolean;
  watching: boolean;
  /** OpenBot's new-conversation page with its Bot already chosen: OpenDots' coworker home. */
  coworkerHome: boolean;
};

type Parsed = Omit<Place, "label" | "botId" | "watching" | "coworkerHome"> & {
  label: string | ((bot: string | undefined) => string);
  agentFromUrl?: string;
};

const BOT_TABS: Record<string, string> = {
  setup: "设置",
  access: "权限",
  activity: "动态",
  approvals: "审批",
  memory: "记忆",
  reach: "联系方式",
  responsibilities: "长期职责",
  routines: "定时任务",
  sharing: "共享",
};

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The page a pathname is, as OpenDots names its own views: a Bot's name for a chat with it,
 * "Activity" and "Memories" for its two workspace views, and OpenBot's own page names otherwise.
 */
export function parsePlace(
  pathname: string,
  search: { agent?: unknown },
): Parsed {
  const agent = typeof search.agent === "string" ? search.agent : undefined;
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") {
    return { section: "chat", label: "新对话", ownsWatch: false };
  }
  if (path === "/channel/new") {
    return {
      section: "chat",
      label: (bot) => bot ?? "新对话",
      agentFromUrl: agent,
      ownsWatch: false,
    };
  }
  const channel = path.match(/^\/(channel|group)\/([^/]+)$/);
  if (channel) {
    return {
      section: "chat",
      label: (bot) => bot ?? "对话",
      channelId: decodeURIComponent(channel[2]),
      ownsWatch: channel[1] === "channel",
    };
  }
  if (path === "/bot") {
    return {
      section: "chat",
      label: (bot) => bot ?? "对话",
      agentFromUrl: agent,
      ownsWatch: true,
    };
  }
  const bot = path.match(/^\/bots\/([^/]+)(?:\/([^/]+))?$/);
  if (bot) {
    return {
      section: "bots",
      label: (name) => name ?? "员工",
      detail: bot[2] ? (BOT_TABS[bot[2]] ?? bot[2]) : undefined,
      agentFromUrl: decodeURIComponent(bot[1]),
      ownsWatch: false,
    };
  }
  if (path === "/bots" || path === "/agents") {
    return { section: "bots", label: "全部员工", ownsWatch: false };
  }
  if (path === "/s/routines" || path === "/routines") {
    return { section: "routines", label: "定时任务", ownsWatch: false };
  }
  if (path === "/s/memories" || path === "/capabilities/memory") {
    return { section: "memories", label: "记忆", ownsWatch: false };
  }
  // WakerFlow 的详情页留在原地址，在导航里算作「能力」。
  if (under(path, "/capabilities") || under(path, "/wakerflows")) {
    return { section: "capabilities", label: "能力", ownsWatch: false };
  }
  if (under(path, "/connections")) {
    return { section: "connections", label: "连接", ownsWatch: false };
  }
  // 熊宝自己的工作面，各占主导航的一项。
  if (path === "/tasks") {
    return { section: "tasks", label: "任务看板", ownsWatch: false };
  }
  if (path === "/autonomous" || path === "/responsibilities") {
    return { section: "autonomous", label: "自主工作", ownsWatch: false };
  }
  if (path === "/reachability") {
    return { section: "reachability", label: "@Waker", ownsWatch: false };
  }
  if (path === "/pipelines") {
    return { section: "pipelines", label: "组团流程", ownsWatch: false };
  }
  return {
    section: "other",
    label: appConfig.brand.productName,
    ownsWatch: false,
  };
}

export function botName(
  agents: AgentProfile[] | undefined,
  id: string | undefined,
): string | undefined {
  if (!id) return undefined;
  return agents?.find((agent) => agent.id === id)?.name;
}

export function usePlace(): Place {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const agent = useRouterState({
    select: (state) => (state.location.search as { agent?: unknown }).agent,
  });
  const watch = useRouterState({
    select: (state) =>
      (state.location.search as { watch?: unknown }).watch === true,
  });
  const parsed = parsePlace(pathname, { agent });
  const agents = useQuery(agentListQueryOptions());
  // The page reads the same key, so this is the page's own fetch rather than a second one.
  const channel = useQuery({
    ...channelQueryOptions(parsed.channelId ?? ""),
    enabled: parsed.channelId !== undefined,
  });
  const channelBots = parsed.channelId ? channel.data?.agentIds : undefined;
  const botId =
    parsed.agentFromUrl ??
    (channelBots?.length === 1 ? channelBots[0] : undefined);
  const name =
    botName(agents.data, botId) ??
    (parsed.channelId ? channel.data?.name : undefined);
  return {
    section: parsed.section,
    label: typeof parsed.label === "string" ? parsed.label : parsed.label(name),
    detail: parsed.detail,
    botId,
    coworkerHome: pathname.replace(/\/+$/, "") === "/channel/new" && !!botId,
    channelId: parsed.channelId,
    ownsWatch: parsed.ownsWatch,
    watching: parsed.ownsWatch && watch,
  };
}
