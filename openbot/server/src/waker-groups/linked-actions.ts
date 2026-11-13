import { and, eq, inArray, sql } from "drizzle-orm";
import { AgentNotFoundError } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import { type GroupConversations, GroupRefusedError } from "../channels/group";
import type { AgentChannel, ChannelStore } from "../channels/routes";
import type { Database } from "../db/client";
import {
  botTasks,
  channelAgents,
  channels,
  groupTaskRuns,
  portraitMedia,
  portraits,
  wakerFlows,
  wakerGroups,
} from "../db/schema";
import { TEAM_TENANT } from "../db/schema/tenant";
import {
  channelCreatedBy,
  channelOwner,
  isGroupConversation,
  runtimeOrder,
  stateOf,
  type WakerGroupLink,
} from "./channel-link";
import {
  type ListedWakerGroup,
  WakerGroupNameError,
  WakerGroupNameTakenError,
  type WakerGroupStore,
} from "./store";

/*
 * 群组接口里要动到群聊的那几步（设计稿 docs/specs/2026-11-13-group-unify.md 第 6.2、6.3 节）：
 * 建群组即开聊天、改名、给未开始聊天的群组开聊天、打开设置时补挂，以及带状态的列表；
 * 管理成员（翻译成群聊的增删排序）与解散（第 4.2、7.5 节）。
 *
 * 帧：全部在调用者自己的帧里跑（路由的 requireUser 已经开好）。群聊一侧的读写经未装饰的群聊服务和
 * 装饰过的 channelStore，挂接经 WakerGroupLink（它自己定帧）。这里不开 platform 帧。
 */

const MIN_MEMBERS = 2;
const MAX_MEMBERS = 20;

export class WakerGroupSizeError extends Error {
  constructor() {
    super("一个群组要有 2 到 20 位员工。");
    this.name = "WakerGroupSizeError";
  }
}

/** `POST /:id/chat` on a crew that already has its chat. */
export class WakerGroupLinkedError extends Error {
  constructor() {
    super("这个群组已经可以聊天了。");
    this.name = "WakerGroupLinkedError";
  }
}

/** A member of the conversation who did not start it: they may look, not change. */
export class WakerGroupForbiddenError extends Error {
  constructor() {
    super("只有发起人能调整这个群组。");
    this.name = "WakerGroupForbiddenError";
  }
}

/**
 * The crew is linked to a live chat its owner can no longer read, and nobody has taken it over yet.
 * A creator who leaves through the service hands the group over at once (spec 3.1.1), so this is
 * what is left: a creator removed past the service (their membership deleted straight, an account
 * deleted by an operator) before a heal; a hand-over a running flow put off; or only deactivated
 * members left to take it. Nothing is moved or reopened, and the caller is told, with `code`,
 * instead of being handed a second chat or a silent nothing.
 */
export class WakerGroupOwnerGoneError extends Error {
  readonly code = "waker-group-owner-gone";
  constructor() {
    super("这个群组的聊天你已经不在里面了，暂时不能调整。");
    this.name = "WakerGroupOwnerGoneError";
  }
}

/** One write `PUT /:id/members` made to the chat, in the order it made them. */
export type MemberStep = {
  op: "add" | "remove" | "reorder";
  agentIds: string[];
};

/**
 * A roster change translated into chat writes stopped part-way (4.2: the steps are not one
 * transaction). Each step that went through is still in force and listed in `done`; the mirror has
 * been rewritten from the chat, so what the caller reads next is what the chat holds.
 */
export class WakerGroupStepsError extends Error {
  readonly done: MemberStep[];
  constructor(done: MemberStep[], cause: unknown) {
    // The service's own refusal says why in words a person can act on; anything else is not shown.
    super(
      cause instanceof GroupRefusedError
        ? cause.message
        : done.length === 0
          ? "群组成员没有做任何改动，请刷新后再试。"
          : "群组成员只改了一部分，请刷新后再试。",
      { cause },
    );
    this.name = "WakerGroupStepsError";
    this.done = done;
  }
}

/** 7.5: a crew with a flow run still going is not dissolved under it. */
export class WakerGroupRunningError extends Error {
  constructor() {
    super("有组团流程正在运行，先停下再解散。");
    this.name = "WakerGroupRunningError";
  }
}

