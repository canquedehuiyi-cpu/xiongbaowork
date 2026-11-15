import {
  type ContextUsage,
  type ConversationSidebar,
  SIDEBAR_OUTPUT_LIMIT,
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
import { readAgentPresence } from "../agents/presence";
import { agentAccessFilter } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
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
  type ReadContextUsageDeps,
  readContextUsage,
} from "./context-usage";

/**
 * 对话侧栏（环境 · 目标 · 上下文 · 输出内容）的读取：单聊按线程，群组按频道，一次给四块。
 *
 * 看得到才给：查看者是这个频道的成员、频道没删，按线程问时这条线程还得是查看者自己的（单聊里他的那条
 * 映射，或群组里他和某位员工的那条）。看不到、不存在、员工不在这个对话里，一律回 null（路由答 404），
 * 不说为什么。
 *
 * 所有读都在查看者自己的租户帧里（行级安全照常生效），只有一处例外：员工的计量行写在哪个租户就去哪个
 * 租户读（{@link SidebarDeps.meteringTenant}，员工用主人的模型库时是主人），而且只在上面的可见性检查过了
 * 之后、只按这条线程 + 这位员工过滤。分类比例仍在查看者名下读（它记在发起运行的人名下）。
 *
 * 群组的口径：环境的成员列表、目标、输出内容按群组频道取；上下文按「查看者 × 每位员工」各自那条
 * `group_bot_threads` 线程取。任务卡和附件按行级安全只看得到查看者自己名下的。
 */

export type SidebarDeps = {
  database: Database;
  /** 内置员工在哪跑（`config.tenantRuntime`）。 */
  runtime: "cloud" | "device";
  /** 没绑模型的员工用的部署默认模型（`provider/model`）；没有时为 null。 */
  deploymentModelLabel: string | null;
  contextWindowFor: ReadContextUsageDeps["contextWindowFor"];
  /**
   * 员工这一轮的模型调用记在哪个租户名下，在查看者的帧里问（`meteringTenantFor`）；null 时按查看者。
   */
  meteringTenant: (agentId: string) => Promise<string | null>;
  /** 设备模式下内置员工的动作落在哪台电脑（`deviceSelector.forBot`）；云端模式不给。 */
  machineOf?: (agentId: string) => Promise<MachineTarget | null>;
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
};

