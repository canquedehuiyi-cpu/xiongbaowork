import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  STAFFING_TOOL_NAMES,
  type StaffingProposalCard,
  writeStaffingProposalAnswer,
} from "../../../shared/staffing-proposal";
import { canManageAgent, canRunAgent } from "../agents/profile-policy";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import { parseAgentInput } from "../agents/routes";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { GroupStore } from "../channels/group";
import { cutAtCodeUnits } from "../channels/text";
import type { Database } from "../db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  pluginGrants,
  staffingProposals,
} from "../db/schema";
import type { ModelShelf } from "../models/routes";
import type { RoleTemplateStore } from "../roles/store";
import type { RoutineStore } from "../routines/store";
import { type DroppedItem, parseDraft } from "../staffing/draft";
import {
  currentEmployeeVersion,
  currentGroupVersion,
  inputRefusal,
} from "../staffing/executor";
import {
  ProposalLimitError,
  type StaffingProposalStore,
} from "../staffing/store";
import type {
  EmployeeChangeDraft,
  EmployeeDraft,
  GroupChangeDraft,
  GroupDraft,
  Proposal,
  ProposalDraft,
  ProposalKind,
  ResultItem,
} from "../staffing/types";
import { capabilityFor } from "../tenant/context";
import type { AppDirectory } from "./app-access-store";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";
import { ownerAppsAllowed } from "./owner-grants";
import type { PluginStore } from "./store";

/**
 * 「招聘与组群」的内置服务：员工替本人起草新员工、员工改动和群聊的提议，形状照 `builtin-routines.ts`。
 *
 * 这里只起草，从不建员工、建群或授予任何东西：`propose_*` 只往提议表写一行草稿，卡片出现在对话里，本人
 * 登录后在卡片上确认，`/api/proposals/:id/apply` 才以本人的身份执行（`staffing/executor.ts`）。所以这组工具
 * 在目录里全是读，不走「改动之前先问」：卡片上的确认就是那一问。
 *
 * 主人取 `connection.actorId`、起草的员工取 `connection.botId`、会话取 `connection.threadId`，从不读参数：
 * 能在参数里写主人的模型，就能替别人起草，提议会出现在别人的卡片上。
 *
 * 起草时就照执行时的规则查一遍（模型、技能、应用、群成员、群发起人、改动对象的版本），不合格的项剔除并告诉
 * 模型，免得本人点了确认才看到失败。执行时还会再查一遍，这里不是那道门。
 *
 * 帧：全部在这次运行已有的租户帧里读写，不开帧、不出帧。
 */

/** 这组工具要用到的东西。在 `index.ts` 建好仓库的地方交给本模块一次（同 `useRoutineTools`）。 */
export type StaffingToolDeps = {
  database: Database;
  proposals: StaffingProposalStore;
  profiles: Pick<AgentProfileStore, "list" | "get">;
  plugins: Pick<
    PluginStore,
    | "listSkills"
    | "skillOwner"
    | "isInstallListed"
    | "inspectApp"
    | "giveableApps"
    // `inspectApp` 读员工已持有的授予时经 `this` 调它。
    | "listForAgent"
  >;
  composioConfigured: boolean;
  directory?: AppDirectory;
  routines: Pick<RoutineStore, "listFor">;
  groups: { store: Pick<GroupStore, "order" | "bots" | "people"> };
  /** 员工的模型选择器列的同一份：本人模型库里启用的，和套餐能用的平台体验模型。 */
  catalogue: ModelShelf;
  roleTemplates: Pick<RoleTemplateStore, "list" | "official">;
  auditStore: AuditStore;
};

let installed: StaffingToolDeps | null = null;

/**
 * 把依赖交给本模块，一次。和 `useRoutineTools` 同一个理由：`transportFor` 把种类解析成模块，导入时就建好
 * 注册表，那时还没有数据库，没有别的接缝。`null` 让测试能把装进去的再拿出来。
 */
export function useStaffingTools(deps: StaffingToolDeps | null): void {
  installed = deps;
}

/** 同一人在同一段对话里，这么长时间内最多新建这么多份提议（按提议表的 `created_at` 数，不在内存里记）。 */
const BURST_WINDOW_MS = 10 * 60 * 1000;
const BURST_LIMIT = 5;
const MISSING_ROLES_MAX = 10;
const LIST_MAX = 50;

/**
 * 每个工具说明里都带的规则（规格第 7 节「小管家怎么说话」）。模型只读得到工具说明，所以规则写在这里，
 * 不指望它记得别处的提示词。
 */
const SPEAKING_RULES = [
  "怎么做：",
  "- 先用 list_staff 看现有的员工、群聊和角色模板；有合适的模板就基于它起草，并告诉用户用了哪个模板。",
  "- 缺关键信息最多追问用户一轮，其余用合理的默认值。",
  "- 一次只出一份提议。用户口头要求改草稿时，请用户作废旧卡片，再起草一份新的。",
  "- 卡片出现后用一两句话说明为什么这么拟；用户确认之后，用 proposal_status 读结果再接着说。",
  "- 永远不要说「已经建好了」「已经改好了」，除非 proposal_status 答的是已执行完（applied）。",
].join("\n");

/**
 * 新员工与员工改动共用的字段说明。员工靠职责描述和人设干活。单独的工作指令（`instructions`）只有个人起步
 * 员工有（`profile-types.ts`），别的员工会忽略它，所以只在改动里提供，见 {@link CHANGE_FIELDS}。
 */