export type ChatStatus =
  | "chat"
  | "pending_members"
  | "too_many"
  | "not_started";
export type StatusedWakerGroup = ListedWakerGroup & {
  usableMemberCount: number;
  chatStatus: ChatStatus;
};

type Chat = AgentChannel & { wakerGroupId: string };

export type WakerGroupActions = {
  createWithChat(
    owner: string,
    input: { name: string; description: string | null; agentIds: string[] },
  ): Promise<{ group: ListedWakerGroup; channel: Chat }>;
  rename(
    owner: string,
    groupId: string,
    patch: { name?: string; description?: string | null },
  ): Promise<ListedWakerGroup | null>;
  startChat(
    owner: string,
    groupId: string,
  ): Promise<{ group: ListedWakerGroup; channel: Chat } | null>;
  /**
   * null when the caller cannot read the channel; WakerGroupForbiddenError when they do not own it.
   * A shared group whose creator has left or been deactivated is first handed over (3.1.1 第 4.4 条):
   * the earliest member who opens it takes it over.
   */
  forChannel(
    owner: string,
    channelId: string,
  ): Promise<ListedWakerGroup | null>;
  list(owner: string): Promise<StatusedWakerGroup[]>;
  /**
   * The crew's roster, wholesale. Linked: 2–20 Bots (WakerGroupSizeError), written to the chat as
   * adds, removals and a reorder (WakerGroupStepsError when one fails). Unlinked: the roster is
   * written as before, and a crew that now has 2–20 usable Bots gets its chat; when that chat cannot
   * be opened the roster stays written and `chatError` says why (the crew reads "not started").
   * null: not the caller's.
   */
  setMembers(
    owner: string,
    groupId: string,
    agentIds: string[],
  ): Promise<{ group: ListedWakerGroup; chatError?: string } | null>;
  /**
   * 7.5: hide the chat, delete the crew (its flows and runs go with it), delete its portrait. false
   * when there is no such crew of the caller's; WakerGroupRunningError while a run is unfinished.
   * The crew, its portrait and the run check are one transaction holding the crew's row; the chat is
   * hidden by upstream's own transaction just before it (see `dissolve`).
   */
  dissolve(owner: string, groupId: string): Promise<boolean>;
};

/**
 * 未完成的升级转换占用的频道（Task 14 用 createConversionClaims 实现；PR1 不传）。claimedBy 返回占用它的
 * 群组 id；finish 在所有者帧 adopt 并把台账改 converted。
 */
export type ConversionClaims = {
  claimedBy(channelId: string): Promise<string | null>;
  finish(groupId: string, channelId: string): Promise<void>;
};

type Log = (line: Record<string, unknown>) => void;
const logToStderr: Log = (line) => console.error(JSON.stringify(line));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the crew has a flow run that has not finished (`S/pipeline/store.ts` RunOutcome). */
async function unfinishedRun(
  executor: Pick<Database, "select">,
  groupId: string,
): Promise<boolean> {
  const [run] = await executor
    .select({ id: groupTaskRuns.id })
    .from(groupTaskRuns)
    .where(
      and(
        eq(groupTaskRuns.groupId, groupId),
        inArray(groupTaskRuns.status, ["running", "awaiting_action"]),
      ),
    )
    .limit(1);
  return Boolean(run);
}

/**
 * 6.2：`channelId` 非空 → chat；否则按可用员工数：< 2 待补成员，> 20 太多，其余未开始聊天。
 * 可用员工数而不是成员行数：升级转换记成「待补成员」的群组保留了全部成员行。
 */
function chatStatusOf(channelId: string | null, usable: number): ChatStatus {
  if (channelId) return "chat";
  if (usable < MIN_MEMBERS) return "pending_members";
  if (usable > MAX_MEMBERS) return "too_many";
  return "not_started";
}