/** 侧栏里读到的员工资料。 */
type Employee = {
  id: string;
  name: string;
  type: "built_in" | "remote_ag_ui" | "remote_mastra" | "device_acp";
  configuration: unknown;
  modelRef: string | null;
  platformModelRef: string | null;
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
/** 输出内容最多看这么多张卡：侧栏只要最近的几条和总数。 */
const OUTPUT_CARD_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    return new Map(rows.map((row) => [row.id, row]));
  }

  async function device(
    tenantId: string,
    deviceId: string,
  ): Promise<Device | null> {
    const [row] = await database
      .select({
        rowId: registeredDevices.id,
        name: registeredDevices.name,
        lastSeenAt: registeredDevices.lastSeenAt,
        roots: registeredDevices.roots,
        apps: registeredDevices.apps,
      })
      .from(registeredDevices)
      .where(
        and(
          eq(registeredDevices.tenantId, tenantId),
          eq(registeredDevices.deviceId, deviceId),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      rowId: row.rowId,
      name: row.name,
      online:
        row.lastSeenAt !== null &&
        Date.now() - row.lastSeenAt.getTime() < OFFLINE_AFTER_MS,
      roots: namedEntries(row.roots),
      apps: namedEntries(row.apps),
    };
  }

  /**
   * 内置员工在设备模式下动作落在的那台电脑（`tenantId` 是电脑主人），连同查看者看得到时的设备记录。
   * 云端模式、没有电脑可选时为 null。
   */
  async function machineOf(
    agentId: string,
  ): Promise<{ tenantId: string; device: Device | null } | null> {
    if (deps.runtime !== "device" || !deps.machineOf) return null;
    const machine = await deps.machineOf(agentId).catch(() => null);
    if (!machine) return null;
    return {
      tenantId: machine.tenantId,
      device: await device(machine.tenantId, machine.deviceId),
    };
  }

  function harnessLabel(
    employee: Employee,
    configuration: ExternalConfiguration,
    on: Device | null,
  ): string {
    if (configuration.harness && HARNESS_LABELS[configuration.harness])
      return HARNESS_LABELS[configuration.harness] as string;
    const app = on?.apps.find((entry) => entry.ref === configuration.appRef);
    return app?.name ?? employee.name;
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

  async function environmentFor(
    viewer: AgentActor,
    employee: Employee | undefined,
  ): Promise<SidebarEnvironment> {
    if (!employee)
      return {
        kind: deps.runtime === "device" ? "device" : "cloud",
        model: null,
      };
    if (employee.type === "device_acp") {
      const configuration = externalConfiguration(employee.configuration);
      const on = configuration.deviceId
        ? await device(viewer.id, configuration.deviceId)
        : null;
      const harness = harnessLabel(employee, configuration, on);
      return {
        kind: "device",
        ...(on ? { deviceName: on.name, online: on.online } : {}),
        workdirName:
          on?.roots.find((root) => root.ref === configuration.workdirRef)
            ?.name ?? null,
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
    const machine = await machineOf(employee.id);
    const on = machine?.device ?? null;
    return {
      kind: "device",
      ...(on ? { deviceName: on.name, online: on.online } : {}),
      project:
        machine && on
          ? await project(machine.tenantId, employee.id, on.rowId)
          : null,
      model,
    };
  }

  async function lastCompaction(
    viewer: AgentActor,
    threadId: string,
    agentId: string,
  ): Promise<{ id: string; auto: boolean; at: string } | null> {
    const [row] = await database
      .select({
        id: threadCompactions.id,
        auto: threadCompactions.auto,
        createdAt: threadCompactions.createdAt,
      })
      .from(threadCompactions)
      .where(
        and(
          eq(threadCompactions.tenantId, viewer.id),
          eq(threadCompactions.threadId, threadId),
          eq(threadCompactions.agentId, agentId),
        ),
      )
      .orderBy(desc(threadCompactions.createdAt))
      .limit(1);
    return row
      ? { id: row.id, auto: row.auto, at: row.createdAt.toISOString() }
      : null;
  }

  /** 某员工在某线程里的用量：计量行在它写入的租户读，分类比例在查看者名下读。 */
  async function usageOf(
    viewer: AgentActor,
    threadId: string | null,
    agentId: string,
  ): Promise<ContextUsage> {
    if (!threadId)
      return contextUsageFrom({
        used: null,
        limit: null,
        shares: null,
        lastModel: null,
      });
    // 计量只写在某个人名下（计量表拒收别的租户），所以别的答案都按查看者读。
    const answered = await deps.meteringTenant(agentId);
    const metered = isPersonTenant(answered) ? answered : viewer.id;
    return readContextUsage(
      metered,
      threadId,
      agentId,
      { database, contextWindowFor: deps.contextWindowFor },
      { sharesTenantId: viewer.id },
    );
  }

  /** 一位员工在一条线程里的上下文：外部员工只说谁在管，其余给用量和最近一次压缩。 */
  async function contextOf(
    viewer: AgentActor,
    threadId: string | null,
    agentId: string,
    employee: Employee | undefined,
  ): Promise<SidebarContext> {
    if (employee?.type === "device_acp") {
      const configuration = externalConfiguration(employee.configuration);
      const on = configuration.deviceId
        ? await device(viewer.id, configuration.deviceId)
        : null;
      return { managedBy: harnessLabel(employee, configuration, on) };
    }
    return {
      usage: await usageOf(viewer, threadId, agentId),
      lastCompaction: threadId
        ? await lastCompaction(viewer, threadId, agentId)
        : null,
    };
  }

  /** 每位员工一行（群组：查看者和它的那条线程；单聊：同一条线程）。 */
  async function perAgentOf(
    viewer: AgentActor,
    rows: { employee: Employee; threadId: string | null }[],
  ): Promise<NonNullable<SidebarContext["perAgent"]>> {
    return Promise.all(
      rows.map(async ({ employee, threadId }) => {
        if (employee.type === "device_acp") {
          const context = await contextOf(
            viewer,
            threadId,
            employee.id,
            employee,
          );
          return {
            agentId: employee.id,
            name: employee.name,
            percent: null,
            ...(context.managedBy ? { managedBy: context.managedBy } : {}),
          };
        }
        const usage = await usageOf(viewer, threadId, employee.id);
        const compaction = threadId
          ? await lastCompaction(viewer, threadId, employee.id)
          : null;
        return {
          agentId: employee.id,
          name: employee.name,
          percent: usage.percent,
          compactedAt: compaction?.at ?? null,
        };
      }),
    );
  }

  async function goalOf(
    viewer: AgentActor,
    refs: readonly string[],
    threadIds: readonly string[],
    reply: () => Promise<string | null>,
  ): Promise<SidebarGoal> {
    const [card] = await database
      .select({
        title: tasks.title,
        status: tasks.status,
        pendingApprovalId: tasks.pendingApprovalId,
      })
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
      pendingApprovalId:
        card.status === "needs_action" ? card.pendingApprovalId : null,
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

  /** 这些任务卡留下的输出：按卡的时间倒序，一张卡里附件在前，去重后取前几条和总数。 */
  async function outputsOf(
    viewer: AgentActor,
    refs: readonly string[],
  ): Promise<ConversationSidebar["outputs"]> {
    const cards = await database
      .select({
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
        // 组件画在看板那张卡上，没有自己的地址。
        add(`${kind}:${title}`, { kind, title, href: "/tasks", at, ...by });
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
    const employee = people.get(agentId);
    const refs = threadId ? [threadId, chat.channelId] : [chat.channelId];
    const context = await contextOf(viewer, threadId, agentId, employee);
    const others = ids.flatMap((id) => {
      const known = people.get(id);
      return known ? [{ employee: known, threadId }] : [];
    });
    if (others.length > 1) context.perAgent = await perAgentOf(viewer, others);
    return {
      environment: await environmentFor(viewer, employee),
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
        const employee = people.get(id);
        return employee ? [employee] : [];
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
    const members = await Promise.all(
      bots.map(async (bot) => {
        const on =
          bot.type === "device_acp"
            ? await (async () => {
                const { deviceId } = externalConfiguration(bot.configuration);
                return deviceId ? device(viewer.id, deviceId) : null;
              })()
            : bot.type === "built_in"
              ? ((await machineOf(bot.id))?.device ?? null)
              : null;
        const onComputer =
          bot.type === "device_acp" ||
          (bot.type === "built_in" && deps.runtime === "device");
        const now = presence.get(bot.id);
        let status: SidebarMemberStatus = now?.status ?? "unknown";
        if (status !== "paused" && on && !on.online) status = "offline";
        return {
          agentId: bot.id,
          name: bot.name,
          status,
          where: on?.name ?? (onComputer ? "电脑" : "云端"),
          doing: status === "working" ? (now?.doing ?? null) : null,
        };
      }),
    );

    const threadIds = requested
      ? [mine.get(requested)].filter((id): id is string => Boolean(id))
      : [...mine.values()];
    const refs = [chat.channelId, ...mine.values()];
    const context: SidebarContext = {
      perAgent: await perAgentOf(
        viewer,
        bots.map((bot) => ({
          employee: bot,
          threadId: mine.get(bot.id) ?? null,
        })),
      ),
    };
    if (requested) {
      const detail = await contextOf(
        viewer,
        mine.get(requested) ?? null,
        requested,
        people.get(requested),
      );
      Object.assign(context, detail);
    }
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

  return {
    forChannel: (viewer, channelId, agentId) =>
      runAsTenant(viewer.id, () => forChannel(viewer, channelId, agentId)),

    forThread: (viewer, threadId, agentId) =>
      runAsTenant(viewer.id, async () => {
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
        if (mapped) {
          const chat = await conversation(viewer, mapped.channelId);
          if (!chat) return null;
          return chat.agentIds.length > 1
            ? group(viewer, chat, agentId)
            : direct(viewer, chat, threadId, agentId);
        }
        // 查看者在群组里和某位员工的那条线程：那位员工的明细。
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
        if (!own || (agentId && agentId !== own.agentId)) return null;
        return forChannel(viewer, own.channelId, own.agentId);
      }),
  };
}