const EMPLOYEE_FIELDS: Record<string, unknown> = {
  name: { type: "string", description: "名字，最多 80 字。" },
  title: { type: "string", description: "头衔，最多 120 字。" },
  roleDescription: {
    type: "string",
    description:
      "职责描述，1 到 1000 字。员工就按这段话干活：把它该做什么、怎么做、做到什么程度写在这里。",
  },
  persona: {
    type: "object",
    description:
      "人设与说话风格，每部分最多 2000 字：tone（语气）、principles（原则）、habits（习惯）。员工的行为写在职责描述和人设里。",
    properties: {
      tone: { type: "string" },
      principles: { type: "string" },
      habits: { type: "string" },
    },
  },
  bible: { type: "string", description: "可选的长篇工作手册，最多 8000 字。" },
  avatar: {
    type: "object",
    description:
      "头像：{ preset: naughty | cute | cool | happy | sweet } 或 { seed: 文字 }。",
  },
  model: {
    type: "object",
    description:
      "模型，二选一：{ modelRef: 模型库 id } 或 { platformModelRef: 平台体验模型 id }，取自 list_staff。不给就用部署默认的模型。",
  },
  skills: {
    type: "array",
    items: { type: "string" },
    description: "技能 slug，取自 list_staff 的「可装的技能」。",
  },
  apps: {
    type: "array",
    description:
      "要给员工的应用：[{ app: 应用的键或名字, actions: [动作名] }]；actions 留空就是能给的全部只读动作。",
    items: {
      type: "object",
      properties: {
        app: { type: "string" },
        actions: { type: "array", items: { type: "string" } },
      },
      required: ["app"],
    },
  },
  routines: {
    type: "array",
    description:
      "定时任务：[{ title?, instruction, cron, timezone? }]。instruction 写成一次触发要做的事，最多 2000 字；cron 五段，间隔至少 15 分钟；timezone 用 IANA 名字。",
    items: {
      type: "object",
      properties: {
        title: { type: "string" },
        instruction: { type: "string" },
        cron: { type: "string" },
        timezone: { type: "string" },
      },
      required: ["instruction", "cron"],
    },
  },
  visibility: {
    type: "string",
    enum: ["private", "public"],
    description:
      "可见范围，缺省 private。只有用户明确要公开给团队时才写 public。",
  },
};

/** 改员工时多一项：个人起步员工的工作指令。别的员工没有单独的指令，起草时剔除并说明。 */
const CHANGE_FIELDS: Record<string, unknown> = {
  ...EMPLOYEE_FIELDS,
  instructions: {
    type: "string",
    description:
      "只对个人起步员工有效的工作指令，最多 1000 字。别的员工按职责描述工作，没有单独的指令：给了也会被剔除，请改 roleDescription。",
  },
};

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "list_staff",
    description: [
      "列出正在和你说话的这个人能用的员工、他发起的群聊（成员与回答顺序）、角色模板、能选的模型、能装的技能、",
      "以及他能直接给员工的应用。起草任何提议之前先调它，提议里的 id 都从这里取。",
      "",
      SPEAKING_RULES,
    ].join("\n"),
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "propose_employee",
    description: [
      "替这个人起草一位新员工。只是起草：对话里会出现一张卡片，这个人在卡片上确认之后才真正建好。",
      "",
      "员工靠 roleDescription（职责描述）和 persona（人设）干活：把它的工作内容、做事方式和说话风格写进这两项；",
      "新员工没有单独的工作指令，更长的规范写进 bible（工作手册）。",
      "有合适的角色模板时，传 roleTemplate: { id, version }（取自 list_staff 的「你的角色模板」），并照模板写各字段；",
      "官方模板只能照着写，不能作为 roleTemplate 传。",
      "模型、技能、应用里无效的项会被剔除，结果里会写明剔除了什么、为什么。",
      "新员工默认私有；默认不给它「招聘与组群」能力，用户明确要时才传 staffingTools: true。",
      "主人与起草的员工取自这次运行，没有对应的参数。",
      "",
      SPEAKING_RULES,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        ...EMPLOYEE_FIELDS,
        roleTemplate: {
          type: "object",
          description: "{ id, version }，取自 list_staff 的「你的角色模板」。",
          properties: {
            id: { type: "string" },
            version: { type: "integer" },
          },
        },
        staffingTools: {
          type: "boolean",
          description: "新员工是否也得到「招聘与组群」能力，缺省 false。",
        },
      },
      required: ["name", "roleDescription"],
    },
  },
  {
    name: "propose_employee_change",
    description: [
      "替这个人起草对一位已有员工的修改。只是起草：这个人在卡片上确认之后才真正改。",
      "",
      "agentId 取自 list_staff，只能是这个人能修改的员工。set 里只放要改的字段，规则同 propose_employee；",
      "要改员工的工作方式，改 roleDescription 和 persona。appsRemove 收回应用，routinesRemove 删除这位员工的定时任务（id）。",
      "",
      SPEAKING_RULES,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "员工的 id，取自 list_staff。",
        },
        set: {
          type: "object",
          description: "只含要改的字段。",
          properties: CHANGE_FIELDS,
        },
        appsRemove: {
          type: "array",
          description: "要收回的应用：[{ app, actions: [] }]。",
          items: {
            type: "object",
            properties: {
              app: { type: "string" },
              actions: { type: "array", items: { type: "string" } },
            },
            required: ["app"],
          },
        },
        routinesRemove: {
          type: "array",
          items: { type: "string" },
          description: "要删除的定时任务 id。",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "propose_group",
    description: [
      "替这个人起草一个新群聊。只是起草：这个人在卡片上确认之后才真正建好。",
      "",
      "members 是已有员工的 id，按回答顺序排，2 到 20 位，都必须是这个人能用的员工（取自 list_staff）。",
      "需求里有对不上的角色（现有员工里没有合适的），写进 missingRoles，然后问用户要不要先招。",
      "",
      SPEAKING_RULES,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "群名，最多 80 字。" },
        members: {
          type: "array",
          items: { type: "string" },
          description: "员工 id，按回答顺序。",
        },
        missingRoles: {
          type: "array",
          items: { type: "string" },
          description: "需求里有、但现有员工里对不上的角色，例如「设计师」。",
        },
      },
      required: ["name", "members"],
    },
  },
  {
    name: "propose_group_change",
    description: [
      "替这个人起草对一个已有群聊的调整：加员工、移员工、改回答顺序、改名，任意组合。只是起草：这个人在卡片上",
      "确认之后才真正改。只有群的发起人能调整；channelId 取自 list_staff 的「你发起的群聊」。",
      "order 给出时必须正好包含调整之后群里的每一位员工；群里至少留 2 位。",
      "",
      SPEAKING_RULES,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "群聊的 id。" },
        name: { type: "string", description: "新的群名。" },
        add: { type: "array", items: { type: "string" } },
        remove: { type: "array", items: { type: "string" } },
        order: {
          type: "array",
          items: { type: "string" },
          description: "调整之后的回答顺序。",
        },
      },
      required: ["channelId"],
    },
  },
  {
    name: "proposal_status",
    description: [
      "读一份提议现在的状态与逐项执行结果。只读得到这个人自己的提议。",
      "用户说确认了、或者问结果时调它；只有答「已执行完」时才能说建好了、改好了。",
      "",
      SPEAKING_RULES,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        proposalId: { type: "string", description: "提议的 id。" },
      },
      required: ["proposalId"],
    },
  },
]);

