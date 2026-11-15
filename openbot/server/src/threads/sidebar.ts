import {
  type ContextUsage,
  type ConversationSidebar,
  SIDEBAR_OUTPUT_LIMIT,
  type SidebarCompaction,
  type SidebarContext,
  type SidebarEnvironment,
  type SidebarGoal,
  type SidebarGoalStatus,
  type SidebarMemberStatus,
  type SidebarOutput,
} from "@openbot/shared/conversation-sidebar";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  min,
} from "drizzle-orm";
import { ownerOfBotRow } from "../agents/bot-owner";
import { readAgentPresence } from "../agents/presence";
import { agentAccessFilter } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  approvalRequests,
  attachments,
  channelAgents,
  channelMemberships,
  channels,
  groupBotThreads,
  groupMessages,
  intelligenceChannelMappings,
  modelRegistry,
  modelTokenCalls,
  OFFLINE_AFTER_MS,
  platformModelPool,
  projectContextBindings,
  registeredDevices,
  resourceProjects,
  tasks,
  threadCompactions,
  threadRuns,
  threads,
} from "../db/schema";
import type { MachineTarget } from "../projects/context";
import { isDeliverableRef } from "../tasks/projector";
import { isPersonTenant, runAsTenant } from "../tenant/context";
import {
  contextUsageFrom,
  contextUsageKey,
  type ReadContextUsageDeps,
  readContextUsages,
} from "./context-usage";

/**
 * 对话侧栏（环境 · 目标 · 上下文 · 输出内容）的读取：单聊按线程，群组按频道，一次给四块。
 *
 * 看得到才给：查看者是这个频道的成员、频道没删，按线程问时这条线程还得是查看者自己的（单聊里他的那条
 * 映射，或群组里他和某位员工的那条）。看不到、不存在、员工不在这个对话里，一律回 null（路由答 404），
 * 不说为什么。
 *
 * 所有读都在查看者自己的租户帧里（行级安全照常生效），只有一处例外：员工的计量行写在哪个租户就去哪个
 * 租户读（{@link SidebarDeps.meteringTenants}，员工用主人的模型库时是主人），而且只在上面的可见性检查过了
 * 之后、只按这条线程 + 这位员工过滤。分类比例仍在查看者名下读（它记在发起运行的人名下）。
 *
 * 群组的口径：环境的成员列表按群组频道取；目标、输出内容按查看者取（频道 + 他自己的各条员工线程上、他
 * 名下的任务卡）；上下文按「查看者 × 每位员工」各自那条 `group_bot_threads` 线程取。
 *
 * 前端每 15 秒刷新一次，所以群组按线程批量读：计量租户、用量、比例、压缩记录、设备各一次，查询条数不随
 * 员工数增长；带 `?agentId=` 的明细直接用算好的那一份。读接口不改任何状态（设备只 peek，不挑）。
 */

export type SidebarDeps = {
  database: Database;
  /** 内置员工在哪跑（`config.tenantRuntime`）。 */
  runtime: "cloud" | "device";
  /** 没绑模型的员工用的部署默认模型（`provider/model`）；没有时为 null。 */
  deploymentModelLabel: string | null;
  contextWindowFor: ReadContextUsageDeps["contextWindowFor"];
  /**
   * 每位员工这一轮的模型调用记在哪个租户名下，在查看者的帧里一次问完（`meteringTenantsFor`）；不是个人
   * 租户的答案按查看者读。按员工当前的绑定判断：换绑前记在别的租户的调用，下一轮跑之前看不到。
   */
  meteringTenants: (
    agentIds: readonly string[],
  ) => Promise<Map<string, string | null>>;
  /**
   * 设备模式下内置员工的动作会落在哪台电脑，只读（`deviceSelector.peek`，不留下选择）；云端模式不给。
   */
  machinesOf?: (
    agentIds: readonly string[],
  ) => Promise<Map<string, MachineTarget>>;
};

export type ConversationSidebarService = {
  /** 单聊的线程，或查看者在群组里和某位员工的那条线程；`agentId` 选同一线程里的另一位员工。 */
  forThread(
    viewer: AgentActor,
    threadId: string,
    agentId?: string,
  ): Promise<ConversationSidebar | null>;
  /** 群组（或单聊）频道；群组里 `agentId` 取那位员工的上下文明细。 */
  forChannel(
    viewer: AgentActor,
    channelId: string,
    agentId?: string,
  ): Promise<ConversationSidebar | null>;
  /**
   * 压缩会话压的是哪条线程：查看者在这个对话里和这位员工的那条（单聊是他的对话线程，群组是他和这位员工
   * 的 `group_bot_threads` 线程）。可见性与侧栏相同，看不到、员工不在对话里一律 null（路由答 404）；群组按
   * 频道问必须给 `agentId`。还没开过线程时 `threadId` 为 null。
   */
  compactionTarget(
    viewer: AgentActor,
    where: { threadId: string } | { channelId: string },
    agentId?: string,
  ): Promise<CompactionTargetOf | null>;
  /**
   * 一次压缩的摘要（「看摘要」）。记录在查看者名下，而且它压的那条线程正是查看者在这个对话里和那位员工的
   * 那条（同 {@link compactionTarget}）；否则 null（路由答 404）。
   */
  compaction(
    viewer: AgentActor,
    where: { threadId: string } | { channelId: string },
    compactionId: string,
  ): Promise<SidebarCompaction | null>;
};

