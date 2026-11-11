import { and, eq, isNull } from "drizzle-orm";
import { ZodError } from "zod";
import { STAFFING_TOOL_NAMES } from "../../../shared/staffing-proposal";
import { enterpriseControls } from "../admin/controls";
import { canManageAgent, canRunAgent } from "../agents/profile-policy";
import {
  AgentChangedError,
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
  ModelBindingNotApplicableError,
  ModelNotInLibraryError,
  ProtectedAgentError,
} from "../agents/profile-store";
import type {
  AgentActor,
  CreateAgentInput,
  Persona,
} from "../agents/profile-types";
import { parseAgentInput } from "../agents/routes";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AuthenticatedActor } from "../auth/guards";
import {
  type GroupConversations,
  GroupNotFoundError,
  type GroupStore,
} from "../channels/group";
import {
  ChannelNotFoundError,
  ChannelNotOwnerError,
  type ChannelStore,
} from "../channels/routes";
import type { Database } from "../db/client";
import {
  agentProfiles,
  channelMemberships,
  channels,
  pluginGrants,
} from "../db/schema";
import { nothingToRequest } from "../plugins/app-access";
import {
  type AppDirectory,
  type AppInspection,
  requestPlanFor,
} from "../plugins/app-access-store";
import { MAX_PENDING_APP_ACCESS_REQUESTS } from "../plugins/app-access-tool";
import {
  approveOwnersSharedUse,
  ownerGrantRefusal,
  withdrawOwnersSharedUse,
} from "../plugins/owner-grants";
import { personalRevokeRefusalFor } from "../plugins/personal-defaults";
import {
  type SharedAudience,
  SharedUseNotSharedError,
  type SharedUseStore,
} from "../plugins/shared-use-store";
import { PluginRefusedError, type PluginStore } from "../plugins/store";
import type { PortraitStore } from "../portraits/store";
import type { QuotaService } from "../quota/limits";
import { ScheduleRefusedError } from "../routines/schedule";
import {
  RoutineLimitError,
  RoutineNotFoundError,
  RoutineRefusedError,
  type RoutineStore,
} from "../routines/store";
import { capabilityFor } from "../tenant/context";
import { parseDraft } from "./draft";
import type { StaffingProposalStore } from "./store";
import { ProposalNotFoundError, ProposalStateError } from "./store";
import type {
  EmployeeChangeDraft,
  EmployeeDraft,
  GroupChangeDraft,
  GroupDraft,
  PortraitPreset,
  Proposal,
  ProposalDraft,
  ResultItem,
  RoutineDraft,
} from "./types";
import { versionOfEmployee, versionOfGroup } from "./version";

/**
 * 把本人确认过的提议变成真的员工与群聊。
 *
 * 以本人的身份、在请求自己的帧里做，每一步都走现有的服务与它们自己的检查（名额、模型库、自助授予、主人能给
 * 的应用、定时任务上限、群聊只限发起人），这里不另写一份规则，也不开新的帧：本人做不到的，经提议也做不到。
 *
 * 管理员按此刻的能力算（`capabilityFor`，由 `user_roles` 现读），不按会话里写的角色：角色被收回、会话还写着
 * admin 的人，在这里和成员一样，管理员专属的授予转成访问申请。
 *
 * 每一步各自成败、写进结果，失败不拦后面的步骤，已经建好的不回滚；只有建员工这一步例外：它失败时什么都没
 * 建，提议放回待确认并把错误交给路由（名额满是 402）。
 */

/** 内容在起草之后被改过：什么都不做，提议放回待确认，请小管家重新起草。 */
export class ProposalStaleError extends Error {
  constructor() {
    super("内容已变化，请让小管家重新起草。");
    this.name = "ProposalStaleError";
  }
}

/** 草稿过不了创建员工那条路径的检查：什么都没建，提议放回待确认，本人改了草稿再确认。 */
export class ProposalRefusedError extends Error {
  /** 是管理员对这个人关掉的能力，而不是草稿本身的毛病：路由答 403 而不是 400。 */
  readonly capability: boolean;
  constructor(message: string, capability = false) {
    super(message);
    this.capability = capability;
    this.name = "ProposalRefusedError";
  }
}

/**
 * 「招聘与组群」这组工具的名字，授予写成 `staffing/<名字>`。与内置服务在目录里列出的是同一份常量
 * （`shared/staffing-proposal.ts`），勾了「也给它招聘与组群能力」的员工不会少一个工具。
 */
export { STAFFING_TOOL_NAMES };

/** 「招聘与组群」在目录里的键（`plugins/catalogue.ts`）。 */
const STAFFING_APP = "staffing";

export type StaffingExecutorDeps = {
  database: Database;
  proposals: StaffingProposalStore;
  profiles: Pick<AgentProfileStore, "create" | "update" | "get">;
  /** 不数名额的部署（个人机器上）不给。 */
  quota?: Pick<QuotaService, "assertCapacityWithin">;
  plugins: Pick<
    PluginStore,
    | "grant"
    | "skillOwner"
    | "isInstallListed"
    | "agentOwner"
    | "agentIsRegistered"
    | "agentType"
    | "inspectApp"
    | "listForAgent"
    | "listServers"
    | "fileAppAccessRequest"
    | "recordAppAccessEvent"
    | "revokeOwnerGrants"
    | "revoke"
  >;
  composioConfigured: boolean;
  directory?: AppDirectory;
  routines: Pick<RoutineStore, "create" | "remove" | "listFor">;
  channels: Pick<ChannelStore, "direct" | "rename">;
  groups: Pick<
    GroupConversations,
    "create" | "addBots" | "removeBots" | "reorder"
  > & { store: Pick<GroupStore, "order" | "bots"> };
  portraits: Pick<PortraitStore, "set">;
  auditStore: AuditStore;
  /**
   * 管理员对这个人开着的能力（`useBots`、`teamBots`）。`POST/PATCH /api/agents` 的这道门挂在路由上
   * （`admin/gate.ts`），执行器直接调员工库、走不到那里，所以在这里再问一遍。不给时读部署的企业控制，
   * 没装企业控制时和那道门一样放行。
   */
  mayUse?: (actorId: string, capability: BotCapability) => Promise<boolean>;
  /**
   * 共享使用批准（同 `POST/DELETE /give`）：主人给出 Shared 应用时设下团队账号受众，收回时一并撤回。
   * 没给时只授予、只收回，团队账号的调用在有人批准受众之前被闸门拒绝。
   */
  shared?: {
    store: Pick<
      SharedUseStore,
      "approveOwnerGrant" | "withdrawOwnerApprovals" | "appIdOf"
    >;
    audience: Pick<SharedAudience, "record">;
  };
};