/** 清单是本文件里的常量：不需要凭据、不需要仓库，也不看是谁在问（同 `builtin-routines.listTools`）。 */
export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

export const listNeedsCredential = false;

/** 清单就是本文件，所以每次启动都把保存的那份刷新到当前版本。 */
export const listIsThisCode = true;

type Connection = {
  url: string;
  token?: string;
  actorId?: string;
  botId?: string;
  threadId?: string;
};

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

function asResult(text: string): McpCallResult {
  if (text.length <= MAX_RESULT_CHARS)
    return { text, isError: false, truncated: false };
  return {
    text: `${cutAtCodeUnits(text, MAX_RESULT_CHARS)}\n\n[结果太长，已截断：原文 ${text.length} 个字符]`,
    isError: false,
    truncated: true,
  };
}

/** 起草被拒：原因是给模型看、也可能转述给用户的中文。 */
class DraftRefused extends Error {}

/** 这次运行是谁、哪位员工、哪段对话。 */
type Run = {
  deps: StaffingToolDeps;
  ownerId: string;
  botId: string;
  threadId: string | null;
  /** 本人此刻的样子：只有这次运行确实持有管理员能力才是管理员，与执行器同一个判断。 */
  actor: AgentActor;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KIND_WORDS: Record<ProposalKind, string> = {
  employee: "新员工",
  employee_change: "员工改动",
  group: "新群聊",
  group_change: "群聊调整",
};

/**
 * 调用一个工具。拒绝与意外都作为 `isError` 结果返回、不抛出（同其他传输层）；主人、员工、会话只取自连接。
 */
export async function callTool(
  connection: Connection,
  toolName: string,
  args: unknown,
): Promise<McpCallResult> {
  const ownerId = connection.actorId?.trim();
  if (!ownerId)
    return failure(
      "提议要记在一个人名下，可这次运行没有归属到任何人，所以没有起草。",
    );
  const botId = connection.botId?.trim();
  if (!botId)
    return failure("提议要由一位员工起草，可这次运行没有说是哪位员工。");
  const deps = installed;
  if (!deps) return failure("这个部署没有接上「招聘与组群」。");
  if (!(STAFFING_TOOL_NAMES as readonly string[]).includes(toolName))
    return failure(`「招聘与组群」里没有叫 ${toolName} 的工具。`);
  const run: Run = {
    deps,
    ownerId,
    botId,
    threadId: connection.threadId?.trim() || null,
    actor: {
      id: ownerId,
      role: capabilityFor(ownerId) === "admin" ? "admin" : "user",
    },
  };
  const given =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  try {
    if (toolName === "list_staff") return asResult(await listStaff(run));
    if (toolName === "proposal_status")
      return await proposalStatus(run, given.proposalId);
    return await propose(run, toolName.slice("propose_".length), given);
  } catch (error) {
    if (error instanceof DraftRefused || error instanceof ProposalLimitError)
      return failure(error.message);
    console.error(
      JSON.stringify({
        type: "staffing-tool-failed",
        tool: toolName,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return failure("出了点问题，这次没有做成，可以稍后再试。");
  }
}

// ---------------------------------------------------------------------------------------------------
// list_staff

async function listStaff(run: Run): Promise<string> {
  const { deps } = run;
  const lines: string[] = [];

  lines.push("你能用的员工：");
  const staff = (await deps.profiles.list(run.actor)).filter((profile) =>
    canRunAgent(run.actor, profile),
  );
  listed(lines, staff, "还没有", (profile) => {
    const template = profile.roleTemplate
      ? `；角色模板 ${profile.roleTemplate.id}（版本 ${profile.roleTemplate.version}）`
      : "";
    const mine = canManageAgent(run.actor, profile) ? "；你能修改" : "";
    return `${oneLine(profile.name, NAME_CHARS)}（id: ${profile.id}）头衔：${oneLine(profile.title, NAME_CHARS) || "无"}；职责：${short(profile.roleDescription)}${template}${mine}`;
  });

  lines.push("", "你发起的群聊：");
  listed(
    lines,
    await groupsStartedBy(run),
    "还没有",
    (group) =>
      `${oneLine(group.name, NAME_CHARS)}（id: ${group.id}）回答顺序：${group.order.join(" → ")}`,
  );

  lines.push("", "你的角色模板（可以作为 roleTemplate 传）：");
  listed(
    lines,
    await deps.roleTemplates.list(),
    "还没有",
    (template) =>
      `${oneLine(template.name, NAME_CHARS)}（id: ${template.id}，版本 ${template.version}）头衔：${oneLine(template.profile.identity.title, NAME_CHARS) || "无"}；职责：${short(template.profile.identity.roleDescription)}`,
  );
  const official = deps.roleTemplates.official();
  if (official.length > 0) {
    lines.push("官方模板（只能照着写各字段，不能作为 roleTemplate 传）：");
    listed(
      lines,
      official,
      "没有",
      (template) =>
        `${oneLine(template.name, NAME_CHARS)} 头衔：${oneLine(template.profile.identity.title, NAME_CHARS) || "无"}；职责：${short(template.profile.identity.roleDescription)}`,
    );
  }

  lines.push("", "能选的模型（model 二选一；不选就用部署默认的模型）：");
  const shelf = await deps.catalogue.choices(run.ownerId);
  const models = [
    ...shelf.library.map(
      (model) =>
        `模型库：${oneLine(model.label ?? model.modelName, NAME_CHARS)}（${oneLine(model.modelName, NAME_CHARS)}）→ { "modelRef": "${model.id}" }`,
    ),
    ...shelf.pool
      .filter((entry) => entry.available)
      .map(
        (model) =>
          `平台体验模型：${oneLine(model.label, NAME_CHARS)}（${oneLine(model.modelName, NAME_CHARS)}）→ { "platformModelRef": "${model.id}" }`,
      ),
  ];
  listed(lines, models, "只有部署默认的模型", (line) => line);

  lines.push("", "能装的技能：");
  listed(
    lines,
    await installableSkills(run),
    "没有",
    (skill) =>
      `${oneLine(skill.slug, NAME_CHARS)}：${oneLine(skill.title, NAME_CHARS)}`,
  );

  lines.push(
    "",
    "能直接给员工的应用（别的应用写进草稿后，确认时会替用户向管理员提申请）：",
  );
  const giveable = (await ownerAppsAllowed(run.ownerId))
    ? await deps.plugins.giveableApps({
        userId: run.ownerId,
        composioConfigured: deps.composioConfigured,
      })
    : [];
  listed(
    lines,
    giveable,
    "没有",
    (app) =>
      `${oneLine(app.displayName, NAME_CHARS)}（app: ${oneLine(app.key, NAME_CHARS)}）可直接给；${ACCOUNT_WORDS[app.account]}`,
  );
  return lines.join("\n");
}

const ACCOUNT_WORDS: Record<string, string> = {
  personal: "用这个人自己连接的账号",
  shared: "用团队账号",
  deployment: "用部署的账号",
};

/**
 * 一节列表：最多 {@link LIST_MAX} 行，截掉的说出还有几个，免得模型以为列出的就是全部；空的说一句，不留空白
 * （空白读起来像工具什么都没说，模型会自己补）。
 */
function listed<T>(
  lines: string[],
  items: readonly T[],
  empty: string,
  render: (item: T) => string,
): void {
  if (items.length === 0) {
    lines.push(`- （${empty}）`);
    return;
  }
  for (const item of items.slice(0, LIST_MAX)) lines.push(`- ${render(item)}`);
  if (items.length > LIST_MAX)
    lines.push(`- ……还有 ${items.length - LIST_MAX} 个没有列出`);
}

/** 名字、头衔这类一行的字段最多这么长。 */
const NAME_CHARS = 80;

/**
 * 别人写的文字（员工名、群名、模板名……）放进给模型的列表前压成一行：去掉控制字符与换行，限长。否则一个
 * 带换行的名字就能在列表里伪造出一行「员工」，模型会照着它起草。
 */
function oneLine(text: string, max: number): string {
  const chars = [
    ...text
      .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ];
  return chars.length > max
    ? `${chars.slice(0, max).join("")}…`
    : chars.join("");
}

/** 列表里一行放得下的摘要。 */
function short(text: string): string {
  return oneLine(text, 60);
}

/**
 * 本人发起、仍在里面的群聊，名字与员工的回答顺序。至少两位员工在 SQL 里先筛掉（一对一的对话占多数，
 * 不必逐个去问），剩下的再看第一个成员是不是本人（与 `creatorOnly` 同一条）。全在本人的帧里读。
 */
async function groupsStartedBy(
  run: Run,
): Promise<{ id: string; name: string; order: string[] }[]> {
  const { deps } = run;
  const groupIds = deps.database
    .select({ id: channelAgents.channelId })
    .from(channelAgents)
    .groupBy(channelAgents.channelId)
    .having(sql`count(*) >= 2`);
  const rows = await deps.database
    .select({ id: channels.id, title: channels.title, name: channels.name })
    .from(channels)
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, run.ownerId),
      ),
    )
    .where(and(isNull(channels.deletedAt), inArray(channels.id, groupIds)));
  const started: { id: string; name: string; order: string[] }[] = [];
  for (const row of rows) {
    if ((await deps.groups.store.people(row.id))[0]?.userId !== run.ownerId)
      continue;
    const current = new Set(await deps.groups.store.bots(row.id));
    const order = (await deps.groups.store.order(row.id)).filter((id) =>
      current.has(id),
    );
    started.push({ id: row.id, name: row.title ?? row.name, order });
  }
  return started;
}

/** 本人能装的技能：管理员（此刻持有能力）任何技能；其余的人自己的技能和已上架的部署技能（同执行器）。 */
async function installableSkills(run: Run) {
  const all = await run.deps.plugins.listSkills({
    id: run.ownerId,
    isAdmin: run.actor.role === "admin",
  });
  if (run.actor.role === "admin") return all;
  const kept = [];
  for (const skill of all) {
    if (skill.ownerUserId === run.ownerId) kept.push(skill);
    else if (
      skill.ownerUserId === null &&
      (await run.deps.plugins.isInstallListed("skill", skill.slug))
    )
      kept.push(skill);
  }
  return kept;
}

// ---------------------------------------------------------------------------------------------------
// propose_*

type Drafted = {
  draft: ProposalDraft;
  dropped: DroppedItem[];
  baseVersion: string | null;
  title: string;
  /** 给模型的额外几句：应用的状态、缺的角色。 */
  notes: string[];
};

async function propose(
  run: Run,
  kind: string,
  given: Record<string, unknown>,
): Promise<McpCallResult> {
  if (!isKind(kind)) return failure("没有这种提议。");
  const { deps } = run;
  const recent = await deps.proposals.countCreatedSince(
    run.ownerId,
    run.threadId,
    new Date(Date.now() - BURST_WINDOW_MS),
  );
  if (recent >= BURST_LIMIT)
    return failure(
      `这段对话里 10 分钟内已经起草了 ${BURST_LIMIT} 份提议，这一份没有起草。先请用户处理已有的卡片，过一会儿再起草。`,
    );
  const parsed = parseDraft(kind, given);
  if (!parsed.ok) return failure(parsed.error);
  const dropped = [...parsed.dropped];
  const drafted =
    kind === "employee"
      ? await checkEmployee(run, parsed.draft as EmployeeDraft, dropped)
      : kind === "employee_change"
        ? await checkEmployeeChange(
            run,
            parsed.draft as EmployeeChangeDraft,
            dropped,
          )
        : kind === "group"
          ? await checkGroup(run, parsed.draft as GroupDraft, given, dropped)
          : await checkGroupChange(
              run,
              parsed.draft as GroupChangeDraft,
              dropped,
            );
  const proposal = await deps.proposals.create({
    ownerId: run.ownerId,
    proposedByAgentId: run.botId,
    threadId: run.threadId,
    kind,
    draft: drafted.draft,
    baseVersion: drafted.baseVersion,
  });
  await audit(run, "staffing.proposal_created", proposal);
  const card: StaffingProposalCard = {
    proposalId: proposal.id,
    kind,
    title: drafted.title,
  };
  return asResult(
    writeStaffingProposalAnswer(card, sentenceFor(card, proposal, drafted)),
  );
}

const isKind = (kind: string): kind is ProposalKind =>
  kind === "employee" ||
  kind === "employee_change" ||
  kind === "group" ||
  kind === "group_change";

/** 给模型的那段话：已起草、在等确认、剔除了什么；明确不许说已经建好。 */
function sentenceFor(
  card: StaffingProposalCard,
  proposal: Proposal,
  drafted: Drafted,
): string {
  const lines = [
    `已起草一份${KIND_WORDS[card.kind]}提议「${card.title}」（proposalId: ${proposal.id}），卡片已经出现在对话里，正在等用户确认。`,
    "用户确认之前什么都没有建、也没有改：不要说已经建好了或已经改好了。",
  ];
  if (drafted.dropped.length > 0) {
    lines.push("起草时剔除了这些无效的项（请告诉用户）：");
    for (const item of drafted.dropped)
      lines.push(`- ${item.field}「${item.value}」：${item.reason}`);
  }
  lines.push(...drafted.notes);
  lines.push(
    "接下来用一两句话告诉用户为什么这么拟。用户确认之后，用 proposal_status 读结果再接着说；用户口头要改，就请他作废这张卡片，再起草一份新的。",
  );
  return lines.join("\n");
}

/** 起草时就过一遍创建 / 编辑员工那条路径的检查（按 UTF-16 数长度），不合格当场告诉模型。 */
function assertAgentInput(raw: Record<string, unknown>): void {
  const parsed = parseAgentInput(raw);
  if (!parsed.ok) throw new DraftRefused(inputRefusal(parsed.error));
}

async function checkEmployee(
  run: Run,
  draft: EmployeeDraft,
  dropped: DroppedItem[],
): Promise<Drafted> {
  assertAgentInput({
    name: draft.name,
    title: draft.title,
    roleDescription: draft.roleDescription,
    visibility: draft.visibility,
    ...(draft.persona ? { persona: draft.persona } : {}),
    ...(draft.bible ? { bible: draft.bible } : {}),
    ...(draft.avatar && "seed" in draft.avatar
      ? { avatarSeed: draft.avatar.seed }
      : {}),
  });
  if (draft.roleTemplate) {
    const reason = await roleTemplateRefusal(run, draft.roleTemplate);
    if (reason) {
      dropped.push({
        field: "roleTemplate",
        value: draft.roleTemplate.id,
        reason,
      });
      delete draft.roleTemplate;
    }
  }
  if (draft.model) {
    const reason = await modelRefusal(run, draft.model, null);
    if (reason) {
      dropped.push({ field: "model", value: modelId(draft.model), reason });
      delete draft.model;
    }
  }
  draft.skills = await keptSkills(run, draft.skills, dropped);
  const notes: string[] = [];
  draft.apps = await keptApps(run, null, draft.apps, dropped, notes);
  draft.routines = await keptRoutines(run, draft.routines, dropped);
  return { draft, dropped, baseVersion: null, title: draft.name, notes };
}

async function checkEmployeeChange(
  run: Run,
  draft: EmployeeChangeDraft,
  dropped: DroppedItem[],
): Promise<Drafted> {
  const { deps } = run;
  const target = await deps.profiles.get(run.actor, draft.agentId);
  // 看不见与不能改一个说法，不让人借答复探出别人的私有员工在不在。
  if (!target || !canManageAgent(run.actor, target))
    throw new DraftRefused(
      `找不到员工 ${draft.agentId}，或者你不能修改它，所以没有起草。`,
    );
  const baseVersion = await currentEmployeeVersion(
    deps.database,
    draft.agentId,
  );
  if (baseVersion === null)
    throw new DraftRefused(`找不到员工 ${draft.agentId}，所以没有起草。`);
  const { set } = draft;
  // 只有个人起步员工有单独的指令（读出来是文字）；别的员工会忽略它，卡片上也就不该出现。
  if (
    set.instructions !== undefined &&
    typeof target.instructions !== "string"
  ) {
    dropped.push({
      field: "instructions",
      value: [...set.instructions].slice(0, 20).join(""),
      reason:
        "这位员工没有单独的工作指令，它按职责描述工作；要改它的做法，请改 roleDescription。",
    });
    delete set.instructions;
  }
  assertAgentInput({
    name: set.name ?? target.name,
    title: set.title ?? target.title,
    roleDescription: set.roleDescription ?? target.roleDescription,
    visibility: set.visibility ?? target.visibility,
    ...(set.instructions ? { instructions: set.instructions } : {}),
    ...(set.persona ? { persona: set.persona } : {}),
    ...(set.bible ? { bible: set.bible } : {}),
    ...(set.avatar && "seed" in set.avatar
      ? { avatarSeed: set.avatar.seed }
      : {}),
  });
  if (set.model) {
    const reason = await modelRefusal(run, set.model, target);
    if (reason) {
      dropped.push({ field: "model", value: modelId(set.model), reason });
      delete set.model;
    }
  }
  const notes: string[] = [];
  if (set.skills !== undefined) {
    set.skills = await keptSkills(run, set.skills, dropped);
    if (set.skills.length === 0) delete set.skills;
  }
  if (set.apps !== undefined) {
    set.apps = await keptApps(run, target, set.apps, dropped, notes);
    if (set.apps.length === 0) delete set.apps;
  }
  if (set.routines !== undefined) {
    set.routines = await keptRoutines(run, set.routines, dropped);
    if (set.routines.length === 0) delete set.routines;
  }
  if (draft.routinesRemove.length > 0) {
    const its = new Set(
      (await deps.routines.listFor(run.ownerId))
        .filter((routine) => routine.agentId === draft.agentId)
        .map((routine) => routine.id),
    );
    draft.routinesRemove = draft.routinesRemove.filter((routineId) => {
      if (its.has(routineId)) return true;
      dropped.push({
        field: "routinesRemove",
        value: routineId,
        reason: "这位员工没有这个定时任务。",
      });
      return false;
    });
  }
  if (
    Object.keys(set).length === 0 &&
    draft.appsRemove.length === 0 &&
    draft.routinesRemove.length === 0
  )
    throw new DraftRefused(
      `去掉无效的项之后没有剩下要改的内容，所以没有起草。${describeDropped(dropped)}`,
    );
  return {
    draft,
    dropped,
    baseVersion,
    title: `调整「${target.name}」`,
    notes,
  };
}

async function checkGroup(
  run: Run,
  draft: GroupDraft,
  given: Record<string, unknown>,
  dropped: DroppedItem[],
): Promise<Drafted> {
  const unusable = await unusableBots(run, draft.members);
  if (unusable.length > 0)
    throw new DraftRefused(
      `员工 ${unusable.join("、")} 你用不了（找不到，或者是别人的私有员工），群聊没有起草。请换成 list_staff 里列出的员工。`,
    );
  const notes: string[] = [];
  const missing = missingRolesOf(given.missingRoles);
  if (missing.length > 0)
    notes.push(
      `需求里还缺这些角色：${missing.join("、")}。问用户要不要先招，用户同意就用 propose_employee 起草。`,
    );
  return { draft, dropped, baseVersion: null, title: draft.name, notes };
}

/** 模型说现有员工里对不上的角色，原样转进给模型的话里；只收短文字，免得被拿来塞长文本。 */
function missingRolesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => short(item))
    .filter((item) => item !== "")
    .slice(0, MISSING_ROLES_MAX);
}