/** {@link ConversationSidebarService.compactionTarget} 的答案；`external` 为外部员工（不压缩）。 */
export type CompactionTargetOf = {
  threadId: string | null;
  agentId: string;
  external: boolean;
};

/** 侧栏里读到的员工资料。 */
type Employee = {
  id: string;
  name: string;
  type: "built_in" | "remote_ag_ui" | "remote_mastra" | "device_acp";
  configuration: unknown;
  modelRef: string | null;
  platformModelRef: string | null;
  /** 员工的主人（个人租户），外部员工的电脑在他名下。 */
  owner: string | null;
};

/** 查看者能看到的一个频道。 */
type Conversation = {
  channelId: string;
  agentIds: string[];
  /** 查看者在这个频道的映射线程（单聊就是对话线程）；还没建时为 null。 */
  threadId: string | null;
};

type Device = {
  rowId: string;
  name: string;
  online: boolean;
  roots: { ref: string; name: string }[];
  apps: { ref: string; name: string }[];
};

/** 外部员工配置里侧栏用到的几项（外部员工规格第 1 节）。 */
type ExternalConfiguration = {
  deviceId: string | null;
  harness: string | null;
  appRef: string | null;
  workdirRef: string | null;
};

/** 一位员工在哪：所在电脑（查看者看得到时），设备模式内置员工另带电脑主人。 */
type Place = {
  device: Device | null;
  /** 设备模式内置员工那台电脑的主人；项目绑定在他名下。 */
  machineTenant: string | null;
  onComputer: boolean;
};

/** 一位员工在一条线程上的上下文，算一次，单聊、群组成员行和明细共用。 */
type AgentContext = {
  managedBy?: string;
  usage?: ContextUsage;
  compaction: NonNullable<SidebarContext["lastCompaction"]> | null;
};

/**
 * 远程员工（AG-UI / Mastra 端点）的上下文由对方系统自己管理：我们不计它的用量、不压缩它
 * （压缩接口对它答 409 external），所以侧栏和外部员工一样只写由谁管理，不出用量和压缩按钮。
 */
const REMOTE_MANAGED_BY = "对方系统";

/** 上下文不归我们管的员工由谁管理；内置员工为 null。 */
function managedByOf(employee: Employee, on: Device | null): string | null {
  if (employee.type === "built_in") return null;
  if (employee.type === "device_acp") return harnessLabel(employee, on);
  return REMOTE_MANAGED_BY;
}

const HARNESS_LABELS: Readonly<Record<string, string>> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  hermes: "Hermes",
};

const STATUS_WORDS: Readonly<Record<SidebarGoalStatus, string>> = {
  running: "进行中",
  needs_action: "等你确认",
  awaiting_review: "已完成，待查收",
  done: "已完成",
  failed: "失败",
};

/** 「上次检查」里员工回复第一句的长度上限（字）。 */
const LAST_CHECK_SENTENCE_LIMIT = 60;
/**
 * 输出内容最多看这么多张卡：侧栏只要最近的几条和总数。超过时 `total` 只数到这些卡为止（偏小）。
 */
const OUTPUT_CARD_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_USAGE = (): ContextUsage =>
  contextUsageFrom({ used: null, limit: null, shares: null, lastModel: null });

const deviceKey = (tenantId: string, deviceId: string) =>
  `${tenantId}\u0000${deviceId}`;

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((part) =>
        part &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
  return "";
}

/** 一段话的第一句：到第一个句末标点或换行为止，空白并成一个，长了截断加省略号。 */
export function firstSentence(text: string): string {
  const flat = text.trim();
  const end = flat.search(/[。！？!?\n]|\.(\s|$)/);
  const sentence = (end < 0 ? flat : flat.slice(0, end + 1))
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...sentence];
  return chars.length > LAST_CHECK_SENTENCE_LIMIT
    ? `${chars.slice(0, LAST_CHECK_SENTENCE_LIMIT).join("")}…`
    : sentence;
}

function externalConfiguration(value: unknown): ExternalConfiguration {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const text = (key: string) =>
    typeof record[key] === "string" && record[key] !== ""
      ? (record[key] as string)
      : null;
  return {
    deviceId: text("deviceId"),
    harness: text("harness"),
    appRef: text("appRef"),
    workdirRef: text("workdirRef"),
  };
}

function namedEntries(value: unknown): { ref: string; name: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const { ref, name } = (entry ?? {}) as { ref?: unknown; name?: unknown };
    return typeof ref === "string" && typeof name === "string"
      ? [{ ref, name }]
      : [];
  });
}