export function createWakerGroupActions(deps: {
  database: Database;
  store: WakerGroupStore;
  link: WakerGroupLink;
  /** The undecorated service (`baseGroupConversations`): the crew is made here, not by its decorator. */
  groups: Pick<
    GroupConversations,
    "create" | "addBots" | "removeBots" | "reorder" | "store"
  >;
  /** The decorated channel store: its `rename` carries the name over to the crew. */
  channels: Pick<ChannelStore, "get" | "rename" | "softDelete">;
  actorFor(userId: string): Promise<AgentActor>;
  /** The groups service's own `canUseBot` (S/index.ts). */
  canUse(ownerUserId: string, agentId: string): Promise<boolean>;
  conversions?: ConversionClaims;
  log?: Log;
}): WakerGroupActions {
  const { database, store, link, groups } = deps;
  const log = deps.log ?? logToStderr;

  /** The crew as the list shows it to the caller. */
  async function listed(groupId: string): Promise<ListedWakerGroup> {
    const group = (await store.list()).find((item) => item.id === groupId);
    if (!group) throw new Error(`crew ${groupId} is not listed`);
    return group;
  }

  /**
   * The caller's own crew, or null: another tenant's (row security hides it), the platform's (visible,
   * not theirs, see `store.setMembers`), a WakerFlow's (the list leaves it out) or no such id.
   */
  async function own(
    owner: string,
    groupId: string,
  ): Promise<ListedWakerGroup | null> {
    if (!UUID.test(groupId)) return null;
    const [row] = await database
      .select({ tenantId: wakerGroups.tenantId })
      .from(wakerGroups)
      .where(eq(wakerGroups.id, groupId))
      .limit(1);
    if (!row || row.tenantId !== owner) return null;
    return (await store.list()).find((item) => item.id === groupId) ?? null;
  }

  /** `canUse`, asked once per Bot however many crews name it. */
  function usableBy(owner: string) {
    const asked = new Map<string, Promise<boolean>>();
    return (agentId: string) => {
      let answer = asked.get(agentId);
      if (!answer) {
        answer = deps.canUse(owner, agentId);
        asked.set(agentId, answer);
      }
      return answer;
    };
  }

  /** The crew's members the owner can use, in roster order. */
  async function usableMembers(
    group: ListedWakerGroup,
    usable: (agentId: string) => Promise<boolean>,
  ) {
    const ids = group.members.map((member) => member.agentId);
    const answers = await Promise.all(ids.map(usable));
    return ids.filter((_, at) => answers[at]);
  }

  /** Run an undo step; a failure is logged, never thrown over the error that made it necessary. */
  async function undo(step: string, work: () => Promise<unknown>) {
    try {
      await work();
    } catch (error) {
      log({
        type: "waker-group-undo-failed",
        step,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The crew and its chat as they read now: the chat renamed to the crew, the roster mirrored. */
  async function made(
    actor: AgentActor,
    groupId: string,
    channelId: string,
  ): Promise<{ group: ListedWakerGroup; channel: Chat }> {
    const fresh = await deps.channels.get(actor, channelId);
    if (!fresh) throw new Error(`chat ${channelId} is not readable`);
    return {
      group: await listed(groupId),
      channel: { ...fresh, wakerGroupId: groupId },
    };
  }

  /** Open a chat of `members` for an unlinked crew and link it; the chat is hidden again if that fails. */
  async function openChat(
    owner: string,
    groupId: string,
    members: string[],
  ): Promise<{ group: ListedWakerGroup; channel: Chat }> {
    const actor = await deps.actorFor(owner);
    const channel = await groups.create(owner, { agentIds: members });
    try {
      await link.adopt(groupId, channel.id);
    } catch (error) {
      await undo("hide-chat", () =>
        deps.channels.softDelete(actor, channel.id),
      );
      /*
       * The crew already has a live chat (`channels_waker_group_live_idx`). One the caller can read
       * was opened by a request racing this one; one they cannot is a chat they have left.
       */
      if (stateOf(error) === "23505") {
        if (await link.liveChannelOf(groupId))
          throw new WakerGroupLinkedError();
        throw new WakerGroupOwnerGoneError();
      }
      throw error;
    }
    return made(actor, groupId, channel.id);
  }

  /**
   * 4.2: a linked crew's new roster, written to the chat through the undecorated service (its
   * `creatorOnly`, `canUseBot` and 2–20 checks all apply): adds first, at most up to 20, then
   * removals, at most down to 2, round after round, so even twenty swapped for twenty others never
   * crosses either bound; then the target order. The mirror is rewritten from the chat afterwards,
   * and also when a step fails, before WakerGroupStepsError says which steps went through.
   */
  async function translate(owner: string, channelId: string, target: string[]) {
    /** The mirror from the chat; a failure is logged and left to the self-heal (4.5), as 4.2 does. */
    const mirrorChat = async () => {
      try {
        return await link.reconcile(channelId);
      } catch (failure) {
        log({
          type: "waker-group-reconcile-failed",
          channelId,
          error: failure instanceof Error ? failure.message : String(failure),
        });
        return null;
      }
    };
    const done: MemberStep[] = [];
    try {
      const current = runtimeOrder(
        await groups.store.order(channelId),
        await groups.store.bots(channelId),
      );
      let toAdd = target.filter((id) => !current.includes(id));
      let toRemove = current.filter((id) => !target.includes(id));
      let count = current.length;
      while (toAdd.length > 0 || toRemove.length > 0) {
        const adding = toAdd.slice(0, Math.max(0, MAX_MEMBERS - count));
        if (adding.length > 0) {
          await groups.addBots(owner, channelId, adding);
          done.push({ op: "add", agentIds: adding });
          toAdd = toAdd.slice(adding.length);
          count += adding.length;
        }
        const removing = toRemove.slice(0, Math.max(0, count - MIN_MEMBERS));
        if (removing.length > 0) {
          await groups.removeBots(owner, channelId, removing);
          done.push({ op: "remove", agentIds: removing });
          toRemove = toRemove.slice(removing.length);
          count -= removing.length;
        }
        if (adding.length === 0 && removing.length === 0)
          throw new Error(
            `roster of ${channelId} cannot move toward the target`,
          );
      }
      await groups.reorder(owner, channelId, target);
      done.push({ op: "reorder", agentIds: target });
    } catch (error) {
      await mirrorChat();
      // A refusal is the caller's to read in the answer; anything else would otherwise go unseen.
      if (!(error instanceof GroupRefusedError))
        log({
          type: "waker-group-members-failed",
          channelId,
          done: done.length,
          error: error instanceof Error ? error.message : String(error),
        });
      throw new WakerGroupStepsError(done, error);
    }
    // false: the owner's frame no longer reads the chat (they left it between the steps and now).
    if ((await mirrorChat()) === false) throw new WakerGroupOwnerGoneError();
  }

  return {
    async createWithChat(owner, input) {
      const agentIds = [...new Set(input.agentIds)];
      if (agentIds.length < MIN_MEMBERS || agentIds.length > MAX_MEMBERS)
        throw new WakerGroupSizeError();
      const actor = await deps.actorFor(owner);
      // Name checks (400, 409) come from here, before any chat exists.
      const group = await store.create({
        name: input.name,
        description: input.description,
      });
      let channel: { id: string };
      try {
        channel = await groups.create(owner, { agentIds });
      } catch (error) {
        await undo("remove-crew", () => store.remove(group.id));
        throw error;
      }
      try {
        await link.adopt(group.id, channel.id);
      } catch (error) {
        // No empty, unlinked chat is left behind: hidden first (the creator may, 0122), then the crew.
        await undo("hide-chat", () =>
          deps.channels.softDelete(actor, channel.id),
        );
        await undo("remove-crew", () => store.remove(group.id));
        throw error;
      }
      return made(actor, group.id, channel.id);
    },

    async rename(owner, groupId, patch) {
      const group = await own(owner, groupId);
      if (!group) return null;
      const name = patch.name === undefined ? undefined : patch.name.trim();
      if (name !== undefined && (name.length === 0 || name.length > 80))
        throw new WakerGroupNameError();
      const description =
        patch.description === undefined
          ? undefined
          : patch.description?.trim()
            ? patch.description.trim().slice(0, 500)
            : null;
      const renaming = name !== undefined && name !== group.name;
      // Checked first, so a taken name changes neither side; the chat's rename would otherwise go
      // through and the crew keep its old name (4.4). Any crew the caller can see counts, as there.
      if (renaming) {
        const [clash] = await database
          .select({ id: wakerGroups.id })
          .from(wakerGroups)
          .where(
            sql`${wakerGroups.name} = ${name} and ${wakerGroups.id} <> ${groupId}::uuid`,
          )
          .limit(1);
        if (clash) throw new WakerGroupNameTakenError();
      }
      const channelId = await link.liveChannelOf(groupId);
      // Linked: the chat's title is the name's truth; renaming it renames the crew (the decorator).
      // Only a new name is written to the chat: a description alone leaves the chat untouched.
      if (name !== undefined && renaming && channelId)
        await deps.channels.rename(await deps.actorFor(owner), channelId, name);
      const set: { name?: string; description?: string | null } = {};
      if (renaming && !channelId) set.name = name;
      if (description !== undefined) set.description = description;
      if (Object.keys(set).length > 0) {
        try {
          await database
            .update(wakerGroups)
            .set({ ...set, updatedAt: new Date() })
            .where(eq(wakerGroups.id, groupId));
        } catch (error) {
          // Taken between the check and the write.
          if (stateOf(error) === "23505") throw new WakerGroupNameTakenError();
          throw error;
        }
      }
      return listed(groupId);
    },

    async startChat(owner, groupId) {
      const group = await own(owner, groupId);
      if (!group) return null;
      if (group.channelId) throw new WakerGroupLinkedError();
      const members = await usableMembers(group, usableBy(owner));
      if (chatStatusOf(null, members.length) !== "not_started")
        throw new WakerGroupSizeError();
      return openChat(owner, groupId, members);
    },

    async setMembers(owner, groupId, agentIds) {
      const group = await own(owner, groupId);
      if (!group) return null;
      const target = [...new Set(agentIds)];
      if (group.channelId) {
        if (target.length < MIN_MEMBERS || target.length > MAX_MEMBERS)
          throw new WakerGroupSizeError();
        await translate(owner, group.channelId, target);
        return { group: await listed(groupId) };
      }
      const before = group.members.map((member) => member.agentId);
      if (!(await store.setMembers(groupId, target))) return null;
      const written = await listed(groupId);
      const members = await usableMembers(written, usableBy(owner));
      if (chatStatusOf(null, members.length) !== "not_started")
        return { group: written };
      try {
        return { group: (await openChat(owner, groupId, members)).group };
      } catch (error) {
        // A chat the caller has left still holds the crew: its roster is that chat's, put it back.
        if (error instanceof WakerGroupOwnerGoneError) {
          await undo("restore-members", () =>
            store.setMembers(groupId, before),
          );
          throw error;
        }
        // Another request opened it a moment ago: the same 409 `POST /:id/chat` gives.
        if (error instanceof WakerGroupLinkedError) throw error;
        /*
         * The roster was asked for and is written; the chat is a step on top of it. The crew reads
         * "not started" and `POST /:id/chat` can try again, so the answer says the roster is saved and
         * why the chat is not open, rather than failing a write that went through.
         */
        const refusal =
          error instanceof GroupRefusedError ||
          error instanceof AgentNotFoundError;
        if (!refusal)
          log({
            type: "waker-group-chat-open-failed",
            groupId,
            error: error instanceof Error ? error.message : String(error),
          });
        return {
          group: await listed(groupId),
          chatError: refusal
            ? (error as Error).message
            : "成员已保存，但群聊没能开始，请稍后点「开始聊天」再试。",
        };
      }
    },

    async dissolve(owner, groupId) {
      const group = await own(owner, groupId);
      if (!group) return false;
      // Asked before anything changes, so a refusal leaves the chat as it was; asked again under the lock.
      if (await unfinishedRun(database, groupId))
        throw new WakerGroupRunningError();
      /*
       * Hidden, not deleted: the conversation keeps upstream's own delete semantics (7.5). It is
       * upstream's transaction, with its own notification, so it cannot join the one below; and it
       * is not called from inside it either, which would hold one pooled connection while waiting
       * for a second (S/db/client.ts). Should the transaction below fail, the chat stays hidden and
       * the crew whole, reading "not started": dissolving again finishes the job.
       */
      if (group.channelId)
        await deps.channels.softDelete(
          await deps.actorFor(owner),
          group.channelId,
        );
      try {
        return await database.transaction(async (tx) => {
          /*
           * The crew's row, locked. A run being inserted holds a key-share lock on it (the foreign
           * key), so the two take turns: a run that got there first is seen by the check below and
           * refuses this; one that comes after waits, then fails its foreign key.
           */
          const [held] = await tx
            .select({ id: wakerGroups.id })
            .from(wakerGroups)
            .where(
              sql`${wakerGroups.id} = ${groupId}::uuid and not exists (
                select 1 from ${wakerFlows} where ${wakerFlows.groupId} = ${wakerGroups.id})`,
            )
            .for("update");
          if (!held) return false;
          if (await unfinishedRun(tx, groupId))
            throw new WakerGroupRunningError();
          await tx
            .delete(portraits)
            .where(
              and(
                eq(portraits.subjectKind, "group"),
                eq(portraits.subjectId, groupId),
              ),
            );
          await tx
            .delete(portraitMedia)
            .where(
              and(
                eq(portraitMedia.subjectKind, "group"),
                eq(portraitMedia.subjectId, groupId),
              ),
            );
          // Templates and runs cascade (0075); the chat's link is cleared by its foreign key (0206 b).
          const removed = await tx
            .delete(wakerGroups)
            .where(eq(wakerGroups.id, groupId))
            .returning({ id: wakerGroups.id });
          return removed.length > 0;
        });
      } catch (error) {
        if (group.channelId)
          log({
            type: "waker-group-dissolve-incomplete",
            groupId,
            channelId: group.channelId,
            error: error instanceof Error ? error.message : String(error),
          });
        throw error;
      }
    },

    async forChannel(owner, channelId) {
      // Read access first, as the channel routes ask it: linkChannel reads as platform (spec 6.3).
      const actor = await deps.actorFor(owner);
      if (!(await deps.channels.get(actor, channelId))) return null;
      // The caller reads this row in their own frame now that they are known to be a member.
      const [row] = (await database.execute(
        sql`select ${channels.tenantId} as tenant_id, ${channelCreatedBy} as created_by,
                   (select count(*)::int from ${channelAgents}
                     where ${channelAgents.channelId} = ${channels.id}) as agent_count,
                   exists (select 1 from ${botTasks}
                            where ${botTasks.channelId} = ${channels.id}) as task
              from ${channels} where ${channels.id} = ${channelId}`,
      )) as unknown as {
        tenant_id: string;
        created_by: string | null;
        agent_count: number;
        task: boolean;
      }[];
      // A one-on-one chat or a task's conversation has no group settings: answered as unreadable,
      // so what kind of conversation an id names cannot be probed either (3.1).
      if (
        !row ||
        !isGroupConversation({
          tenantId: row.tenant_id,
          agentCount: Number(row.agent_count),
          task: row.task,
        })
      )
        return null;
      let creator = row.created_by;
      // Someone other than its creator opens a shared group: a creator who has left is succeeded now.
      if (row.tenant_id === TEAM_TENANT && creator !== owner)
        creator = (await link.handOver(channelId)).owner;
      if (
        channelOwner({ tenantId: row.tenant_id, createdBy: creator }) !== owner
      )
        throw new WakerGroupForbiddenError();
      const claimed = (await deps.conversions?.claimedBy(channelId)) ?? null;
      let groupId: string | null;
      if (claimed && deps.conversions) {
        await deps.conversions.finish(claimed, channelId);
        groupId = claimed;
      } else {
        groupId = await link.linkChannel(channelId);
      }
      // Deleted since the read, or its creator left between the two: nothing to show as theirs.
      if (!groupId) return null;
      if (!(await link.reconcile(channelId)))
        throw new WakerGroupOwnerGoneError();
      return listed(groupId);
    },

    async list(owner) {
      const usable = usableBy(owner);
      return Promise.all(
        (await store.list()).map(async (group) => {
          const usableMemberCount = (await usableMembers(group, usable)).length;
          return {
            ...group,
            usableMemberCount,
            chatStatus: chatStatusOf(group.channelId, usableMemberCount),
          };
        }),
      );
    },
  };
}