async function checkGroupChange(
  run: Run,
  draft: GroupChangeDraft,
  dropped: DroppedItem[],
): Promise<Drafted> {
  const { deps } = run;
  const { channelId } = draft;
  const baseVersion = await currentGroupVersion(
    deps.database,
    deps.groups.store,
    run.ownerId,
    channelId,
  );
  if (baseVersion === null)
    throw new DraftRefused("找不到这个群聊，所以没有起草。");
  const bots = await deps.groups.store.bots(channelId);
  if (bots.length < 2) throw new DraftRefused("这不是群聊，所以没有起草。");
  // 与执行时 `creatorOnly` 同一条：群里第一个人是发起人。
  if ((await deps.groups.store.people(channelId))[0]?.userId !== run.ownerId)
    throw new DraftRefused(
      "只有发起这个群聊的人才能调整它，所以没有起草。可以请发起人来调整。",
    );
  const [row] = await deps.database
    .select({ title: channels.title, name: channels.name })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  const groupName = row?.title ?? row?.name ?? channelId;

  draft.add = draft.add.filter((agentId) => {
    if (!bots.includes(agentId)) return true;
    dropped.push({ field: "add", value: agentId, reason: "已经在群里了。" });
    return false;
  });
  const unusable = await unusableBots(run, draft.add);
  if (unusable.length > 0)
    throw new DraftRefused(
      `员工 ${unusable.join("、")} 你用不了（找不到，或者是别人的私有员工），不能加进群里，所以没有起草。`,
    );
  draft.remove = draft.remove.filter((agentId) => {
    if (bots.includes(agentId)) return true;
    dropped.push({ field: "remove", value: agentId, reason: "不在这个群里。" });
    return false;
  });
  const after = [
    ...bots.filter((agentId) => !draft.remove.includes(agentId)),
    ...draft.add,
  ];
  if (after.length < 2)
    throw new DraftRefused("群里至少要留 2 位员工，所以没有起草。");
  if (after.length > 20)
    throw new DraftRefused("一个群最多 20 位员工，所以没有起草。");
  if (
    draft.order !== undefined &&
    (draft.order.length !== after.length ||
      !draft.order.every((agentId) => after.includes(agentId)))
  )
    throw new DraftRefused(
      `新的顺序必须正好包含调整之后群里的每一位员工：${after.join("、")}。所以没有起草。`,
    );
  if (
    draft.name === undefined &&
    draft.order === undefined &&
    draft.add.length === 0 &&
    draft.remove.length === 0
  )
    throw new DraftRefused(
      `去掉无效的项之后没有剩下要改的内容，所以没有起草。${describeDropped(dropped)}`,
    );
  return {
    draft,
    dropped,
    baseVersion,
    title: `调整「${groupName}」`,
    notes: [],
  };
}

