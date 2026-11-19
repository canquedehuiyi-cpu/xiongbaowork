import {
  mutationOptions,
  type QueryClient,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { client } from "@/lib/client";
import {
  devicesQueryOptions,
  type RegisteredDevice,
} from "@/lib/devices/queries";
import {
  ACP_CODEX_CLOUD_REFUSAL,
  ACP_RULE_DEFAULTS,
  type AcpHarness,
  type AcpRuleKey,
  type AcpRuleValue,
} from "../../../../shared/acp";
import { type AgentProfile, agentKeys, type ExternalRun } from "./queries";

/**
 * 招聘人读到的外部员工怎么跑（电脑、文件夹、规则）；不是外部员工、或者读的人不是招聘人（只读得到是哪
 * 一家）时是 undefined。
 */
export function hiredRun(
  agent: Pick<AgentProfile, "external"> | undefined,
): ExternalRun | undefined {
  const external = agent?.external;
  return external && "deviceId" in external ? external : undefined;
}

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

/** 它在哪里跑：自己的云电脑，还是招聘人配对的电脑（没写就是后者）。 */
export type AgentRuntime = "cloud" | "device";

export function runtimeOf(
  external: Pick<ExternalRun, "runtime"> | undefined,
): AgentRuntime {
  return external?.runtime === "cloud" ? "cloud" : "device";
}

/** 哪几家能在云电脑上跑：只有 Claude Code（云电脑里只预装了它）。 */
export function canRunInCloud(harness: AcpHarness): boolean {
  return harness === "claude-code";
}

/** Codex 选云电脑时服务器和界面说的同一句话。 */
export const LOCAL_ONLY_NOTE = ACP_CODEX_CLOUD_REFUSAL;

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

/**
 * 问到「电脑离线」后，隔这么久自动再问一次（只一次）：电脑短暂断开时，设备列表按心跳还说在线，
 * 发现结果却停在离线；它不轮询、聚焦也不重查，不再问就一直卡着。
 */
export const DISCOVERY_RETRY_MS = 10_000;

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

export type HireInput =
  | {
      deviceId: string;
      harness: AcpHarness;
      name: string;
      department?: string;
      workdirRef: string;
      appRef?: string;
      rules: Record<AcpRuleKey, AcpRuleValue>;
      /** 只有 `custom`：用户确认知道它可能从不请求许可。 */
      acknowledgeNoPermission?: boolean;
      /** 写出来的 `device` 和不写一样：在招聘人配对的电脑上跑。 */
      runtime?: "device";
    }
  | {
      /** 在它自己的云电脑上跑（只有 Claude Code）：不选电脑和文件夹。 */
      runtime: "cloud";
      harness: AcpHarness;
      name: string;
      department?: string;
      rules: Record<AcpRuleKey, AcpRuleValue>;
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

/*
 * 招进来以后（外部员工 Task 11）：外部员工在通讯录、名片、对话顶栏、消息列表上怎么认出来、在哪台电脑上、
 * 电脑离线时排着几件活；以及招聘设置的编辑态（`PATCH /api/agents/external/:id`）。员工自己怎么跑从员工
 * 资料的 `external` 读（只有招聘人读得到），电脑名从「我的电脑」列表读。
 */

/** 外部员工用的是哪一家：三家照名字；本机智能体用电脑上登记的名字，读不到时写「本机智能体」。 */
export function externalHarnessName(
  external: { harness: AcpHarness; appRef?: string },
  device?: Pick<RegisteredDevice, "apps">,
): string {
  if (external.harness !== "custom") return HARNESS_LABEL[external.harness];
  return (
    device?.apps?.find((app) => app.ref === external.appRef)?.name ??
    "本机智能体"
  );
}

/** 标记文案「外部员工 · Codex」（Global Constraints）。 */
export function externalMark(
  external: { harness: AcpHarness; appRef?: string },
  device?: Pick<RegisteredDevice, "apps">,
): string {
  return `外部员工 · ${externalHarnessName(external, device)}`;
}

/** 工作文件夹在那台电脑上叫什么；电脑不再共享它时读不到，是 null。 */
export function externalWorkdirName(
  external: Pick<ExternalRun, "workdirRef">,
  device?: Pick<RegisteredDevice, "roots">,
): string | null {
  return (
    device?.roots?.find((root) => root.ref === external.workdirRef)?.name ??
    null
  );
}

/**
 * 「本机智能体」可能从不请求许可（规格第 4 节第 139 行）：这时熊宝拦不住它的动作，名片上要写明。服务器
 * 分不出它到底会不会问，所以每个本机智能体都写。
 */
export function mayNeverAsk(external: Pick<ExternalRun, "harness">): boolean {
  return external.harness === "custom";
}

/**
 * 能不能交给它没人在场的活（例行任务、长期职责、主动巡检、定时唤醒）：外部员工这一步不行，那些活没人在场
 * 批它的许可请求，服务器对它一律 409（规格「不做」第 53 行），所以这些入口对它不显示。
 */
export function takesUnattendedWork(
  agent: Pick<AgentProfile, "external">,
): boolean {
  return !agent.external;
}

/** 和服务器拒绝时说的同一句话（`EXTERNAL_UNATTENDED_REFUSAL`）。 */
export const EXTERNAL_UNATTENDED_NOTE =
  "外部员工现在只接有人发起的活（单聊、群里 @、别人转给它），例行任务、职责、主动工作和定时唤醒还不能交给它。";

/** 对话顶栏的副标题：「状态 · 此刻 · 在 <电脑名> 上」，哪一段没有就省掉那一段，不留空的「·」。 */
export function externalSubtitle(
  summary: string,
  deviceName: string | undefined,
): string {
  return [
    summary.trim(),
    deviceName?.trim() ? `在 ${deviceName.trim()} 上` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const NO_DEVICES: ReadonlyMap<string, RegisteredDevice> = new Map();

/**
 * 这些员工里外部员工所在的电脑，按 `deviceId` 查。没有外部员工时不去读电脑列表；读不到时是空的，调用的人
 * 就不写电脑名，不编。
 */
export function useExternalDevices(
  agents: readonly (Pick<AgentProfile, "external"> | undefined)[],
): ReadonlyMap<string, RegisteredDevice> {
  const any = agents.some((agent) => hiredRun(agent));
  const devices = useQuery({ ...devicesQueryOptions(), enabled: any });
  const rows = any && !devices.isError ? devices.data : undefined;
  return useMemo(
    () =>
      Array.isArray(rows)
        ? new Map(rows.map((device) => [device.deviceId, device]))
        : NO_DEVICES,
    [rows],
  );
}

/** 一位外部员工所在的那台电脑；不是外部员工、或者读不到时是 undefined。 */
export function useExternalDevice(
  agent: Pick<AgentProfile, "external"> | undefined,
): RegisteredDevice | undefined {
  const devices = useExternalDevices([agent]);
  const run = hiredRun(agent);
  return run ? devices.get(run.deviceId) : undefined;
}

export type ExternalEdit = {
  name?: string;
  department?: string;
  /** 换运行位置（只有 Claude Code）：云电脑 / 本机；换到本机要同时给电脑和工作文件夹。 */
  runtime?: AgentRuntime;
  deviceId?: string;
  workdirRef?: string;
  appRef?: string;
  rules?: Record<AcpRuleKey, AcpRuleValue>;
};

/** 招聘设置的编辑态：改名字、部门、电脑、工作文件夹、本机智能体和五项规则（换不了是哪一家）。 */
export function updateExternalMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async ({
      agentId,
      input,
    }: {
      agentId: string;
      input: ExternalEdit;
    }): Promise<HiredAgent> => {
      const response = await client(
        `/api/agents/external/${encodeURIComponent(agentId)}`,
        { method: "PATCH", body: input, fallback: "没能保存，请再试一次。" },
      );
      return ((await response.json()) as { agent: HiredAgent }).agent;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentKeys.all }),
  });
}