/** 外部员工的 harness 名：三家用固定名，custom 用设备上报的 app 名，取不到就用员工名。 */
function harnessLabel(employee: Employee, on: Device | null): string {
  const configuration = externalConfiguration(employee.configuration);
  if (configuration.harness && HARNESS_LABELS[configuration.harness])
    return HARNESS_LABELS[configuration.harness] as string;
  const app = on?.apps.find((entry) => entry.ref === configuration.appRef);
  return app?.name ?? employee.name;
}

export function createConversationSidebar(
  deps: SidebarDeps,
): ConversationSidebarService {
  const { database } = deps;

  /** 查看者是成员、没删的频道，连同它的员工和查看者自己的映射线程。 */
  async function conversation(
    viewer: AgentActor,
    channelId: string,
  ): Promise<Conversation | null> {
    const [channel] = await database
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, viewer.id),
        ),
      )
      .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
      .limit(1);
    if (!channel) return null;
    const agentRows = await database
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .where(eq(channelAgents.channelId, channelId))
      .orderBy(asc(channelAgents.agentId));
    const [mapping] = await database
      .select({ threadId: intelligenceChannelMappings.threadId })
      .from(intelligenceChannelMappings)
      .where(
        and(
          eq(intelligenceChannelMappings.channelId, channelId),
          eq(intelligenceChannelMappings.userId, viewer.id),
        ),
      )
      .limit(1);
    return {
      channelId,
      agentIds: agentRows.map((row) => row.agentId),
      threadId: mapping?.threadId ?? null,
    };
  }

  /** 查看者看得到的员工资料（同员工列表的规则），按 id。 */
  async function employees(
    viewer: AgentActor,
    agentIds: readonly string[],
  ): Promise<Map<string, Employee>> {
    const ids = [...new Set(agentIds)];
    if (ids.length === 0) return new Map();
    const rows = await database
      .select({
        id: agents.id,
        name: agents.name,
        type: agents.type,
        configuration: agents.configuration,
        tenantId: agents.tenantId,
        ownerUserId: agentProfiles.ownerUserId,
        modelRef: agentProfiles.modelRef,
        platformModelRef: agentProfiles.platformModelRef,
      })
      .from(agents)
      .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      .where(
        and(
          inArray(agents.id, ids),
          isNull(agentProfiles.deletedAt),
          agentAccessFilter(viewer),
        ),
      );
    return new Map(
      rows.map(({ tenantId, ownerUserId, ...row }) => [
        row.id,
        { ...row, owner: ownerOfBotRow({ tenantId, ownerUserId }) },
      ]),
    );
  }

  /** 一批电脑（主人租户 + 设备 id），一条查询；查看者看不到的不在结果里。 */
  async function devices(
    wanted: readonly { tenantId: string; deviceId: string }[],
  ): Promise<Map<string, Device>> {
    if (wanted.length === 0) return new Map();
    const keys = new Set(
      wanted.map((entry) => deviceKey(entry.tenantId, entry.deviceId)),
    );
    const rows = await database
      .select({
        rowId: registeredDevices.id,
        tenantId: registeredDevices.tenantId,
        deviceId: registeredDevices.deviceId,
        name: registeredDevices.name,
        lastSeenAt: registeredDevices.lastSeenAt,
        roots: registeredDevices.roots,
        apps: registeredDevices.apps,
      })
      .from(registeredDevices)
      .where(
        and(
          inArray(registeredDevices.tenantId, [
            ...new Set(wanted.map((entry) => entry.tenantId)),
          ]),
          inArray(registeredDevices.deviceId, [
            ...new Set(wanted.map((entry) => entry.deviceId)),
          ]),
        ),
      );
    return new Map(
      rows
        .filter((row) => keys.has(deviceKey(row.tenantId, row.deviceId)))
        .map((row) => [
          deviceKey(row.tenantId, row.deviceId),
          {
            rowId: row.rowId,
            name: row.name,
            online:
              row.lastSeenAt !== null &&
              Date.now() - row.lastSeenAt.getTime() < OFFLINE_AFTER_MS,
            roots: namedEntries(row.roots),
            apps: namedEntries(row.apps),
          },
        ]),
    );
  }

  /**
   * 每位员工在哪：外部员工是它配置里那台电脑（在员工主人名下找），设备模式内置员工是它的动作会落在的
   * 那台；电脑一次读完。
   */
  async function placesOf(
    people: readonly Employee[],
  ): Promise<Map<string, Place>> {
    const builtIns =
      deps.runtime === "device"
        ? people.filter((person) => person.type === "built_in")
        : [];
    const machines =
      builtIns.length > 0 && deps.machinesOf
        ? await deps
            .machinesOf(builtIns.map((person) => person.id))
            .catch(() => new Map<string, MachineTarget>())
        : new Map<string, MachineTarget>();
    const targets = new Map<string, MachineTarget>();
    for (const person of people) {
      if (person.type === "device_acp") {
        const { deviceId } = externalConfiguration(person.configuration);
        if (deviceId && person.owner)
          targets.set(person.id, { tenantId: person.owner, deviceId });
      } else {
        const machine = machines.get(person.id);
        if (machine) targets.set(person.id, machine);
      }
    }
    const found = await devices([...targets.values()]);
    return new Map(
      people.map((person) => {
        const target = targets.get(person.id);
        return [
          person.id,
          {
            device: target
              ? (found.get(deviceKey(target.tenantId, target.deviceId)) ?? null)
              : null,
            machineTenant:
              person.type === "built_in" ? (target?.tenantId ?? null) : null,
            onComputer:
              person.type === "device_acp" ||
              (person.type === "built_in" && deps.runtime === "device"),
          },
        ];
      }),
    );
  }

  async function modelLabel(employee: Employee): Promise<string | null> {
    if (employee.modelRef) {
      const [row] = await database
        .select({
          label: modelRegistry.label,
          modelName: modelRegistry.modelName,
          enabled: modelRegistry.enabled,
          credentialId: modelRegistry.credentialId,
        })
        .from(modelRegistry)
        .where(eq(modelRegistry.id, employee.modelRef))
        .limit(1);
      // 看不到、停用或没有钥匙的绑定：运行落回部署默认模型，这里也这么写。
      if (row?.enabled && row.credentialId) return row.label || row.modelName;
    } else if (employee.platformModelRef) {
      const [row] = await database
        .select({ label: platformModelPool.label })
        .from(platformModelPool)
        .where(eq(platformModelPool.id, employee.platformModelRef))
        .limit(1);
      if (row) return row.label;
    }
    return deps.deploymentModelLabel;
  }

  async function project(
    tenantId: string,
    agentId: string,
    deviceRowId: string,
  ): Promise<{ id: string; name: string } | null> {
    const [row] = await database
      .select({ id: resourceProjects.id, name: resourceProjects.name })
      .from(projectContextBindings)
      .innerJoin(
        resourceProjects,
        eq(resourceProjects.id, projectContextBindings.projectId),
      )
      .where(
        and(
          eq(projectContextBindings.tenantId, tenantId),
          eq(projectContextBindings.agentId, agentId),
          eq(projectContextBindings.deviceId, deviceRowId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** 单聊的环境：一位员工在哪、项目或工作文件夹、模型。 */
  async function environmentFor(
    employee: Employee | undefined,
    place: Place | undefined,
  ): Promise<SidebarEnvironment> {
    if (!employee)
      return {
        kind: deps.runtime === "device" ? "device" : "cloud",
        model: null,
      };
    const on = place?.device ?? null;
    if (employee.type === "device_acp") {
      const harness = harnessLabel(employee, on);
      const { workdirRef } = externalConfiguration(employee.configuration);
      return {
        kind: "device",
        ...(on ? { deviceName: on.name, online: on.online } : {}),
        workdirName:
          on?.roots.find((root) => root.ref === workdirRef)?.name ?? null,
        model: {
          label: `外部员工 · ${harness} · 用你自己的订阅`,
          external: { harness },
        },
      };
    }
    if (employee.type !== "built_in") return { kind: "cloud", model: null };
    const label = await modelLabel(employee);
    const model = label ? { label } : null;
    if (deps.runtime !== "device")
      return { kind: "cloud", project: null, model };
    return {
      kind: "device",
      ...(on ? { deviceName: on.name, online: on.online } : {}),
      project:
        on && place?.machineTenant
          ? await project(place.machineTenant, employee.id, on.rowId)
          : null,
      model,
    };
  }

  /**
   * 一批「员工 × 线程」的上下文：外部员工只说谁在管；其余的计量租户一次问完、用量和比例按租户批量读、
   * 压缩记录一条查询读完（在查看者名下）。
   */
  async function contextsOf(
    viewer: AgentActor,
    rows: readonly {
      agentId: string;
      employee: Employee | undefined;
      threadId: string | null;
    }[],
    places: Map<string, Place>,
  ): Promise<Map<string, AgentContext>> {
    const result = new Map<string, AgentContext>();
    const metered = rows.filter(
      (row): row is typeof row & { threadId: string } =>
        (!row.employee || row.employee.type === "built_in") &&
        row.threadId !== null,
    );
    const tenants =
      metered.length > 0
        ? await deps.meteringTenants([
            ...new Set(metered.map((row) => row.agentId)),
          ])
        : new Map<string, string | null>();
    const usages = await readContextUsages(
      metered.map((row) => {
        // 计量只写在某个人名下（计量表拒收别的租户），所以别的答案都按查看者读。
        const answered = tenants.get(row.agentId);
        return {
          tenantId: isPersonTenant(answered) ? answered : viewer.id,
          threadId: row.threadId,
          agentId: row.agentId,
        };
      }),
      { database, contextWindowFor: deps.contextWindowFor },
      { sharesTenantId: viewer.id },
    );
    const compactions =
      metered.length > 0
        ? new Map(
            (
              await database
                .selectDistinctOn(
                  [threadCompactions.threadId, threadCompactions.agentId],
                  {
                    id: threadCompactions.id,
                    threadId: threadCompactions.threadId,
                    agentId: threadCompactions.agentId,
                    auto: threadCompactions.auto,
                    summarizedCount: threadCompactions.summarizedCount,
                    createdAt: threadCompactions.createdAt,
                  },
                )
                .from(threadCompactions)
                .where(
                  and(
                    eq(threadCompactions.tenantId, viewer.id),
                    inArray(threadCompactions.threadId, [
                      ...new Set(metered.map((row) => row.threadId)),
                    ]),
                    inArray(threadCompactions.agentId, [
                      ...new Set(metered.map((row) => row.agentId)),
                    ]),
                  ),
                )
                .orderBy(
                  threadCompactions.threadId,
                  threadCompactions.agentId,
                  desc(threadCompactions.createdAt),
                )
            ).map((row) => [
              contextUsageKey(row.threadId, row.agentId),
              {
                id: row.id,
                auto: row.auto,
                at: row.createdAt.toISOString(),
                summarizedCount: row.summarizedCount,
              },
            ]),
          )
        : new Map<string, NonNullable<AgentContext["compaction"]>>();
    for (const row of rows) {
      const managedBy = row.employee
        ? managedByOf(row.employee, places.get(row.agentId)?.device ?? null)
        : null;
      if (managedBy) {
        result.set(row.agentId, { managedBy, compaction: null });
        continue;
      }
      const key = row.threadId
        ? contextUsageKey(row.threadId, row.agentId)
        : null;
      result.set(row.agentId, {
        usage: (key && usages.get(key)) || NO_USAGE(),
        compaction: (key && compactions.get(key)) || null,
      });
    }
    return result;
  }

  function perAgentOf(
    people: readonly Employee[],
    contexts: Map<string, AgentContext>,
  ): NonNullable<SidebarContext["perAgent"]> {
    return people.map((person) => {
      const context = contexts.get(person.id);
      if (context?.managedBy)
        return {
          agentId: person.id,
          name: person.name,
          used: null,
          limit: null,
          percent: null,
          managedBy: context.managedBy,
        };
      return {
        agentId: person.id,
        name: person.name,
        used: context?.usage?.used ?? null,
        limit: context?.usage?.limit ?? null,
        percent: context?.usage?.percent ?? null,
        compactedAt: context?.compaction?.at ?? null,
      };
    });
  }

  /** 明细：外部员工只有 `managedBy`，其余是用量和最近一次压缩。 */
  function detailOf(context: AgentContext | undefined): SidebarContext {
    if (context?.managedBy) return { managedBy: context.managedBy };
    return {
      usage: context?.usage ?? NO_USAGE(),
      lastCompaction: context?.compaction ?? null,
    };
  }

  /**
   * 这些任务卡上最新一个还挂着的审批（查看者自己的）。审批没记线程，挂在卡的 `pending_approval_id` 上，
   * 所以不只看最新那张卡：旧卡上挂着的也算。
   */
  async function pendingApproval(
    viewer: AgentActor,
    refs: readonly string[],
  ): Promise<string | null> {
    const [row] = await database
      .select({ id: approvalRequests.id })
      .from(tasks)
      .innerJoin(
        approvalRequests,
        eq(approvalRequests.id, tasks.pendingApprovalId),
      )
      .where(
        and(
          eq(tasks.tenantId, viewer.id),
          inArray(tasks.channelRef, [...refs]),
          eq(approvalRequests.ownerUserId, viewer.id),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .orderBy(desc(approvalRequests.createdAt))
      .limit(1);
    return row?.id ?? null;
  }

  async function goalOf(
    viewer: AgentActor,
    refs: readonly string[],
    threadIds: readonly string[],
    reply: () => Promise<string | null>,
  ): Promise<SidebarGoal> {
    const [card] = await database
      .select({ title: tasks.title, status: tasks.status })
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, viewer.id),
          inArray(tasks.channelRef, [...refs]),
        ),
      )
      .orderBy(desc(tasks.updatedAt))
      .limit(1);
    if (!card) return null;
    const [runs] =
      threadIds.length > 0
        ? await database
            .select({ value: count() })
            .from(threadRuns)
            .where(inArray(threadRuns.threadId, [...threadIds]))
        : [{ value: 0 }];
    const said = await reply();
    const sentence = said ? firstSentence(said) : "";
    return {
      title: card.title,
      status: card.status,
      rounds: Number(runs?.value ?? 0),
      lastCheck: [STATUS_WORDS[card.status], sentence]
        .filter(Boolean)
        .join(" · "),
      pendingApprovalId: await pendingApproval(viewer, refs),
    };
  }

  /** 单聊里员工最近一条回复：线程快照里最后一条助手消息，没有快照时用频道记下的最后一句（员工说的）。 */
  async function directReply(
    threadId: string | null,
    channelId: string,
  ): Promise<string | null> {
    if (threadId) {
      const [row] = await database
        .select({ messages: threads.messagesSnapshot })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1);
      const messages = Array.isArray(row?.messages) ? row.messages : [];
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as {
          role?: unknown;
          content?: unknown;
        };
        if (message?.role !== "assistant") continue;
        const text = textOf(message.content).trim();
        if (text) return text;
      }
    }
    const [channel] = await database
      .select({
        text: channels.lastMessage,
        agentId: channels.lastMessageAgentId,
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    return channel?.agentId && channel.text ? channel.text : null;
  }

  /** 群组里员工（或某位员工）最近一条已完成的回复。 */
  async function groupReply(
    channelId: string,
    agentId: string | undefined,
  ): Promise<string | null> {
    const [row] = await database
      .select({ text: groupMessages.text })
      .from(groupMessages)
      .where(
        and(
          eq(groupMessages.channelId, channelId),
          agentId
            ? eq(groupMessages.agentId, agentId)
            : isNotNull(groupMessages.agentId),
          eq(groupMessages.status, "completed"),
        ),
      )
      .orderBy(desc(groupMessages.createdAt), desc(groupMessages.id))
      .limit(1);
    return row?.text.trim() || null;
  }

  /**
   * 这些任务卡留下的输出：按卡的时间倒序，一张卡里附件在前。附件按 id 去重（同一个文件被几张卡带上只算
   * 一次）；组件按「卡 + 组件」去重，不同卡上的同名组件各算一条。取前几条和总数。
   */
  async function outputsOf(
    viewer: AgentActor,
    refs: readonly string[],
  ): Promise<ConversationSidebar["outputs"]> {
    const cards = await database
      .select({
        id: tasks.id,
        executorAgentId: tasks.executorAgentId,
        deliverableRef: tasks.deliverableRef,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, viewer.id),
          inArray(tasks.channelRef, [...refs]),
          isNotNull(tasks.deliverableRef),
        ),
      )
      .orderBy(desc(tasks.updatedAt))
      .limit(OUTPUT_CARD_LIMIT);
    const produced = cards.flatMap((card) =>
      isDeliverableRef(card.deliverableRef)
        ? [{ ...card, deliverable: card.deliverableRef }]
        : [],
    );
    const fileIds = [
      ...new Set(
        produced.flatMap((card) =>
          card.deliverable.attachments.filter(
            (id): id is string => typeof id === "string" && UUID.test(id),
          ),
        ),
      ),
    ];
    const names = new Map(
      fileIds.length > 0
        ? (
            await database
              .select({ id: attachments.id, name: attachments.name })
              .from(attachments)
              .where(inArray(attachments.id, fileIds))
          ).map((row) => [row.id, row.name])
        : [],
    );
    const seen = new Set<string>();
    const items: SidebarOutput[] = [];
    const add = (key: string, output: SidebarOutput) => {
      if (seen.has(key)) return;
      seen.add(key);
      items.push(output);
    };
    for (const card of produced) {
      const at = card.updatedAt.toISOString();
      const by = card.executorAgentId
        ? { byAgentId: card.executorAgentId }
        : {};
      for (const id of card.deliverable.attachments) {
        // 查看者看不到的附件（或不是附件 id 的值）打不开，不列。
        const name = typeof id === "string" ? names.get(id) : undefined;
        if (name)
          add(`file:${id}`, {
            kind: "file",
            title: name,
            href: `/api/attachments/${id}`,
            at,
            ...by,
          });
      }
      for (const component of card.deliverable.components) {
        const kind = component.name === "showTable" ? "table" : "report";
        const named = component.args?.title;
        const title =
          typeof named === "string" && named.trim()
            ? named.trim()
            : kind === "table"
              ? "表格"
              : "报告";
        // 组件画在看板那张卡上，没有自己的地址；同一张卡里画了两遍一模一样的只算一次。
        add(
          `component:${card.id}:${component.name}:${JSON.stringify(component.args ?? {})}`,
          { kind, title, href: "/tasks", at, ...by },
        );
      }
    }
    return { items: items.slice(0, SIDEBAR_OUTPUT_LIMIT), total: items.length };
  }

  /** 在这条线程里出现过的员工：频道的员工，加上在线程里跑过或记过用量的。 */
  async function participants(
    viewer: AgentActor,
    channelAgentIds: readonly string[],
    threadId: string | null,
  ): Promise<string[]> {
    const ids = new Set(channelAgentIds);
    if (threadId) {
      for (const row of await database
        .selectDistinct({ agentId: threadRuns.agentId })
        .from(threadRuns)
        .where(eq(threadRuns.threadId, threadId)))
        ids.add(row.agentId);
      for (const row of await database
        .selectDistinct({ agentId: modelTokenCalls.agentId })
        .from(modelTokenCalls)
        .where(
          and(
            eq(modelTokenCalls.tenantId, viewer.id),
            eq(modelTokenCalls.threadId, threadId),
          ),
        ))
        ids.add(row.agentId);
    }
    return [...ids];
  }

  async function direct(
    viewer: AgentActor,
    chat: Conversation,
    threadId: string | null,
    requested: string | undefined,
  ): Promise<ConversationSidebar | null> {
    const ids = await participants(viewer, chat.agentIds, threadId);
    const agentId = requested ?? chat.agentIds[0];
    if (!agentId || !ids.includes(agentId)) return null;
    const people = await employees(viewer, ids);
    const known = ids.flatMap((id) => {
      const person = people.get(id);
      return person ? [person] : [];
    });
    const places = await placesOf(known);
    const contexts = await contextsOf(
      viewer,
      [
        { agentId, employee: people.get(agentId), threadId },
        ...known
          .filter((person) => person.id !== agentId)
          .map((person) => ({
            agentId: person.id,
            employee: person,
            threadId,
          })),
      ],
      places,
    );
    const context = detailOf(contexts.get(agentId));
    if (known.length > 1) context.perAgent = perAgentOf(known, contexts);
    const refs = threadId ? [threadId, chat.channelId] : [chat.channelId];
    return {
      environment: await environmentFor(
        people.get(agentId),
        places.get(agentId),
      ),
      goal: await goalOf(viewer, refs, threadId ? [threadId] : [], () =>
        directReply(threadId, chat.channelId),
      ),
      context,
      outputs: await outputsOf(viewer, refs),
    };
  }

  async function group(
    viewer: AgentActor,
    chat: Conversation,
    requested: string | undefined,
  ): Promise<ConversationSidebar | null> {
    const people = await employees(viewer, chat.agentIds);
    // 和群组名单同一个顺序：每位员工最早的那条群组线程先后，再按 id。
    const order = (
      await database
        .select({
          agentId: groupBotThreads.agentId,
          first: min(groupBotThreads.createdAt),
        })
        .from(groupBotThreads)
        .where(eq(groupBotThreads.channelId, chat.channelId))
        .groupBy(groupBotThreads.agentId)
        .orderBy(
          asc(min(groupBotThreads.createdAt)),
          asc(groupBotThreads.agentId),
        )
    ).map((row) => row.agentId);
    const rank = (id: string) => {
      const at = order.indexOf(id);
      return at < 0 ? order.length : at;
    };
    const bots = chat.agentIds
      .flatMap((id) => {
        const person = people.get(id);
        return person ? [person] : [];
      })
      .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
    if (requested && !bots.some((bot) => bot.id === requested)) return null;

    const mine = new Map(
      (
        await database
          .select({
            agentId: groupBotThreads.agentId,
            threadId: groupBotThreads.threadId,
          })
          .from(groupBotThreads)
          .where(
            and(
              eq(groupBotThreads.channelId, chat.channelId),
              eq(groupBotThreads.ownerUserId, viewer.id),
            ),
          )
      ).map((row) => [row.agentId, row.threadId]),
    );
    const presence = new Map(
      (
        await readAgentPresence(
          database,
          viewer,
          bots.map((bot) => bot.id),
        )
      ).map((row) => [row.agentId, row]),
    );
    const places = await placesOf(bots);
    const contexts = await contextsOf(
      viewer,
      bots.map((bot) => ({
        agentId: bot.id,
        employee: bot,
        threadId: mine.get(bot.id) ?? null,
      })),
      places,
    );
    const members = bots.map((bot) => {
      const place = places.get(bot.id);
      const now = presence.get(bot.id);
      let status: SidebarMemberStatus = now?.status ?? "unknown";
      if (status !== "paused" && place?.device && !place.device.online)
        status = "offline";
      return {
        agentId: bot.id,
        name: bot.name,
        status,
        where: place?.device?.name ?? (place?.onComputer ? "电脑" : "云端"),
        doing: status === "working" ? (now?.doing ?? null) : null,
      };
    });

    const threadIds = requested
      ? [mine.get(requested)].filter((id): id is string => Boolean(id))
      : [...mine.values()];
    const refs = [chat.channelId, ...mine.values()];
    const context: SidebarContext = requested
      ? detailOf(contexts.get(requested))
      : {};
    context.perAgent = perAgentOf(bots, contexts);
    return {
      environment: {
        kind: deps.runtime === "device" ? "device" : "cloud",
        model: null,
        members,
      },
      goal: await goalOf(viewer, refs, threadIds, () =>
        groupReply(chat.channelId, requested),
      ),
      context,
      outputs: await outputsOf(viewer, refs),
    };
  }

  async function forChannel(
    viewer: AgentActor,
    channelId: string,
    agentId?: string,
  ): Promise<ConversationSidebar | null> {
    const chat = await conversation(viewer, channelId);
    if (!chat) return null;
    return chat.agentIds.length > 1
      ? group(viewer, chat, agentId)
      : direct(viewer, chat, chat.threadId, agentId);
  }

  /**
   * 这条线程是查看者的哪一条：他在某个频道的映射线程，或他在群组里和某位员工的那条；都不是时为 null。
   */
  async function ownThread(
    viewer: AgentActor,
    threadId: string,
  ): Promise<
    | { kind: "mapped"; channelId: string }
    | { kind: "group"; channelId: string; agentId: string }
    | null
  > {
    const [mapped] = await database
      .select({ channelId: intelligenceChannelMappings.channelId })
      .from(intelligenceChannelMappings)
      .where(
        and(
          eq(intelligenceChannelMappings.threadId, threadId),
          eq(intelligenceChannelMappings.userId, viewer.id),
        ),
      )
      .limit(1);
    if (mapped) return { kind: "mapped", channelId: mapped.channelId };
    const [own] = await database
      .select({
        channelId: groupBotThreads.channelId,
        agentId: groupBotThreads.agentId,
      })
      .from(groupBotThreads)
      .where(
        and(
          eq(groupBotThreads.threadId, threadId),
          eq(groupBotThreads.ownerUserId, viewer.id),
        ),
      )
      .limit(1);
    return own ? { kind: "group", ...own } : null;
  }

  /** 单聊里要压的员工：在这条线程里出现过、查看者看得到；不给时是频道的员工。 */
  async function directTarget(
    viewer: AgentActor,
    chat: Conversation,
    threadId: string | null,
    requested: string | undefined,
  ): Promise<CompactionTargetOf | null> {
    const agentId = requested ?? chat.agentIds[0];
    if (!agentId) return null;
    if (
      !(await participants(viewer, chat.agentIds, threadId)).includes(agentId)
    )
      return null;
    const employee = (await employees(viewer, [agentId])).get(agentId);
    if (!employee) return null;
    return { threadId, agentId, external: employee.type !== "built_in" };
  }

  /** 群组里要压的员工：必须点名、在群里、查看者看得到；线程是查看者和它的那条。 */
  async function groupTarget(
    viewer: AgentActor,
    chat: Conversation,
    requested: string | undefined,
  ): Promise<CompactionTargetOf | null> {
    if (!requested || !chat.agentIds.includes(requested)) return null;
    const employee = (await employees(viewer, [requested])).get(requested);
    if (!employee) return null;
    const [own] = await database
      .select({ threadId: groupBotThreads.threadId })
      .from(groupBotThreads)
      .where(
        and(
          eq(groupBotThreads.channelId, chat.channelId),
          eq(groupBotThreads.ownerUserId, viewer.id),
          eq(groupBotThreads.agentId, requested),
        ),
      )
      .limit(1);
    return {
      threadId: own?.threadId ?? null,
      agentId: requested,
      external: employee.type !== "built_in",
    };
  }

  /** 压缩会话压的是哪条线程，见 {@link ConversationSidebarService.compactionTarget}。在查看者的帧里调用。 */
  async function targetOf(
    viewer: AgentActor,
    where: { threadId: string } | { channelId: string },
    agentId: string | undefined,
  ): Promise<CompactionTargetOf | null> {
    if ("channelId" in where) {
      const chat = await conversation(viewer, where.channelId);
      if (!chat) return null;
      return chat.agentIds.length > 1
        ? groupTarget(viewer, chat, agentId)
        : directTarget(viewer, chat, chat.threadId, agentId);
    }
    const own = await ownThread(viewer, where.threadId);
    if (!own || (own.kind === "group" && agentId && agentId !== own.agentId))
      return null;
    const chat = await conversation(viewer, own.channelId);
    if (!chat) return null;
    if (own.kind === "group") return groupTarget(viewer, chat, own.agentId);
    return chat.agentIds.length > 1
      ? groupTarget(viewer, chat, agentId)
      : directTarget(viewer, chat, where.threadId, agentId);
  }

  return {
    forChannel: (viewer, channelId, agentId) =>
      runAsTenant(viewer.id, () => forChannel(viewer, channelId, agentId)),

    forThread: (viewer, threadId, agentId) =>
      runAsTenant(viewer.id, async () => {
        const own = await ownThread(viewer, threadId);
        if (own?.kind === "mapped") {
          const chat = await conversation(viewer, own.channelId);
          if (!chat) return null;
          return chat.agentIds.length > 1
            ? group(viewer, chat, agentId)
            : direct(viewer, chat, threadId, agentId);
        }
        // 查看者在群组里和某位员工的那条线程：那位员工的明细。
        if (!own || (agentId && agentId !== own.agentId)) return null;
        return forChannel(viewer, own.channelId, own.agentId);
      }),

    compactionTarget: (viewer, where, agentId) =>
      runAsTenant(viewer.id, () => targetOf(viewer, where, agentId)),

    compaction: (viewer, where, compactionId) =>
      runAsTenant(viewer.id, async () => {
        if (!UUID.test(compactionId)) return null;
        const [row] = await database
          .select({
            threadId: threadCompactions.threadId,
            agentId: threadCompactions.agentId,
            summary: threadCompactions.summary,
            summarizedCount: threadCompactions.summarizedCount,
            auto: threadCompactions.auto,
            createdAt: threadCompactions.createdAt,
          })
          .from(threadCompactions)
          .where(
            and(
              eq(threadCompactions.id, compactionId),
              eq(threadCompactions.tenantId, viewer.id),
            ),
          )
          .limit(1);
        if (!row) return null;
        const target = await targetOf(viewer, where, row.agentId);
        if (!target || target.threadId !== row.threadId) return null;
        return {
          summary: row.summary,
          summarizedCount: row.summarizedCount,
          auto: row.auto,
          at: row.createdAt.toISOString(),
        };
      }),
  };
}