function describeDropped(dropped: readonly DroppedItem[]): string {
  return dropped
    .map((item) => `${item.field}「${item.value}」：${item.reason}`)
    .join("；");
}

/** 本人此刻用不了的员工（与建群时同一个检查：读得到、且能运行）。看不见的只能按 id 说。 */
async function unusableBots(
  run: Run,
  agentIds: readonly string[],
): Promise<string[]> {
  const unusable: string[] = [];
  for (const agentId of agentIds) {
    const profile = await run.deps.profiles.get(run.actor, agentId);
    if (!profile || !canRunAgent(run.actor, profile)) unusable.push(agentId);
  }
  return unusable;
}

/** 角色模板只认本人自己的（官方模板的 id 不是 uuid，员工不能记它为来源），版本不能比模板现在的新。 */
async function roleTemplateRefusal(
  run: Run,
  source: { id: string; version: number },
): Promise<string | null> {
  if (!UUID.test(source.id))
    return "这不是你的角色模板（官方模板只能照着写，不能作为来源）。";
  const template = (await run.deps.roleTemplates.list()).find(
    (candidate) => candidate.id === source.id,
  );
  if (!template) return "没有这个角色模板，或者它已经被删除。";
  if (source.version < 1 || source.version > template.version)
    return `模板没有这个版本，现在是版本 ${template.version}。`;
  return null;
}