/** 建、改员工要过的两道能力：用员工，以及把员工公开给团队。 */
export type BotCapability = "useBots" | "teamBots";

const CAPABILITY_REFUSALS: Record<BotCapability, string> = {
  useBots: "管理员关闭了你「使用员工」的权限，所以没有做。",
  teamBots: "管理员关闭了你「把员工公开给团队」的权限，所以没有做。",
};

/** 与 `admin/gate.ts` 同一个来源：企业控制里这个人的能力；没装企业控制的部署不设这道门。 */
async function enterpriseAllows(
  actorId: string,
  capability: BotCapability,
): Promise<boolean> {
  const controls = enterpriseControls();
  return controls ? controls.capabilityFor(actorId, capability) : true;
}

/** 员工此刻的版本，在调用者的帧里读；看不见或已删除为 null。起草与执行用同一个读法。 */
export async function currentEmployeeVersion(
  database: Database,
  agentId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ updatedAt: agentProfiles.updatedAt })
    .from(agentProfiles)
    .where(
      and(eq(agentProfiles.agentId, agentId), isNull(agentProfiles.deletedAt)),
    )
    .limit(1);
  return row ? versionOfEmployee(row) : null;
}

/**
 * 群聊此刻的版本：本人取的名字（没取过就是建群时的名字）和员工的回答顺序；本人不在群里或群已删除为 null。
 * 顺序只算还在群里的员工：被移出的员工在别的成员名下留下的线程行不算。
 */
export async function currentGroupVersion(
  database: Database,
  store: Pick<GroupStore, "order" | "bots">,
  ownerUserId: string,
  channelId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ title: channels.title, name: channels.name })
    .from(channels)
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, ownerUserId),
      ),
    )
    .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
    .limit(1);
  if (!row) return null;
  const current = new Set(await store.bots(channelId));
  const order = (await store.order(channelId)).filter((id) => current.has(id));
  return versionOfGroup({ name: row.title ?? row.name, order });
}

type Outcome = Omit<ResultItem, "step">;
type Step = { step: string; target?: string; run: () => Promise<Outcome> };

const done = (message: string, target?: string): Outcome => ({
  outcome: "done",
  message,
  ...(target === undefined ? {} : { target }),
});
const failed = (message: string): Outcome => ({ outcome: "failed", message });

const SUCCEEDED: ReadonlySet<ResultItem["outcome"]> = new Set([
  "done",
  "requested",
  "needs_connection",
]);

/** 开发模式的本人不是 `users` 里的一行，轨迹的外键会拒绝它（同 `agents/routes.ts`）。 */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

const hasChinese = (text: string) => /\p{Script=Han}/u.test(text);

/**
 * 创建员工那条路径的拒绝原因是写给表单的英文；结果是给本人看的，所以按拒绝的字段换成中文。认不出的用泛称，
 * 不透出英文。
 */
const INPUT_REFUSALS: [RegExp, string][] = [
  [/^Name must/, "名字需要 1 到 80 个字符。"],
  [/^Title must/, "头衔不能超过 120 个字符。"],
  [/^What it does must/, "职责描述需要 1 到 1000 个字符。"],
  [/^Instructions must/, "工作指令需要 1 到 1000 个字符。"],
  [
    /^Avatar seed must/,
    "头像种子只能是 1 到 64 个字母、数字或 _ - : . 这几个符号。",
  ],
  [
    /^The (tone|principles|habits) line/,
    "人设的每一部分不能超过 2000 个字符。",
  ],
  [/^Pick a model/, "请从模型库里选一个模型。"],
];

/** 起草时也用它（`builtin-staffing.ts`）：同一条检查、同一句中文，模型当场就知道，不等本人确认时才失败。 */
export function inputRefusal(error: string): string {
  if (hasChinese(error)) return error;
  return (
    INPUT_REFUSALS.find(([pattern]) => pattern.test(error))?.[1] ??
    "员工资料有一项不符合要求，请改一下草稿再确认。"
  );
}

