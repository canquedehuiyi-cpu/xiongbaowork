import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { RegisteredDevice } from "@/lib/devices/queries";
import {
  ACP_RULE_DEFAULTS,
  type AcpHarness,
  type AcpRuleKey,
  type AcpRuleValue,
} from "../../../../shared/acp";
import { agentKeys } from "./queries";

/**
 * 从我的电脑招（外部员工，Task 10）：把用户电脑上已经装好的 Codex、Claude Code、Hermes（或在桌面端登记的
 * 本机智能体）招进来当员工。
 *
 * - 发现：`GET /api/devices/:deviceId/agents`，服务器当场问那台电脑，回 `{online, agents}`；电脑没连着时
 *   `online: false`。只回是否安装、能否接入、是否登录（是 / 否 / 未知）和版本号。
 * - 招聘：`POST /api/agents/external`，工作文件夹只传电脑上报的 `fld_…` 引用，本机智能体只传 `app_…`
 *   引用；路径和启动命令从不离开电脑。
 */

export type { AcpHarness, AcpRuleKey, AcpRuleValue };
export { ACP_RULE_DEFAULTS };

/** 发现能认出来的三家；`custom` 是桌面端登记的本机智能体，不在发现结果里。 */
export type DiscoveredHarness = Exclude<AcpHarness, "custom">;

export type DiscoveredAgent = {
  harness: DiscoveredHarness;
  version: string | null;
  installed: boolean;
  acpReady: boolean;
  /** null：读不出来，界面写「登录状态未知」（Hermes 是「模型待确认」），不写「未登录」。 */
  signedIn: boolean | null;
};

export type Discovery = { online: boolean; agents: DiscoveredAgent[] };

/** 卡片上的顺序，和设计稿一样。 */
export const DISCOVERED_HARNESSES: readonly DiscoveredHarness[] = [
  "codex",
  "claude-code",
  "hermes",
];

export const HARNESS_LABEL: Record<DiscoveredHarness, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  hermes: "Hermes",
};

/** 招聘设置里五项规则的顺序与说法（规格第 4 节）。 */
export const RULE_ROWS: readonly { key: AcpRuleKey; label: string }[] = [
  { key: "editInside", label: "改工作文件夹里的文件" },
  { key: "touchOutside", label: "动工作文件夹以外的文件" },
  { key: "runCommand", label: "运行命令" },
  { key: "network", label: "联网下载、装依赖" },
  { key: "push", label: "提交并推送代码" },
];

export const RULE_VALUE_LABEL: Record<AcpRuleValue, string> = {
  direct: "直接做",
  ask: "先问我",
  dangerous: "危险的才问我",
};

/** 一项规则能选哪些：只有「运行命令」多一个「危险的才问我」。 */
export function ruleChoices(key: AcpRuleKey): AcpRuleValue[] {
  return key === "runCommand"
    ? ["direct", "dangerous", "ask"]
    : ["direct", "ask"];
}

/** 卡片上的一个标签：绿色是好消息，琥珀色是要留意的。 */
export type AgentTag = { label: string; tone: "good" | "warn" };

/** 「已安装 / 已登录 / 模型待确认 / 登录状态未知」都由发现的字段算出来（规格第 2 节）。 */
export function agentTags(agent: DiscoveredAgent): AgentTag[] {
  if (!agent.installed) return [];
  const tags: AgentTag[] = [{ label: "已安装", tone: "good" }];
  if (agent.signedIn === true) tags.push({ label: "已登录", tone: "good" });
  else if (agent.signedIn === false)
    tags.push({ label: "未登录", tone: "warn" });
  // Hermes 没有登录这回事，用的是它自己配置的模型。
  else if (agent.harness === "hermes")
    tags.push({ label: "模型待确认", tone: "warn" });
  else tags.push({ label: "登录状态未知", tone: "warn" });
  if (!agent.acpReady) tags.push({ label: "还接不上", tone: "warn" });
  return tags;
}

/** 这台电脑能不能用来招：只有本人配对的电脑能招（规格第 1 节）。 */
export type DeviceStanding = "mine" | "unclaimed" | "others";

export function deviceStanding(
  device: Pick<RegisteredDevice, "pairedByUserId">,
  me: string | undefined,
): DeviceStanding {
  if (device.pairedByUserId === null || device.pairedByUserId === undefined)
    return "unclaimed";
  return me !== undefined && device.pairedByUserId === me ? "mine" : "others";
}

export const externalKeys = {
  all: ["external-agents"] as const,
  discovery: (deviceId: string) =>
    ["external-agents", "discovery", deviceId] as const,
};

export function discoveryQueryOptions(deviceId: string) {
  return queryOptions({
    queryKey: externalKeys.discovery(deviceId),
    queryFn: async (): Promise<Discovery> => {
      const response = await client(
        `/api/devices/${encodeURIComponent(deviceId)}/agents`,
        { fallback: "没能读到这台电脑上的智能体，请稍后再试。" },
      );
      const body = (await response.json()) as Partial<Discovery>;
      return {
        online: body.online === true,
        agents: Array.isArray(body.agents) ? body.agents : [],
      };
    },
    // 每次都要问那台电脑，所以不跟着窗口聚焦反复问；装好新的点「重新查找」。
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export type HireInput = {
  deviceId: string;
  harness: AcpHarness;
  name: string;
  department?: string;
  workdirRef: string;
  appRef?: string;
  rules: Record<AcpRuleKey, AcpRuleValue>;
  /** 只有 `custom`：用户确认知道它可能从不请求许可。 */
  acknowledgeNoPermission?: boolean;
};

export type HiredAgent = {
  id: string;
  name: string;
  title: string;
  department: string | null;
  type: "device_acp";
};

export function hireExternalMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: HireInput): Promise<HiredAgent> => {
      const response = await client("/api/agents/external", {
        method: "POST",
        body: input,
        fallback: "没能招进来，请稍后再试。",
      });
      return ((await response.json()) as { agent: HiredAgent }).agent;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentKeys.all }),
  });
}