/** 这位员工是不是在本部署里跑的（`agents.type`），在本人的帧里读。 */
async function runsHere(run: Run, agentId: string): Promise<boolean> {
  const [row] = await run.deps.database
    .select({ type: agents.type })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row?.type === "built_in";
}

const modelId = (model: NonNullable<EmployeeDraft["model"]>) =>
  "modelRef" in model ? model.modelRef : model.platformModelRef;

/**
 * 模型与员工的模型选择器、`profiles.update` 同一个标准：模型库里启用的行，或本人套餐能用、部署握有密钥的
 * 平台体验模型。部署目录（`ModelCatalogueReader`）不认这两种 id，所以不用它。
 */
async function modelRefusal(
  run: Run,
  model: NonNullable<EmployeeDraft["model"]>,
  target: AgentProfile | null,
): Promise<string | null> {
  // 与 `profiles.update` 同一个判断：只有在这里跑的员工（`agents.type` 为 built_in）才能绑模型。
  if (target && !(await runsHere(run, target.id)))
    return "这位员工在别的服务器上运行，模型要在那边选。";
  const shelf = await run.deps.catalogue.choices(run.ownerId);
  if ("modelRef" in model)
    return shelf.library.some((entry) => entry.id === model.modelRef)
      ? null
      : "模型库里没有这个模型，或者它已经停用。";
  const pooled = shelf.pool.find(
    (entry) => entry.id === model.platformModelRef,
  );
  if (!pooled) return "你的套餐里没有这个平台体验模型。";
  if (!pooled.available) return "这个平台体验模型暂不可用。";
  return null;
}