/** 一步失败时给本人看的原因：已经是中文的原样给，其余按错误的种类换成中文，认不出的用泛称并记日志。 */
function reasonOf(error: unknown): string {
  if (error instanceof RoutineLimitError)
    return "启用中的定时任务已经有 20 条，这一条没有建。";
  if (error instanceof RoutineNotFoundError) return "没有找到这个定时任务。";
  if (error instanceof ScheduleRefusedError)
    return "这条定时任务的时间设置不合格。";
  if (error instanceof RoutineRefusedError)
    return hasChinese(error.message) ? error.message : "这条定时任务没有建成。";
  if (error instanceof ModelNotInLibraryError)
    return "模型库里没有这个模型，或者它已经停用。";
  if (error instanceof ModelBindingNotApplicableError)
    return "这位员工在别的服务器上运行，模型要在那边选。";
  if (error instanceof AgentNotFoundError) return "找不到这位员工。";
  if (
    error instanceof AgentNotManageableError ||
    error instanceof ProtectedAgentError
  )
    return "你不能修改这位员工。";
  if (error instanceof ChannelNotOwnerError)
    return "只有发起这个群聊的人才能改名。";
  if (
    error instanceof ChannelNotFoundError ||
    error instanceof GroupNotFoundError
  )
    return "找不到这个群聊。";
  if (error instanceof ZodError) return "员工名单不合格。";
  if (error instanceof PluginRefusedError)
    return hasChinese(error.message)
      ? error.message
      : "这项授予不由你在这里决定。";
  if (error instanceof Error && hasChinese(error.message)) return error.message;
  console.error(
    JSON.stringify({
      type: "staffing-step-failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return "这一步没有做成，可以稍后重试。";
}

/** 草稿里缺的人设部分沿用员工现在的：更新会整份覆盖人设，空着的部分就会被清掉。 */
function mergedPersona(current: Persona | null, given: Persona): Persona {
  return {
    tone: given.tone || current?.tone || "",
    principles: given.principles || current?.principles || "",
    habits: given.habits || current?.habits || "",
  };
}

/** 员工改动里写进员工资料的那几项：有任何一项就有一步「更新资料」。 */
const PROFILE_FIELDS: (keyof EmployeeChangeDraft["set"])[] = [
  "name",
  "title",
  "roleDescription",
  "visibility",
  "instructions",
  "persona",
  "bible",
  "model",
];

/** 改动只改指令、员工又不是个人起步员工时的原因：写下去不会有任何效果，照实说，不报「已更新」。 */
const NO_INSTRUCTIONS_HERE =
  "这位员工没有单独的工作指令，它按职责描述工作；要改它的做法，请改职责描述。";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createStaffingExecutor(deps: StaffingExecutorDeps) {
  /**
   * 本人此刻的样子：会话写着管理员、这次请求也确实持有管理员能力的，才是管理员。员工库的读取过滤与技能的
   * 管理员规则都按它判断。
   */
  const agentActorOf = (actor: AuthenticatedActor): AgentActor => ({
    id: actor.id,
    role:
      actor.role === "admin" && capabilityFor(actor.id) === "admin"
        ? "admin"
        : "user",
  });

  const audit = async (
    actor: AuthenticatedActor,
    event: Omit<Parameters<typeof recordAuditEvent>[1], "actorUserId">,
  ) => {
    try {
      await recordAuditEvent(deps.auditStore, {
        ...event,
        ...(actor.email === DEV_ACTOR_EMAIL ? {} : { actorUserId: actor.id }),
      });
    } catch (error) {
      // 改动已经做了；轨迹一时写不进不是说它没做的理由（同 `agents/routes.ts` 的 `record`）。
      console.error(
        JSON.stringify({
          type: "staffing-audit-write-failed",
          eventType: event.eventType,
          error: String(error),
        }),
      );
    }
  };

  /**
   * 一次执行要用到的东西：本人、此刻的身份，与提议 id（每一行轨迹都带上它）。
   */
  type Run = {
    actor: AuthenticatedActor;
    agentActor: AgentActor;
    proposalId: string;
    /**
     * 改员工的提议起草时员工的版本。资料的那一次写入在员工的行锁下再比一次，两份基于同一版本的改动
     * 不会都写进去；重试时没有它（对象正是上一次改的）。
     */
    unchangedSince?: Date;
  };

  const botTrail = (
    run: Run,
    eventType: "bot.created" | "bot.updated",
    agentId: string,
    payload: Record<string, unknown>,
  ) =>
    audit(run.actor, {
      eventType,
      targetType: "agent",
      targetId: agentId,
      payload: {
        bot: agentId,
        actor: run.actor.email,
        ...payload,
        proposalId: run.proposalId,
      },
    });

  /** 过一遍创建 / 编辑员工的路由用的同一个检查；过不了就是中文的原因。 */
  const checkedInput = (
    raw: Record<string, unknown>,
  ): { ok: true; value: CreateAgentInput } | { ok: false; error: string } => {
    const parsed = parseAgentInput(raw);
    return parsed.ok
      ? parsed
      : { ok: false, error: inputRefusal(parsed.error) };
  };

  /**
   * 建或改成这个可见范围的员工，本人此刻有没有这个能力；没有时是拒绝的那句话。问不出来按没有（同那道门）。
   */
  async function capabilityRefusal(
    run: Run,
    visibility: CreateAgentInput["visibility"],
  ): Promise<string | null> {
    const needed: BotCapability[] =
      visibility === "public" ? ["useBots", "teamBots"] : ["useBots"];
    const mayUse = deps.mayUse ?? enterpriseAllows;
    for (const capability of needed) {
      const allowed = await mayUse(run.actor.id, capability).catch(() => false);
      if (!allowed) return CAPABILITY_REFUSALS[capability];
    }
    return null;
  }

  /**
   * 以员工现在的资料为底，改成草稿里给出的字段，再走编辑员工的那条路径。人设按部分合并；空的指令不发
   * （那条路径要求 1 到 1000 个字符）；手册给了空就是清掉。
   */
  async function updateFrom(
    run: Run,
    agentId: string,
    set: EmployeeChangeDraft["set"],
  ): Promise<Outcome> {
    const current = await deps.profiles.get(run.agentActor, agentId);
    if (!current) return failed("找不到这位员工。");
    // 只有个人起步员工有单独的指令（读出来是文字，别的员工读出来是 null）；别的员工按职责描述工作，编辑那条路径会忽略它。
    const starter = typeof current.instructions === "string";
    const instructions = starter ? set.instructions : undefined;
    const others = PROFILE_FIELDS.some(
      (field) => field !== "instructions" && set[field] !== undefined,
    );
    if (
      set.instructions !== undefined &&
      !starter &&
      !others &&
      !(set.avatar && "seed" in set.avatar)
    )
      return failed(NO_INSTRUCTIONS_HERE);
    const checked = checkedInput({
      name: set.name ?? current.name,
      title: set.title ?? current.title,
      roleDescription: set.roleDescription ?? current.roleDescription,
      visibility: set.visibility ?? current.visibility,
      ...(instructions ? { instructions } : {}),
      ...(set.persona
        ? { persona: mergedPersona(current.persona, set.persona) }
        : {}),
      ...(set.bible === undefined ? {} : { bible: set.bible || null }),
      ...(set.avatar && "seed" in set.avatar
        ? { avatarSeed: set.avatar.seed }
        : {}),
      ...(set.model ?? {}),
    });
    if (!checked.ok) return failed(checked.error);
    const refused = await capabilityRefusal(run, checked.value.visibility);
    if (refused) return failed(refused);
    let updated: Awaited<ReturnType<typeof deps.profiles.update>>;
    try {
      updated = await deps.profiles.update(
        run.agentActor,
        agentId,
        checked.value,
        run.unchangedSince ? { unchangedSince: run.unchangedSince } : undefined,
      );
    } catch (error) {
      if (error instanceof AgentChangedError) throw new ProposalStaleError();
      throw error;
    }
    await botTrail(run, "bot.updated", agentId, {
      name: updated.name,
      visibility: updated.visibility,
    });
    return done(`已更新员工「${updated.name}」。`);
  }

  async function setPortrait(
    run: Run,
    agentId: string,
    preset: PortraitPreset,
  ): Promise<Outcome> {
    const profile = await deps.profiles.get(run.agentActor, agentId);
    if (!profile || !canManageAgent(run.agentActor, profile))
      return failed("你不能修改这位员工的头像。");
    await deps.portraits.set("coworker", agentId, { preset }, run.actor.id);
    return done("已换好头像。");
  }

  /**
   * 技能按现有的授予规则：管理员（此刻持有能力）可以装任何技能；其余的人只能装在自己的员工上，装自己写的，
   * 或管理员上架了的部署技能（自助安装，记成主人的）。
   */
  async function giveSkill(
    run: Run,
    agentId: string,
    slug: string,
  ): Promise<Outcome> {
    const owner = await deps.plugins.skillOwner(slug);
    if (owner === undefined) return failed(`没有叫「${slug}」的技能。`);
    const by = run.actor.email;
    if (run.agentActor.role === "admin") {
      await deps.plugins.grant("skill", slug, agentId, by);
      return done(`已装上技能「${slug}」。`);
    }
    if ((await deps.plugins.agentOwner(agentId)) !== run.actor.id)
      return failed("只能给你自己的员工装技能。");
    if (owner === run.actor.id) {
      await deps.plugins.grant("skill", slug, agentId, by);
      return done(`已装上技能「${slug}」。`);
    }
    if (owner === null && (await deps.plugins.isInstallListed("skill", slug))) {
      await deps.plugins.grant("skill", slug, agentId, by, {
        selfService: true,
      });
      return done(`已装上技能「${slug}」。`);
    }
    return failed(
      owner === null
        ? `「${slug}」是部署的技能，由管理员决定给哪些员工。`
        : `「${slug}」是别人的技能。`,
    );
  }

  /** 员工已经持有的应用动作与各自是谁给的，在本人的帧里读。 */
  async function heldActions(agentId: string): Promise<Map<string, string>> {
    const rows = await deps.database
      .select({ ref: pluginGrants.ref, grantedAs: pluginGrants.grantedAs })
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.agentId, agentId), eq(pluginGrants.kind, "mcp")),
      );
    return new Map(rows.map((row) => [row.ref, row.grantedAs ?? ""]));
  }

  /** 主人给出 Shared 应用时设下谁可以经这位员工用团队账号（同 `POST /give`）。 */
  async function approveShared(
    run: Run,
    agentId: string,
    inspected: AppInspection,
  ) {
    if (!deps.shared || !inspected.answeringId) return;
    try {
      await approveOwnersSharedUse(deps.shared.audience, deps.shared.store, {
        botId: agentId,
        serverId: inspected.answeringId,
        ownerId: run.actor.id,
      });
    } catch (error) {
      // 这之间应用被切走了模式：不设受众（闭合的方向），授予照常。
      if (!(error instanceof SharedUseNotSharedError)) throw error;
    }
  }

  /** 应用的动作里这次要给的：草稿点名了就只要点名的，没点名就是全部可给的。 */
  async function toolsToGive(
    inspected: AppInspection,
    actions: readonly string[],
    giveable: (tool: { effect: string; destructive: boolean }) => boolean,
  ): Promise<string[]> {
    const server = (await deps.plugins.listServers()).find(
      (candidate) => candidate.id === inspected.answeringId,
    );
    const key = inspected.access.key;
    return (server?.tools ?? [])
      .filter(giveable)
      .map((tool) => tool.ref)
      .filter(
        (ref) =>
          actions.length === 0 ||
          actions.some(
            (action) => ref === action || ref === `${key}/${action}`,
          ),
      );
  }

  /**
   * 一个应用，与员工页上的「给」、管理员的授予、访问申请是同一套判断：
   * - 本人自己能给的（`ownerGrantRefusal` 为 null）：照「给」的做法给只读、非破坏性的动作（内置应用给全部），
   *   标成主人的授予；跑在本人账号上、本人还没连接的，记「需要先连接」。
   * - 此刻持有能力的管理员，在自己的员工上：照管理员的授予给。
   * - 其余：向管理员提申请，类型由服务端按状态定，记「已申请」。
   */
  async function giveApp(
    run: Run,
    agentId: string,
    entry: { app: string; actions: string[] },
    options: { request?: boolean } = {},
  ): Promise<Outcome> {
    const inspected = await deps.plugins.inspectApp({
      app: entry.app,
      agentId,
      userId: run.actor.id,
      composioConfigured: deps.composioConfigured,
      ...(deps.directory ? { directory: deps.directory } : {}),
      ownerView: true,
    });
    if (!inspected || !(inspected.vouched || inspected.access.granted))
      return failed(`这个部署没有叫「${entry.app}」的应用。`);
    const name = inspected.access.displayName;
    const key = inspected.access.key;
    const by = run.actor.email;
    // 持有是按应用算的，持有一个动作不等于持有草稿点名的那个：按动作比，只补还没有的。
    const held = await heldActions(agentId);

    const refusal = await ownerGrantRefusal(
      deps.plugins,
      run.actor.id,
      agentId,
      inspected,
    );
    if (refusal === null) {
      const builtin = inspected.entry?.auth.kind === "builtin";
      const refs = await toolsToGive(
        inspected,
        entry.actions,
        (tool) => builtin || (tool.effect === "read" && !tool.destructive),
      );
      if (refs.length === 0)
        return failed(`「${name}」里没有你可以直接给员工的动作。`);
      const missing = refs.filter((ref) => !held.has(ref));
      for (const ref of missing)
        await deps.plugins.grant("mcp", ref, agentId, by, { as: "owner" });
      if (missing.length > 0)
        await deps.plugins.recordAppAccessEvent({
          eventType: "app_access.owner_granted",
          targetId: key,
          actorUserId: run.actor.id,
          payload: {
            app: key,
            bot: agentId,
            refs: missing,
            proposalId: run.proposalId,
          },
        });
      if (missing.length > 0 || inspected.access.givenByOwner)
        await approveShared(run, agentId, inspected);
      // 草稿点名、但不是本人能直接给的动作（会写、会发的），照实说出来，不当作给了。
      const left = entry.actions.filter(
        (action) =>
          !refs.some((ref) => ref === action || ref === `${key}/${action}`),
      );
      const base =
        missing.length === 0
          ? `员工已经有「${name}」了`
          : `已把「${name}」给员工`;
      const given =
        left.length === 0
          ? base
          : `${base}（只给了只读动作；${left.join("、")} 这些动作要由管理员单独授予）`;
      const unconnected =
        inspected.access.needsConnect ||
        (inspected.access.granted &&
          (inspected.access.state === "not_connected" ||
            inspected.access.state === "reconnect"));
      return unconnected
        ? {
            outcome: "needs_connection",
            message: `${given}；你连接自己的账号之后它才能用。`,
            // 卡片的「去连接」按这个键打开连接页；草稿里的叫法可能是标题或别名，那里认不出来。
            target: key,
          }
        : done(`${given}。`);
    }

    if (
      run.agentActor.role === "admin" &&
      inspected.unavailable === null &&
      inspected.answeringId !== null &&
      (await deps.plugins.agentOwner(agentId)) === run.actor.id
    ) {
      const refs = await toolsToGive(
        inspected,
        entry.actions,
        (tool) =>
          entry.actions.length > 0 ||
          (tool.effect === "read" && !tool.destructive),
      );
      if (refs.length === 0)
        return failed(`「${name}」没有标为只读的动作，请在插件页逐个选择。`);
      const missing = refs.filter((ref) => !held.has(ref));
      for (const ref of missing)
        await deps.plugins.grant("mcp", ref, agentId, by);
      return done(
        missing.length === 0
          ? `员工已经有「${name}」了。`
          : `已把「${name}」给员工。`,
      );
    }

    // 已经持有这个应用时申请不了单个动作：没点名或点名的都有了就是已经有，否则照实说要找管理员。
    if (inspected.access.granted) {
      const lacking = entry.actions.filter(
        (action) =>
          ![...held.keys()].some(
            (ref) => ref === action || ref === `${key}/${action}`,
          ),
      );
      return lacking.length === 0
        ? done(`员工已经有「${name}」了。`)
        : failed(`「${name}」的 ${lacking.join("、")} 要由管理员单独授予。`);
    }

    // 不替人提申请的一项（见 `giveStaffingTools`）：照实说为什么本人给不了。
    if (options.request === false) return failed(refusal);

    // 申请只为本人能用的员工提，同浏览器里的申请入口。
    const bot = await deps.profiles.get(run.agentActor, agentId);
    if (!bot || !canRunAgent(run.agentActor, bot))
      return failed("找不到这位员工。");
    const plan = requestPlanFor(inspected);
    if (plan.refused === "no_such_app")
      return failed(`这个部署没有叫「${entry.app}」的应用。`);
    if (plan.refused === "own_app")
      return failed(
        `「${name}」是你自己添加的应用，请在插件页自己把它装到这位员工上。`,
      );
    if (plan.refused !== undefined)
      return failed(nothingToRequest(plan.access));
    const filed = await deps.plugins.fileAppAccessRequest({
      serverId: plan.serverId,
      ...(plan.serverId === null
        ? { appKey: plan.access.key, appTitle: plan.access.displayName }
        : {}),
      botId: agentId,
      requesterUserId: run.actor.id,
      kind: plan.kind,
      note: null,
      maxPending: MAX_PENDING_APP_ACCESS_REQUESTS,
    });
    if (filed.outcome === "limited")
      return failed(
        `你已经有 ${MAX_PENDING_APP_ACCESS_REQUESTS} 条申请在等管理员处理，「${name}」这次没有申请。`,
      );
    return {
      outcome: "requested",
      message: `「${name}」要管理员批准，已替你提了申请。`,
    };
  }

  /** 收回本人在一个应用上给员工的（同员工页的「收回」）；管理员做的授予不动。 */
  async function takeApp(
    run: Run,
    agentId: string,
    entry: { app: string; actions: string[] },
  ): Promise<Outcome> {
    const app = entry.app;
    const refusal = await personalRevokeRefusalFor(
      deps.plugins,
      "mcp",
      app,
      agentId,
    );
    if (refusal) return failed(refusal);
    if ((await deps.plugins.agentOwner(agentId)) !== run.actor.id)
      return failed("只能改你自己的员工的应用。");
    const inspected = await deps.plugins.inspectApp({
      app,
      agentId,
      userId: run.actor.id,
      composioConfigured: deps.composioConfigured,
      ...(deps.directory ? { directory: deps.directory } : {}),
    });
    if (!inspected) return failed(`这个部署没有叫「${app}」的应用。`);
    if (entry.actions.length > 0)
      return takeActions(run, agentId, inspected, entry.actions);
    const ids = [
      ...new Set([
        inspected.access.key,
        ...inspected.rowIds,
        ...(inspected.answeringId ? [inspected.answeringId] : []),
      ]),
    ];
    const refs = await deps.plugins.revokeOwnerGrants(
      ids,
      agentId,
      run.actor.email,
    );
    // 主人的授予设下的团队账号受众一起撤回；管理员批准的留着（同 `DELETE /give`）。
    if (deps.shared && inspected.answeringId)
      await withdrawOwnersSharedUse(deps.shared.audience, deps.shared.store, {
        serverId: inspected.answeringId,
        botId: agentId,
        actorId: run.actor.id,
      });
    const name = inspected.access.displayName;
    if (refs.length === 0)
      return failed(`「${name}」上没有你给这位员工的动作可以收回。`);
    await deps.plugins.recordAppAccessEvent({
      eventType: "app_access.owner_revoked",
      targetId: inspected.access.key,
      actorUserId: run.actor.id,
      payload: {
        app: inspected.access.key,
        bot: agentId,
        refs,
        proposalId: run.proposalId,
      },
    });
    return done(`已收回「${name}」。`);
  }

  /**
   * 只收回点名的动作，而且只收本人给的；管理员给的不动。这个应用上本人给的一个都不剩时，再撤回它设下的
   * 团队账号受众（同整个应用收回）。
   */
  async function takeActions(
    run: Run,
    agentId: string,
    inspected: AppInspection,
    actions: readonly string[],
  ): Promise<Outcome> {
    const key = inspected.access.key;
    const name = inspected.access.displayName;
    const held = await heldActions(agentId);
    const named = [
      ...new Set(
        actions.map((action) =>
          action.startsWith(`${key}/`) ? action : `${key}/${action}`,
        ),
      ),
    ];
    const mine = named.filter((ref) => held.get(ref) === "owner");
    const others = named.filter(
      (ref) => held.has(ref) && held.get(ref) !== "owner",
    );
    for (const ref of mine)
      await deps.plugins.revoke("mcp", ref, agentId, run.actor.email);
    const ownersLeft = [...held].filter(
      ([ref, grantedAs]) =>
        ref.startsWith(`${key}/`) &&
        grantedAs === "owner" &&
        !mine.includes(ref),
    );
    if (ownersLeft.length === 0 && deps.shared && inspected.answeringId)
      await withdrawOwnersSharedUse(deps.shared.audience, deps.shared.store, {
        serverId: inspected.answeringId,
        botId: agentId,
        actorId: run.actor.id,
      });
    if (mine.length === 0)
      return failed(
        others.length > 0
          ? `「${name}」的这些动作是管理员给的，只有管理员可以收回。`
          : `「${name}」上没有你给这位员工的这些动作可以收回。`,
      );
    await deps.plugins.recordAppAccessEvent({
      eventType: "app_access.owner_revoked",
      targetId: key,
      actorUserId: run.actor.id,
      payload: {
        app: key,
        bot: agentId,
        refs: mine,
        proposalId: run.proposalId,
      },
    });
    return done(
      others.length === 0
        ? `已收回「${name}」的 ${mine.join("、")}。`
        : `已收回「${name}」的 ${mine.join("、")}；${others.join("、")} 是管理员给的，没有动。`,
    );
  }

  /** 定时任务发在本人与这位员工的单独对话里；还没有这样的对话就开一个。 */
  async function addRoutine(
    run: Run,
    agentId: string,
    routine: RoutineDraft,
  ): Promise<Outcome> {
    const channel = await deps.channels.direct(run.agentActor, agentId);
    await deps.routines.create({
      ownerUserId: run.actor.id,
      agentId,
      channelId: channel.id,
      instruction: routine.instruction,
      ...(routine.title ? { title: routine.title } : {}),
      cron: routine.cron,
      ...(routine.timezone ? { timezone: routine.timezone } : {}),
    });
    return done(`已建好定时任务「${routine.title ?? routine.cron}」。`);
  }

  async function removeRoutine(
    run: Run,
    agentId: string,
    routineId: string,
  ): Promise<Outcome> {
    const mine = await deps.routines.listFor(run.actor.id);
    if (!mine.some((row) => row.id === routineId && row.agentId === agentId))
      return failed("这位员工没有这个定时任务。");
    await deps.routines.remove(run.actor.id, routineId);
    return done("已删除定时任务。");
  }

  /**
   * 「也给它招聘与组群能力」：和员工页上给任何应用同一条路（`giveApp`）——部署里有没有这个应用、管理员是否
   * 把它收归自己（`owner_grants = admin`）、是否对这个人关掉了「把自己的应用给自己的员工」，都按此刻的答案。
   * 本人给不了时照实说原因，不替人向管理员提申请：这是卡片上一个默认不勾的选项，不是本人点名要的应用；
   * 真要的话，本人在员工页上申请。
   */
  async function giveStaffingTools(
    run: Run,
    agentId: string,
  ): Promise<Outcome> {
    return giveApp(
      run,
      agentId,
      { app: STAFFING_APP, actions: [] },
      { request: false },
    );
  }

  /** 建好员工之后的各步，顺序固定：重试按位置对上上一次的结果。 */
  function employeeSteps(
    run: Run,
    agentId: string,
    draft: EmployeeDraft,
  ): Step[] {
    const steps: Step[] = [];
    if (draft.model) {
      const model = draft.model;
      steps.push({
        step: "model",
        target: "modelRef" in model ? model.modelRef : model.platformModelRef,
        run: () => updateFrom(run, agentId, { model }),
      });
    }
    if (draft.avatar && "preset" in draft.avatar) {
      const preset = draft.avatar.preset;
      steps.push({
        step: "avatar",
        target: preset,
        run: () => setPortrait(run, agentId, preset),
      });
    }
    steps.push(...grantSteps(run, agentId, draft.skills, draft.apps));
    for (const routine of draft.routines)
      steps.push({
        step: "routine",
        target: routine.title ?? routine.cron,
        run: () => addRoutine(run, agentId, routine),
      });
    if (draft.staffingTools)
      steps.push({
        step: "staffing_tools",
        run: () => giveStaffingTools(run, agentId),
      });
    return steps;
  }

  function grantSteps(
    run: Run,
    agentId: string,
    skillList: readonly string[] = [],
    appList: readonly { app: string; actions: string[] }[] = [],
  ): Step[] {
    return [
      ...skillList.map((slug) => ({
        step: "skill",
        target: slug,
        run: () => giveSkill(run, agentId, slug),
      })),
      ...appList.map((entry) => ({
        step: "app",
        target: entry.app,
        run: () => giveApp(run, agentId, entry),
      })),
    ];
  }

  function employeeChangeSteps(run: Run, draft: EmployeeChangeDraft): Step[] {
    const { agentId, set } = draft;
    const steps: Step[] = [];
    const seed = set.avatar && "seed" in set.avatar;
    if (seed || PROFILE_FIELDS.some((field) => set[field] !== undefined))
      steps.push({
        step: "update",
        target: agentId,
        run: () => updateFrom(run, agentId, set),
      });
    if (set.avatar && "preset" in set.avatar) {
      const preset = set.avatar.preset;
      steps.push({
        step: "avatar",
        target: preset,
        run: () => setPortrait(run, agentId, preset),
      });
    }
    steps.push(...grantSteps(run, agentId, set.skills, set.apps));
    for (const entry of draft.appsRemove)
      steps.push({
        step: "app_remove",
        target: entry.app,
        run: () => takeApp(run, agentId, entry),
      });
    for (const routine of set.routines ?? [])
      steps.push({
        step: "routine",
        target: routine.title ?? routine.cron,
        run: () => addRoutine(run, agentId, routine),
      });
    for (const routineId of draft.routinesRemove)
      steps.push({
        step: "routine_remove",
        target: routineId,
        run: () => removeRoutine(run, agentId, routineId),
      });
    return steps;
  }

  /**
   * 建群前先看每位成员本人此刻还能不能用：起草之后改成私有或被删掉的，点名说出来，不建一个缺人的群。
   * 员工已经看不见时读不到它的名字，只能用 id 点名。
   */
  function groupSteps(
    run: Run,
    draft: GroupDraft,
    previous: readonly ResultItem[],
  ): Step[] {
    const made = previous[0];
    let channelId =
      made && made.outcome !== "failed" ? (made.target ?? null) : null;
    return [
      {
        step: "group",
        run: async () => {
          const gone: string[] = [];
          for (const member of draft.members) {
            const profile = await deps.profiles.get(run.agentActor, member);
            if (!profile || !canRunAgent(run.agentActor, profile))
              gone.push(member);
          }
          if (gone.length > 0)
            return failed(
              `员工 ${gone.join("、")} 已经不能用了（可能改成了私有或被删除），群聊没有建。`,
            );
          const channel = await deps.groups.create(run.actor.id, {
            agentIds: draft.members,
          });
          channelId = channel.id;
          return done("已建好群聊。", channel.id);
        },
      },
      {
        step: "rename",
        target: draft.name,
        run: async () => {
          if (!channelId) return failed("群聊没有建成，所以没有改名。");
          await deps.channels.rename(run.agentActor, channelId, draft.name);
          return done(`群聊已命名为「${draft.name}」。`);
        },
      },
    ];
  }

  function groupChangeSteps(run: Run, draft: GroupChangeDraft): Step[] {
    const { channelId } = draft;
    const steps: Step[] = [];
    const name = draft.name;
    if (name !== undefined)
      steps.push({
        step: "rename",
        target: name,
        run: async () => {
          await deps.channels.rename(run.agentActor, channelId, name);
          return done(`群聊已改名为「${name}」。`);
        },
      });
    if (draft.add.length > 0)
      steps.push({
        step: "add",
        target: draft.add.join(","),
        run: async () => {
          await deps.groups.addBots(run.actor.id, channelId, draft.add);
          return done("已把员工加进群里。");
        },
      });
    if (draft.remove.length > 0)
      steps.push({
        step: "remove",
        target: draft.remove.join(","),
        run: async () => {
          await deps.groups.removeBots(run.actor.id, channelId, draft.remove);
          return done("已把员工移出群聊。");
        },
      });
    const order = draft.order;
    if (order !== undefined)
      steps.push({
        step: "reorder",
        target: order.join(","),
        run: async () => {
          await deps.groups.reorder(run.actor.id, channelId, order);
          return done("已调整员工的回答顺序。");
        },
      });
    return steps;
  }

  /** 逐步做；上一次已经成了的步骤原样留着，只重做失败的。 */
  async function runSteps(
    steps: readonly Step[],
    previous: readonly ResultItem[],
    results: ResultItem[],
    progress: () => Promise<void>,
  ): Promise<void> {
    for (const [index, step] of steps.entries()) {
      const before = previous[index];
      if (before && before.outcome !== "failed") {
        results.push(before);
        continue;
      }
      let outcome: Outcome;
      try {
        outcome = await step.run();
      } catch (error) {
        // 内容已变化不是一步的失败：整份提议不执行，交给调用方放回待确认。
        if (error instanceof ProposalStaleError) throw error;
        outcome = failed(reasonOf(error));
      }
      results.push({
        step: step.step,
        ...(step.target === undefined ? {} : { target: step.target }),
        ...outcome,
      });
      await progress();
    }
  }

  /**
   * 建员工：创建员工那条路径的检查、名额（与写入同一个事务里数）、角色模板。失败时什么都没建，由调用方
   * 放回待确认。
   */
  async function createEmployee(
    run: Run,
    draft: EmployeeDraft,
  ): Promise<ResultItem> {
    const checked = checkedInput({
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
    if (!checked.ok) throw new ProposalRefusedError(checked.error);
    const refused = await capabilityRefusal(run, checked.value.visibility);
    if (refused) throw new ProposalRefusedError(refused, true);
    const template = draft.roleTemplate;
    if (template && (!UUID.test(template.id) || template.version < 1))
      throw new ProposalRefusedError("所选角色模板无效，请重新选择。");
    const quota = deps.quota;
    const input = checked.value;
    const agent = await deps.profiles.create(
      run.agentActor,
      {
        ...input,
        // 没有地址的员工就在这里跑，跑的就是职责描述（同 `POST /api/agents`）。
        systemPrompt: input.roleDescription,
        ...(template ? { roleTemplate: template } : {}),
      },
      quota
        ? (transaction) =>
            quota.assertCapacityWithin(transaction, run.actor.id, "wakers")
        : undefined,
    );
    await botTrail(run, "bot.created", agent.id, {
      name: input.name,
      visibility: input.visibility,
      hasKey: false,
    });
    return {
      step: "create",
      target: agent.id,
      outcome: "done",
      message: `已建好员工「${agent.name}」。`,
    };
  }

  /** 草稿按这一行自己的种类重新校验一遍：种类与草稿的形状不受类型约束。 */
  function draftOf(proposal: Proposal): ProposalDraft {
    const parsed = parseDraft(proposal.kind, proposal.draft);
    if (!parsed.ok) throw new ProposalRefusedError(parsed.error);
    return parsed.draft;
  }

  async function ownProposal(actor: AuthenticatedActor, proposalId: string) {
    const proposal = await deps.proposals.get(proposalId);
    // 别人的提议与不存在的一个样，不让人借答复探出别人有没有提议。
    if (!proposal || proposal.ownerId !== actor.id)
      throw new ProposalNotFoundError();
    return proposal;
  }

  /** 起草之后对象被改过就不执行：版本对不上，或者对象已经看不见了。 */
  async function assertFresh(
    actor: AuthenticatedActor,
    proposal: Proposal,
    draft: ProposalDraft,
  ) {
    if (proposal.kind === "employee_change") {
      const { agentId } = draft as EmployeeChangeDraft;
      const now = await currentEmployeeVersion(deps.database, agentId);
      if (now === null || now !== proposal.baseVersion)
        throw new ProposalStaleError();
    }
    if (proposal.kind === "group_change") {
      const { channelId } = draft as GroupChangeDraft;
      const now = await currentGroupVersion(
        deps.database,
        deps.groups.store,
        actor.id,
        channelId,
      );
      if (now === null || now !== proposal.baseVersion)
        throw new ProposalStaleError();
    }
  }

  /**
   * 做一遍提议。`previous` 是上一次的结果：重试时按位置对上，已成的留着，只重做失败的。新员工的第一项是
   * 建员工本身；重试时从它取员工 id，不再建第二个。
   */
  async function carryOut(
    run: Run,
    proposal: Proposal,
    draft: ProposalDraft,
    previous: readonly ResultItem[],
    results: ResultItem[],
    progress: () => Promise<void>,
  ): Promise<void> {
    switch (proposal.kind) {
      case "employee": {
        const created = previous[0];
        if (!created?.target) throw new ProposalStateError();
        results.push(created);
        await runSteps(
          employeeSteps(run, created.target, draft as EmployeeDraft),
          previous.slice(1),
          results,
          progress,
        );
        return;
      }
      case "employee_change":
        return runSteps(
          employeeChangeSteps(run, draft as EmployeeChangeDraft),
          previous,
          results,
          progress,
        );
      case "group":
        return runSteps(
          groupSteps(run, draft as GroupDraft, previous),
          previous,
          results,
          progress,
        );
      case "group_change":
        return runSteps(
          groupChangeSteps(run, draft as GroupChangeDraft),
          previous,
          results,
          progress,
        );
    }
  }

  /**
   * 做完并落定。每一步自己接住错误，能从这里抛出的是意料之外的（数据库断开之类）；那时提议也不能停在
   * `applying`：什么都还没做就放回待确认，做了一部分就把已有的结果（含建好的员工）记成部分完成，没走到的
   * 步骤在重试时补上。
   */
  async function settle(
    run: Run,
    proposal: Proposal,
    draft: ProposalDraft,
    previous: readonly ResultItem[],
  ): Promise<Proposal> {
    const results: ResultItem[] = [];
    const sofar = () => [...results, ...previous.slice(results.length)];
    // 每做完一步记一次：建好的员工最先落库，之后哪一步出了意外，行里都有到此为止做成了什么。
    const progress = async () => {
      await deps.proposals.recordProgress(proposal.id, sofar());
    };
    try {
      if (previous.length > 0) await progress();
      await carryOut(run, proposal, draft, previous, results, progress);
      // 落定也在这里面：它自己出错时同样走下面的退路，不让提议停在执行中。
      return await finish(run, proposal, results);
    } catch (error) {
      const kept = sofar();
      try {
        if (kept.length === 0)
          await deps.proposals.release(proposal.id, run.actor.id);
        else
          await deps.proposals.finish(proposal.id, "partially_applied", kept);
      } catch (fallback) {
        // 退路也走不通（数据库断开）：行留在执行中，读的人在 `STALE_APPLYING_MS` 之后把它落定。
        console.error(
          JSON.stringify({
            type: "staffing-settle-failed",
            proposalId: proposal.id,
            error: String(fallback),
          }),
        );
      }
      throw error;
    }
  }

  async function finish(
    run: Run,
    proposal: Proposal,
    results: ResultItem[],
  ): Promise<Proposal> {
    const status = results.every((item) => SUCCEEDED.has(item.outcome))
      ? "applied"
      : "partially_applied";
    const finished = await deps.proposals.finish(proposal.id, status, results);
    await audit(run.actor, {
      eventType:
        status === "applied"
          ? "staffing.proposal_applied"
          : "staffing.proposal_partially_applied",
      targetType: "staffing_proposal",
      targetId: proposal.id,
      payload: {
        proposalId: proposal.id,
        kind: proposal.kind,
        steps: results.map(({ step, target, outcome }) => ({
          step,
          ...(target === undefined ? {} : { target }),
          outcome,
        })),
      },
    });
    return finished;
  }

  return {
    /**
     * 确认执行。先原子地认领（连点两次只做一次，过期的答过期），再校验草稿、比对版本；这两样不过，或建员工
     * 失败（名额满等），什么都没改，提议放回待确认，错误交给路由。
     */
    async apply(
      actor: AuthenticatedActor,
      proposalId: string,
    ): Promise<Proposal> {
      await ownProposal(actor, proposalId);
      const claimed = await deps.proposals.claim(proposalId, actor.id);
      const run: Run = {
        actor,
        agentActor: agentActorOf(actor),
        proposalId,
        ...(claimed.kind === "employee_change" && claimed.baseVersion
          ? { unchangedSince: new Date(claimed.baseVersion) }
          : {}),
      };
      let draft: ProposalDraft;
      let created: ResultItem[];
      try {
        draft = draftOf(claimed);
        await assertFresh(actor, claimed, draft);
        // 建员工先做、先记下：之后哪一步出了意外，结果里也有员工 id，重试不会再建一个。
        created =
          claimed.kind === "employee"
            ? [await createEmployee(run, draft as EmployeeDraft)]
            : [];
      } catch (error) {
        await deps.proposals.release(proposalId, actor.id);
        throw error;
      }
      return settle(run, claimed, draft, created);
    },

    /** 重做上一次失败的项；成了的项和建好的员工、群聊都不再动。不比对版本：对象正是上一次改的。 */
    async retry(
      actor: AuthenticatedActor,
      proposalId: string,
    ): Promise<Proposal> {
      await ownProposal(actor, proposalId);
      const reopened = await deps.proposals.reopenFailed(proposalId, actor.id);
      const previous = reopened.result ?? [];
      const run: Run = {
        actor,
        agentActor: agentActorOf(actor),
        proposalId,
      };
      let draft: ProposalDraft;
      try {
        // 没有上一次的结果就没有可重做的；新员工尤其不能因此再建一个。
        if (previous.length === 0) throw new ProposalStateError();
        draft = draftOf(reopened);
      } catch (error) {
        // 什么都没重做：结果照旧，提议回到可以再试的状态。
        await deps.proposals.finish(proposalId, "partially_applied", previous);
        throw error;
      }
      return settle(run, reopened, draft, previous);
    },
  };
}

export type StaffingExecutor = ReturnType<typeof createStaffingExecutor>;