/** 技能按执行时的授予规则：管理员任何技能；其余的人自己的技能，或管理员上架了的部署技能。 */
async function keptSkills(
  run: Run,
  slugs: readonly string[],
  dropped: DroppedItem[],
): Promise<string[]> {
  const kept: string[] = [];
  for (const slug of slugs) {
    const owner = await run.deps.plugins.skillOwner(slug);
    const reason =
      owner === undefined
        ? "没有这个技能。"
        : run.actor.role === "admin" || owner === run.ownerId
          ? null
          : owner === null &&
              (await run.deps.plugins.isInstallListed("skill", slug))
            ? null
            : owner === null
              ? "这是部署的技能，由管理员决定给哪些员工。"
              : "这是别人的技能。";
    if (reason) dropped.push({ field: "skills", value: slug, reason });
    else kept.push(slug);
  }
  return kept;
}

const APP_STATUS_WORDS = {
  grantable: "确认后直接给",
  "needs-connection": "确认后会给，但用户要先连接自己的账号才能用",
  "needs-admin": "需要管理员批准，确认后会替用户提申请",
} as const;

/** 草稿点名的动作里，有没有这位员工还没持有的。 */
async function lacksNamedAction(
  run: Run,
  agentId: string,
  key: string,
  actions: readonly string[],
): Promise<boolean> {
  if (actions.length === 0 || agentId === "") return false;
  const rows = await run.deps.database
    .select({ ref: pluginGrants.ref })
    .from(pluginGrants)
    .where(
      and(eq(pluginGrants.agentId, agentId), eq(pluginGrants.kind, "mcp")),
    );
  const held = new Set(rows.map((row) => row.ref));
  return actions.some(
    (action) =>
      !held.has(action.startsWith(`${key}/`) ? action : `${key}/${action}`),
  );
}

/**
 * 应用：叫不出来的剔除；其余按执行时的判断算出状态写给模型——本人能直接给的（应用已打开、对主人开放、管理员
 * 没关掉「把自己的应用给自己的员工」）是 grantable，要先连账号的是 needs-connection，其余 needs-admin。
 * 新员工还没有 id，就按「这位员工什么都没有」问。
 */
async function keptApps(
  run: Run,
  target: AgentProfile | null,
  apps: readonly { app: string; actions: string[] }[],
  dropped: DroppedItem[],
  notes: string[],
): Promise<{ app: string; actions: string[] }[]> {
  const { deps } = run;
  const kept: { app: string; actions: string[] }[] = [];
  const statuses: string[] = [];
  const ownerMayGive = await ownerAppsAllowed(run.ownerId);
  for (const entry of apps) {
    const inspected = await deps.plugins.inspectApp({
      app: entry.app,
      agentId: target?.id ?? "",
      userId: run.ownerId,
      composioConfigured: deps.composioConfigured,
      ...(deps.directory ? { directory: deps.directory } : {}),
      ownerView: true,
    });
    if (!inspected || !(inspected.vouched || inspected.access.granted)) {
      dropped.push({
        field: "apps",
        value: entry.app,
        reason: "这个部署没有这个应用。",
      });
      continue;
    }
    /*
     * 「已经有」是按应用算的（`access.granted`），持有一个动作不等于持有草稿点名的另一个：点名的动作有没有
     * 全部在手，按动作比（同执行器 `giveApp`），还缺的留下，由执行器在执行时再查。没点名动作的，持有就是有了。
     */
    if (
      inspected.access.granted &&
      !(await lacksNamedAction(
        run,
        target?.id ?? "",
        inspected.access.key,
        entry.actions,
      ))
    ) {
      dropped.push({
        field: "apps",
        value: entry.app,
        reason: "员工已经有这个应用了。",
      });
      continue;
    }
    if (inspected.own) {
      dropped.push({
        field: "apps",
        value: entry.app,
        reason: "这是用户自己添加的应用，请他在插件页自己装到员工上。",
      });
      continue;
    }
    const open =
      inspected.unavailable === null && inspected.answeringId !== null;
    const status =
      open && ownerMayGive && inspected.access.ownerGrants === "any"
        ? inspected.access.needsConnect
          ? "needs-connection"
          : "grantable"
        : "needs-admin";
    // 存键不存叫法：卡片的「去连接」、收回、执行都按键找这个应用，别名到了那边就找不到了。
    kept.push({ ...entry, app: inspected.access.key });
    statuses.push(
      `- ${inspected.access.displayName}（${status}）：${APP_STATUS_WORDS[status]}`,
    );
  }
  if (statuses.length > 0) notes.push("应用的状态：", ...statuses);
  return kept;
}

/** 每人启用中的定时任务最多 20 条：起草时就把放不下的剔除。 */
async function keptRoutines(
  run: Run,
  routines: EmployeeDraft["routines"],
  dropped: DroppedItem[],
): Promise<EmployeeDraft["routines"]> {
  if (routines.length === 0) return routines;
  const enabled = (await run.deps.routines.listFor(run.ownerId)).filter(
    (routine) => routine.enabled,
  ).length;
  const room = Math.max(0, 20 - enabled);
  for (const routine of routines.slice(room))
    dropped.push({
      field: "routines",
      value: routine.title ?? routine.cron,
      reason: "启用中的定时任务最多 20 条，这一条放不下。",
    });
  return routines.slice(0, room);
}

// ---------------------------------------------------------------------------------------------------
// proposal_status

const STATUS_WORDS: Record<Proposal["status"], string> = {
  pending: "等待用户在卡片上确认，还什么都没有建。",
  applying: "用户已经确认，正在执行。",
  applied: "已执行完。",
  partially_applied: "部分完成：有的项失败了，用户可以在卡片上重试失败的项。",
  discarded: "用户已经作废了这份提议，什么都没有建。",
  expired: "已过期（7 天没有确认），什么都没有建；需要的话重新起草。",
};

const OUTCOME_WORDS: Record<ResultItem["outcome"], string> = {
  done: "完成",
  requested: "已替用户提了申请",
  needs_connection: "要用户先连接账号",
  failed: "失败",
};

/**
 * 只读本人的提议。到期的 pending 先经 `expireIfLapsed` 落成 expired，且只有把它落下的这一次写轨迹——与路由
 * 同一条路；直接 `get` 也会落成 expired 却不留轨迹，过期的提议就没人记了。
 */
async function proposalStatus(
  run: Run,
  proposalId: unknown,
): Promise<McpCallResult> {
  const notFound = failure("找不到这份提议。");
  if (typeof proposalId !== "string" || !UUID.test(proposalId.trim()))
    return notFound;
  const id = proposalId.trim();
  const { proposals, database } = run.deps;
  /*
   * 先看是不是本人的，再碰它：`expireIfLapsed` 与 `get` 都会把到期的提议落成 expired，别人的提议不该因为
   * 这个人问了一句就变了状态、留下一行记在这个人名下的轨迹。别人的与不存在的一个说法，不让员工借这个工具
   * 探出别人有没有提议。
   */
  const [owned] = await database
    .select({ ownerId: staffingProposals.ownerId })
    .from(staffingProposals)
    .where(eq(staffingProposals.id, id))
    .limit(1);
  if (!owned || owned.ownerId !== run.ownerId) return notFound;
  const lapsed = await proposals.expireIfLapsed(id);
  const proposal = await proposals.get(id);
  if (!proposal) return notFound;
  if (lapsed) await audit(run, "staffing.proposal_expired", proposal);
  const lines = [
    `${KIND_WORDS[proposal.kind]}提议（proposalId: ${proposal.id}）：${STATUS_WORDS[proposal.status]}`,
  ];
  if (proposal.result && proposal.result.length > 0) {
    lines.push("逐项结果：");
    for (const item of proposal.result)
      lines.push(
        `- ${item.step}${item.target ? `（${item.target}）` : ""}：${OUTCOME_WORDS[item.outcome]}${item.message ? `。${item.message}` : ""}`,
      );
  }
  if (proposal.status !== "applied")
    lines.push("不要说已经建好了或已经改好了。");
  return asResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------------------------------

/** 轨迹写在本人名下；写不进去不拦起草（提议已经在表里了），只记日志（同路由与执行器）。 */
async function audit(
  run: Run,
  eventType: "staffing.proposal_created" | "staffing.proposal_expired",
  proposal: Proposal,
): Promise<void> {
  try {
    await recordAuditEvent(run.deps.auditStore, {
      eventType,
      actorUserId: run.ownerId,
      targetType: "staffing_proposal",
      targetId: proposal.id,
      payload: {
        proposalId: proposal.id,
        kind: proposal.kind,
        bot: run.botId,
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "staffing-audit-write-failed",
        eventType,
        error: String(error),
      }),
    );
  }
}
