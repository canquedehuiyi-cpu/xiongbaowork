import { randomUUID } from "node:crypto";
import { eq, type SQL, sql } from "drizzle-orm";
import {
  type GroupConversations,
  GroupRefusedError,
  type GroupStore,
} from "../channels/group";
import type { ChannelStore } from "../channels/routes";
import type { Database } from "../db/client";
import {
  botTasks,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  wakerGroupMembers,
  wakerGroups,
} from "../db/schema";
import { TEAM_TENANT } from "../db/schema/tenant";
import { asPlatform, isPersonTenant, runAsTenant } from "../tenant/context";

/*
 * 群聊与群组一对一挂接（设计稿 docs/specs/2026-11-13-group-unify.md 第 3.1、4.1、4.4、4.5 节）。
 *
 * `channels` 上熊宝自加、未进 Drizzle 的列，用 `sql` 片段读写（同 approvals/extra-columns.ts）：
 *
 *   channels.waker_group_id  uuid，可空，FK waker_groups ON DELETE SET NULL  0206
 *   channels.created_by      text，可空（0122 加，未进 Drizzle），只读
 *
 * 不写进 db/schema/core.ts（上游文件），同步上游零冲突。DRIZZLE 不知道这两列：任何对照真实数据库
 * 同步 schema 的做法（例如 `drizzle-kit push`）会把它们当成多余的列删掉。不要对部署的库那样做。
 *
 * 群聊一侧是真相（成员 `channel_agents`、回答顺序 `group_bot_threads`），`waker_group_members` 是
 * 镜像：按运行时回答顺序整体改写。名字的真相是频道的 `title ?? name`。
 *
 * 帧：每个方法先在 `platform` 帧读频道，按 `channelOwner` 定所有者，读真相、写群组与挂接都在
 * `runAsTenant(所有者)` 里。挂接触发器借这个帧的 RLS 判断群组是不是所有者的（0206）。
 *
 * 共享群的所有者会变（3.1.1）：创建者退群或被停用后，`created_by` 由 0207 的移交函数改成群里最早的在籍
 * 成员，群组连同头像、流程与看板一起搬过去。这里只经 `leave`（创建者本人退群）和 `handOver`（自愈点）
 * 调它；`reconcile`、`syncName`、`linkChannel` 不移交。
 */

type Log = (line: Record<string, unknown>) => void;

const logToStderr: Log = (line) => console.error(JSON.stringify(line));

/** Anything that can run one statement: the tenant-bound database or a transaction on it. */
type Executor = { execute: (query: SQL) => PromiseLike<unknown> };

/** `channels.waker_group_id`: the crew this conversation is linked to, or null. */
export const channelWakerGroupId: SQL<string | null> = sql<
  string | null
>`${channels}."waker_group_id"`;

/** `channels.created_by`: who opened the conversation (filled by the database from the frame). */
export const channelCreatedBy: SQL<string | null> = sql<
  string | null
>`${channels}."created_by"`;

/** Link (or, with null, unlink) a conversation and a crew. The database decides whether it may. */
export async function setChannelWakerGroup(
  executor: Executor,
  channelId: string,
  groupId: string | null,
): Promise<void> {
  await executor.execute(
    sql`update ${channels} set "waker_group_id" = ${groupId}::uuid where ${channels.id} = ${channelId}`,
  );
}

/**
 * 3.1 归属规则：team → created_by（为 NULL 则无所有者）；否则 tenant_id。
 *
 * 只有个人租户才是所有者（设计稿 2.8「群组永远属于某个个人租户」）：`system`、`platform`、`team`
 * 或空串一律无所有者。否则无帧旧代码戳成 `system` 的频道会建出一个所有租户都读得到的群组。
 */
export function channelOwner(row: {
  tenantId: string;
  createdBy: string | null;
}): string | null {
  const owner = row.tenantId === TEAM_TENANT ? row.createdBy : row.tenantId;
  return isPersonTenant(owner) ? owner : null;
}

/**
 * 3.1：只有群聊挂群组，单聊永远为 NULL。群聊 = 共享群（`team`），或员工至少 2 位、且不是任务会话
 * （tasks/runner.ts 给一件工作开的会话，只有一位员工）的个人旧频道。
 */
export function isGroupConversation(row: {
  tenantId: string;
  agentCount: number;
  task: boolean;
}): boolean {
  return row.tenantId === TEAM_TENANT || (row.agentCount >= 2 && !row.task);
}

const NAME_LIMIT = 80;

/**
 * At most `limit` characters, counted in code points: what 0207's `left()` and `length()` count when
 * a hand-over picks the name, so both sides agree on 80 for a name with emoji in it (4.4).
 */
function clip(text: string, limit: number) {
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join("");
}

/** The name a crew would take for `wanted` before any clash: trimmed, within 80 characters. */
const baseName = (wanted: string) => clip(wanted.trim(), NAME_LIMIT);

/** `body` with `suffix` after it, the body cut so the whole stays within 80 characters. */
const suffixed = (body: string, suffix: string) =>
  `${clip(body, NAME_LIMIT - Array.from(suffix).length)}${suffix}`;

/**
 * 4.4 取名：wanted 截 80 字；撞名依次「（2）」…「（99）」，再撞加 id 前 6 位；except 为自身 id
 * （改名时不与自己撞）。
 *
 * Runs in the executor's frame, so a clash is with any crew that frame can see — its own, and the
 * platform's, which it lists too. One read for all hundred candidates.
 */
export async function pickGroupName(
  executor: Executor,
  wanted: string,
  options: { except?: string; idForSuffix?: string } = {},
): Promise<string> {
  const base = baseName(wanted);
  const candidates = [base];
  for (let n = 2; n <= 99; n++) candidates.push(suffixed(base, `（${n}）`));
  const last = suffixed(
    base,
    (options.idForSuffix ?? randomUUID()).slice(0, 6),
  );
  const rows = (await executor.execute(
    sql`select ${wakerGroups.name} as name from ${wakerGroups}
         where ${wakerGroups.name} in ${[...candidates, last]}
           ${options.except ? sql`and ${wakerGroups.id} <> ${options.except}::uuid` : sql``}`,
  )) as { name: string }[];
  const taken = new Set(rows.map((row) => row.name));
  return candidates.find((name) => !taken.has(name)) ?? last;
}

/**
 * 运行时回答顺序（与 group.ts 的 orderedRoster 同一规则）：取全部 bots；在 order 里的按其位置在前，
 * 不在的排在后面，同名次按 id localeCompare。order 里已不在 bots 的 id 丢弃。
 */
export function runtimeOrder(order: string[], bots: string[]): string[] {
  const rank = (id: string) => {
    const at = order.indexOf(id);
    return at < 0 ? order.length : at;
  };
  return [...bots].sort(
    (left, right) => rank(left) - rank(right) || left.localeCompare(right),
  );
}

export type WakerGroupLink = {
  /**
   * 未挂接时：所有者帧里一个事务建群组（名字 = title ?? name，经 pickGroupName）、写镜像、挂接；已挂接返回原 id；无所有者返回 null。
   *
   * 频道已软删且未挂接时返回 null，不建群组。不是群聊（单聊、任务会话，见 isGroupConversation）时也返回 null。已挂接时即使频道已软删，也返回原 id。
   * 同一频道并发调用时，输掉的一方返回赢家挂上的 id。
   * 未挂接而所有者帧读不到这个频道（创建者已不是成员）时，记 waker-group-owner-gone 并返回 null。
   * 已挂接时只返回原 id，不重算镜像，也就不受这条规则影响。
   */
  linkChannel(channelId: string): Promise<string | null>;
  /**
   * 把已有群组挂到频道：一个事务里挂接、title 改成群组名、改写镜像。
   *
   * 挂接是原子条件写：频道未删除，且未挂接或已挂的就是这个群组（重复 adopt 幂等）。已挂别的群组、
   * 已软删或没有这个频道时抛错，什么都不改。
   */
  adopt(groupId: string, channelId: string): Promise<void>;
  /**
   * 4.5：按 runtimeOrder(order(), bots()) 改写镜像，title ?? name 与群组名不同时改名（撞名保留原名并记日志）；未挂接返回 false。
   *
   * 所有者帧读不到这个频道（共享群的创建者已不是成员）时，什么都不改：读名单之前读不到，或者写镜像的
   * 事务里重读频道行（`for share`，先于写镜像，锁到提交）读不到、创建者已换人，都整体回滚。然后重读一次
   * 所有者：换了人（移交了）就在新所有者帧重做一次；没换，记 {"type":"waker-group-owner-gone","channelId"}
   * 并返回 false。一次调用最多记一行。不移交（3.1.1 第 4.4 条）。
   */
  reconcile(channelId: string): Promise<boolean>;
  /**
   * 频道改名后同步群组名；撞名保留原名，记 {"type":"waker-group-name-taken","channelId","groupId","name"}。
   * 所有者帧读不到这个频道时同 reconcile：不改名，记 waker-group-owner-gone。
   */
  syncName(channelId: string): Promise<void>;
  /** 挂着它的未删除频道，调用者帧下读得到才返回。 */
  liveChannelOf(groupId: string): Promise<string | null>;
  /**
   * 创建者本人退群（3.1.1 第 4.2 条）：owner 帧一个事务：
   * `select … from channels where id = $1 and deleted_at is null for update`（要求 tenant_id = 'team'、created_by = owner）
   * → 删自己的成员行与 intelligence_channel_mappings → select xiongbao_team_channel_hand_over($1)。
   * 读不到、不是 team、或不是创建者时返回 null（交给上游）。55006 时整体回滚，抛 GroupRefusedError("有组团流程正在运行，先停下再退群。")。
   *
   * `heir`：接手的人；没有人接手时为 null（最后一人离开、聊天已软删，或只剩停用的成员）。
   */
  leave(
    owner: string,
    channelId: string,
  ): Promise<{ heir: string | null } | null>;
  /**
   * 在当前帧调 xiongbao_team_channel_hand_over；55006 时记 {"type":"waker-group-hand-over-deferred","channelId"}，
   * 返回 deferred。`owner` 是调用之后的所有者（不是共享群、没有创建者或聊天已删时为 null，推迟时也为 null）。
   */
  handOver(
    channelId: string,
  ): Promise<{ owner: string | null; deferred: boolean }>;
};

type ChannelFacts = {
  tenantId: string;
  createdBy: string | null;
  /** What the conversation is called: its title when it has one, else its name. */
  called: string;
  groupId: string | null;
  deleted: boolean;
  /** Bots on the channel, and whether it is a task's own conversation: see isGroupConversation. */
  agentCount: number;
  task: boolean;
};

/** Thrown inside the link transaction when another writer linked the channel first. */
class AlreadyLinked extends Error {}

/** Thrown inside the mirror's transaction when the owner no longer holds the channel: undoes the write. */
class OwnerLeft extends Error {}

/** 3.1.1: what the person who started a group is told when a crew run stops them leaving. */
const RUN_STILL_GOING = "有组团流程正在运行，先停下再退群。";

/** What 0207's write function leaves for the app when it hands a group over (`xiongbao.hand_over`). */
type HandedOver = {
  channelId: string;
  from: string;
  to: string;
  groupId: string | null;
  runs: number;
};

/**
 * 0207's one function the app may call: in the executor's frame, it hands a shared group whose creator
 * has left or been deactivated to its earliest member, and answers who owns it afterwards. `moved` is
 * the hand-over this call made, read back from the transaction it ran in; null when nothing moved.
 * The executor must be a transaction: the note is local to it.
 */
async function handOverIn(executor: Executor, channelId: string) {
  const [row] = (await executor.execute(
    sql`select public.xiongbao_team_channel_hand_over(${channelId}) as owner`,
  )) as { owner: string | null }[];
  const [note] = (await executor.execute(
    sql`select current_setting('xiongbao.hand_over', true) as moved`,
  )) as { moved: string | null }[];
  const moved = note?.moved ? (JSON.parse(note.moved) as HandedOver) : null;
  return {
    owner: row?.owner ?? null,
    moved: moved?.channelId === channelId ? moved : null,
  };
}

/** The SQLSTATE drizzle wraps; Bun reports it as `errno` (see store.ts `create`). */
export const stateOf = (error: unknown) => {
  const failure = error as {
    errno?: string | number;
    cause?: { errno?: string | number };
  };
  return String(failure.errno ?? failure.cause?.errno ?? "");
};

export function createWakerGroupLink(deps: {
  database: Database;
  groupStore: Pick<GroupStore, "order" | "bots">;
  log?: Log;
}): WakerGroupLink {
  const { database, groupStore } = deps;
  const log = deps.log ?? logToStderr;

  /** The channel as `platform` reads it, or null when there is no such row. */
  async function facts(channelId: string): Promise<ChannelFacts | null> {
    const rows = (await asPlatform(() =>
      database.execute(
        sql`select ${channels.tenantId} as tenant_id, ${channelCreatedBy} as created_by,
                   ${channels.title} as title, ${channels.name} as name,
                   ${channelWakerGroupId} as waker_group_id,
                   ${channels.deletedAt} is not null as deleted,
                   (select count(*)::int from ${channelAgents}
                     where ${channelAgents.channelId} = ${channels.id}) as agent_count,
                   exists (select 1 from ${botTasks}
                            where ${botTasks.channelId} = ${channels.id}) as task
              from ${channels} where ${channels.id} = ${channelId}`,
      ),
    )) as unknown as {
      tenant_id: string;
      created_by: string | null;
      title: string | null;
      name: string;
      waker_group_id: string | null;
      deleted: boolean;
      agent_count: number;
      task: boolean;
    }[];
    const [row] = rows;
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      createdBy: row.created_by,
      called: row.title?.trim() ? row.title : row.name,
      groupId: row.waker_group_id,
      deleted: row.deleted,
      agentCount: Number(row.agent_count),
      task: row.task,
    };
  }

  /** The conversation's Bots in the order they answer: the mirror's contents. Owner's frame. */
  async function truth(channelId: string) {
    const [order, bots] = await Promise.all([
      groupStore.order(channelId),
      groupStore.bots(channelId),
    ]);
    return runtimeOrder(order, bots);
  }

  /**
   * Rewrite the crew's roster to `agentIds` wholesale, the way `store.setMembers` writes it, without
   * its visibility check: the conversation already vouched for every Bot in it.
   */
  async function writeMirror(
    tx: Pick<Database, "delete" | "insert" | "update">,
    groupId: string,
    agentIds: string[],
  ) {
    await tx
      .delete(wakerGroupMembers)
      .where(eq(wakerGroupMembers.groupId, groupId));
    if (agentIds.length > 0)
      await tx.insert(wakerGroupMembers).values(
        agentIds.map((agentId, position) => ({
          groupId,
          agentId,
          position: String(position),
        })),
      );
    await tx
      .update(wakerGroups)
      .set({ updatedAt: new Date() })
      .where(eq(wakerGroups.id, groupId));
  }

  /**
   * Give the crew the conversation's name, unless another crew of the owner's already has it: then
   * the crew keeps its own and the line is logged (4.4). Owner's frame.
   */
  async function followName(
    channelId: string,
    groupId: string,
    called: string,
  ) {
    const [group] = await database
      .select({ name: wakerGroups.name })
      .from(wakerGroups)
      .where(eq(wakerGroups.id, groupId))
      .limit(1);
    if (!group) return;
    const wanted = baseName(called);
    if (wanted.length === 0 || group.name === wanted) return;
    const taken = () =>
      log({ type: "waker-group-name-taken", channelId, groupId, name: wanted });
    const picked = await pickGroupName(database, wanted, {
      except: groupId,
      idForSuffix: groupId,
    });
    // Already the clash-free form of the title (say 「周报（2）」 for 「周报」): nothing to say or do.
    if (picked === group.name) return;
    if (picked !== wanted) return taken();
    try {
      await database
        .update(wakerGroups)
        .set({ name: wanted, updatedAt: new Date() })
        .where(eq(wakerGroups.id, groupId));
    } catch (error) {
      // Taken between the read and the write.
      if (stateOf(error) === "23505") return taken();
      throw error;
    }
  }

  /**
   * Whether the owner's own frame can read the channel row: false once the creator of a shared group
   * is no longer a member of it (`team_read`). In that frame the conversation's Bots and order read
   * as empty, and a mirror written from them would wipe the crew, so nothing is written. A leave
   * through the service hands the group over at once (3.1.1); one past the service (a membership
   * deleted straight, an account deleted by an operator) leaves this state until a heal hands it
   * over. Owner's frame.
   *
   * Asked of the row itself, not of an empty roster: an empty roster can be the truth.
   */
  async function sees(channelId: string) {
    const rows = (await database.execute(
      sql`select 1 as seen from ${channels} where ${channels.id} = ${channelId}`,
    )) as unknown[];
    return rows.length > 0;
  }

  /** `sees`, and when not, the line that says so. */
  async function ownerSees(channelId: string) {
    if (await sees(channelId)) return true;
    log({ type: "waker-group-owner-gone", channelId });
    return false;
  }

  /**
   * One pass of the self-heal in `owner`'s frame: false when the owner cannot read the channel before
   * the roster is read, or when the transaction that writes the mirror finds the row gone from their
   * frame or another owner on it. The check inside the transaction closes the window between the two
   * (3.1.1 第 8 条): the roster may have been read just after the owner left, in a frame that then
   * read it as empty.
   *
   * The channel row is share-locked first, then the mirror is written: the order a leave takes its
   * locks in (the channel row, then the crew's), so the two queue rather than deadlock. Held to the
   * commit, the lock makes a leave that comes after wait for this write. A leave that got there
   * first and handed the group over is seen in the row the lock returns (`created_by` is no longer
   * the owner), and undoes the write the same way.
   */
  async function mirrorAs(
    owner: string,
    channelId: string,
    groupId: string,
    called: string,
  ) {
    return runAsTenant(owner, async () => {
      if (!(await sees(channelId))) return false;
      const members = await truth(channelId);
      try {
        await database.transaction(async (tx) => {
          const held = (await tx.execute(
            sql`select ${channels.tenantId} as tenant_id, ${channelCreatedBy} as created_by
                  from ${channels} where ${channels.id} = ${channelId} for share`,
          )) as unknown as { tenant_id: string; created_by: string | null }[];
          const [row] = held;
          if (
            !row ||
            channelOwner({
              tenantId: row.tenant_id,
              createdBy: row.created_by,
            }) !== owner
          )
            throw new OwnerLeft();
          await writeMirror(tx, groupId, members);
        });
      } catch (error) {
        if (error instanceof OwnerLeft) return false;
        throw error;
      }
      await followName(channelId, groupId, called);
      return true;
    });
  }

  /**
   * A hand-over that committed, in the log: whose the group was, whose it is, how many runs went with
   * it (3.1.1 第 5 条). A deactivation's hand-over has only 0207's server-log line.
   */
  function handedOver(moved: HandedOver | null) {
    if (moved) log({ type: "waker-group-handed-over", ...moved });
  }

  /** The channel's facts and its owner, when it has one. */
  async function owned(channelId: string) {
    const channel = await facts(channelId);
    if (!channel) return null;
    const owner = channelOwner(channel);
    return owner ? { channel, owner } : null;
  }

  return {
    async linkChannel(channelId) {
      const found = await owned(channelId);
      if (!found) return null;
      const { channel, owner } = found;
      if (channel.groupId) return channel.groupId;
      // A one-on-one chat or a task's conversation is never a crew's (3.1).
      if (channel.deleted || !isGroupConversation(channel)) return null;
      try {
        return await runAsTenant(owner, async () => {
          if (!(await ownerSees(channelId))) return null;
          const members = await truth(channelId);
          const groupId = randomUUID();
          await database.transaction(async (tx) => {
            const name = await pickGroupName(tx, channel.called, {
              idForSuffix: groupId,
            });
            await tx.insert(wakerGroups).values({ id: groupId, name });
            await writeMirror(tx, groupId, members);
            // Only while still unlinked: a second linker loses the race and keeps the first crew.
            const linked = (await tx.execute(
              sql`update ${channels} set "waker_group_id" = ${groupId}::uuid
                   where ${channels.id} = ${channelId} and "waker_group_id" is null
                   returning ${channels.id}`,
            )) as unknown[];
            if (linked.length === 0) throw new AlreadyLinked();
          });
          return groupId;
        });
      } catch (error) {
        /*
         * Lost the race. Either the winner had committed before this one tried to link
         * (AlreadyLinked), or both picked the same name at once and this insert waited on the
         * winner's row in `waker_groups_tenant_name_idx` (23505). Either way the winner's crew is
         * the answer; a 23505 with the channel still unlinked is a real clash and is thrown.
         */
        if (!(error instanceof AlreadyLinked) && stateOf(error) !== "23505")
          throw error;
        const linked = (await facts(channelId))?.groupId ?? null;
        if (linked === null && !(error instanceof AlreadyLinked)) throw error;
        return linked;
      }
    },

    async adopt(groupId, channelId) {
      const found = await owned(channelId);
      if (!found)
        throw new Error(`channel ${channelId} has no owner to adopt a crew`);
      await runAsTenant(found.owner, async () => {
        const members = await truth(channelId);
        await database.transaction(async (tx) => {
          const [group] = await tx
            .select({ name: wakerGroups.name })
            .from(wakerGroups)
            .where(eq(wakerGroups.id, groupId))
            .limit(1);
          if (!group) throw new Error(`crew ${groupId} is not the owner's`);
          const linked = (await tx.execute(
            sql`update ${channels} set "waker_group_id" = ${groupId}::uuid
                 where ${channels.id} = ${channelId} and ${channels.deletedAt} is null
                   and ("waker_group_id" is null or "waker_group_id" = ${groupId}::uuid)
                 returning ${channels.id}`,
          )) as unknown[];
          if (linked.length === 0)
            throw new Error(
              `channel ${channelId} is deleted or linked to another crew`,
            );
          await tx
            .update(channels)
            .set({ title: group.name, updatedAt: new Date() })
            .where(eq(channels.id, channelId));
          await writeMirror(tx, groupId, members);
        });
      });
    },

    async reconcile(channelId) {
      const found = await owned(channelId);
      const groupId = found?.channel.groupId;
      if (!found || !groupId) return false;
      if (await mirrorAs(found.owner, channelId, groupId, found.channel.called))
        return true;
      /*
       * The owner could not read the channel. A leave may have handed the group over meanwhile: then
       * the mirror is the new owner's to write, once. Otherwise the owner has gone past the service
       * (3.1.1 第 8 条) and that is said once for the call.
       */
      const again = await owned(channelId);
      if (
        again &&
        again.owner !== found.owner &&
        again.channel.groupId === groupId &&
        (await mirrorAs(again.owner, channelId, groupId, again.channel.called))
      )
        return true;
      log({ type: "waker-group-owner-gone", channelId });
      return false;
    },

    async syncName(channelId) {
      const found = await owned(channelId);
      const groupId = found?.channel.groupId;
      if (!found || !groupId) return;
      await runAsTenant(found.owner, async () => {
        if (await ownerSees(channelId))
          await followName(channelId, groupId, found.channel.called);
      });
    },

    async liveChannelOf(groupId) {
      const rows = (await database.execute(
        sql`select ${channels.id} as id from ${channels}
             where ${channelWakerGroupId} = ${groupId}::uuid and ${channels.deletedAt} is null
             limit 1`,
      )) as unknown as { id: string }[];
      return rows[0]?.id ?? null;
    },

    async leave(owner, channelId) {
      try {
        return await runAsTenant(owner, () =>
          database.transaction(async (tx) => {
            // The lock upstream's `lockedBots` takes: a Bot change and a leave line up one by one.
            const [row] = (await tx.execute(
              sql`select ${channels.tenantId} as tenant_id, ${channelCreatedBy} as created_by
                    from ${channels}
                   where ${channels.id} = ${channelId} and ${channels.deletedAt} is null
                   for update`,
            )) as unknown as { tenant_id: string; created_by: string | null }[];
            if (
              !row ||
              row.tenant_id !== TEAM_TENANT ||
              row.created_by !== owner
            )
              return null;
            const removed = await tx
              .delete(channelMemberships)
              .where(
                sql`${channelMemberships.channelId} = ${channelId} and ${channelMemberships.userId} = ${owner}`,
              )
              .returning({ userId: channelMemberships.userId });
            if (removed.length === 0) return null;
            await tx
              .delete(intelligenceChannelMappings)
              .where(
                sql`${intelligenceChannelMappings.channelId} = ${channelId} and ${intelligenceChannelMappings.userId} = ${owner}`,
              );
            const { owner: now, moved } = await handOverIn(tx, channelId);
            return { heir: now && now !== owner ? now : null, moved };
          }),
        ).then((left) => {
          if (!left) return null;
          handedOver(left.moved);
          return { heir: left.heir };
        });
      } catch (error) {
        if (stateOf(error) === "55006")
          throw new GroupRefusedError(RUN_STILL_GOING);
        throw error;
      }
    },

    async handOver(channelId) {
      try {
        const { owner, moved } = await database.transaction((tx) =>
          handOverIn(tx, channelId),
        );
        handedOver(moved);
        return { owner, deferred: false };
      } catch (error) {
        if (stateOf(error) !== "55006") throw error;
        log({ type: "waker-group-hand-over-deferred", channelId });
        return { owner: null, deferred: true };
      }
    },
  };
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The four group writes that change who is in a conversation, or the order they answer in, and the
 * leave that changes who owns it.
 */
type LinkedGroupWrites = Pick<
  GroupConversations,
  "create" | "addBots" | "removeBots" | "reorder" | "removeMember"
>;

/**
 * 4.2 写入口：群聊服务的四个写操作在上游成功之后同步群组。上游的校验（创建者、可用员工、2–20 位）
 * 一条不少地先跑，上游抛错就原样抛出，什么都不同步。同步失败只记日志，不让写操作失败：镜像与名字
 * 由 4.5 自愈补齐。
 *
 * create：上游建完后 linkChannel，失败记 {"type":"waker-group-link-failed","channelId","error"}，
 * 返回 null（没有所有者、频道已删或所有者已不是成员）记 {"type":"waker-group-link-skipped","channelId"}；
 * 返回 { ...channel, wakerGroupId?: string }。
 * addBots/removeBots/reorder：上游成功后 reconcile(channel)，失败记
 * {"type":"waker-group-reconcile-failed","channelId","error"}。
 * removeMember：创建者本人退共享群（3.1.1 第 2、4.2 条）不走上游（上游不许他在别人还在时退），改由
 * link.leave 在一个事务里退群并移交；有人接手就在接手人帧 reconcile 一次，失败只记日志。别人退群、
 * 创建者移别人、个人频道，或者 leave 认不出（返回 null），都照旧交给上游。其余成员原样透传。
 */
export function withWakerGroupLink<T extends LinkedGroupWrites>(
  groups: T,
  link: WakerGroupLink,
  log: Log = logToStderr,
): T & {
  create(
    owner: string,
    input: unknown,
  ): Promise<Awaited<ReturnType<T["create"]>> & { wakerGroupId?: string }>;
} {
  type Made = Awaited<ReturnType<T["create"]>> & { wakerGroupId?: string };

  async function reconciled<R>(channelId: string, write: Promise<R>) {
    const result = await write;
    try {
      await link.reconcile(channelId);
    } catch (error) {
      log({
        type: "waker-group-reconcile-failed",
        channelId,
        error: messageOf(error),
      });
    }
    return result;
  }

  return {
    ...groups,
    async create(owner: string, input: unknown): Promise<Made> {
      const channel = (await groups.create(owner, input)) as Made;
      try {
        const wakerGroupId = await link.linkChannel(channel.id);
        if (wakerGroupId) return { ...channel, wakerGroupId };
        // No owner to give it a crew, or already deleted: it stays unlinked, and says so.
        log({ type: "waker-group-link-skipped", channelId: channel.id });
        return channel;
      } catch (error) {
        log({
          type: "waker-group-link-failed",
          channelId: channel.id,
          error: messageOf(error),
        });
        return channel;
      }
    },
    addBots: (owner: string, channel: string, input: string[]) =>
      reconciled(channel, groups.addBots(owner, channel, input)),
    removeBots: (owner: string, channel: string, input: string[]) =>
      reconciled(channel, groups.removeBots(owner, channel, input)),
    reorder: (owner: string, channel: string, input: string[]) =>
      reconciled(channel, groups.reorder(owner, channel, input)),
    async removeMember(owner: string, channel: string, userId: string) {
      if (userId !== owner) return groups.removeMember(owner, channel, userId);
      const left = await link.leave(owner, channel);
      if (left === null) return groups.removeMember(owner, channel, userId);
      if (left.heir) {
        try {
          await link.reconcile(channel);
        } catch (error) {
          log({
            type: "waker-group-reconcile-failed",
            channelId: channel,
            error: messageOf(error),
          });
        }
      }
    },
  };
}

/**
 * 4.4 改名：经 channelStore.rename 给频道改名的路径（改名对话框 PUT /api/channels/:id/title、
 * propose_group_change 的改名步骤；PATCH /api/waker-groups/:id 已在 Task 4 接入，也走这里），上游成功
 * 之后 link.syncName(channelId)，挂接的群组跟着改名；没挂接的什么都不做。上游的「只有发起人能改」照旧先跑。
 * 同步失败只记 {"type":"waker-group-name-sync-failed","channelId","error"}，不让改名失败。
 */
export function withChannelRenameLink(
  store: ChannelStore,
  link: WakerGroupLink,
  log: Log = logToStderr,
): ChannelStore {
  return {
    ...store,
    async rename(actor, channelId, title) {
      const called = await store.rename(actor, channelId, title);
      try {
        await link.syncName(channelId);
      } catch (error) {
        log({
          type: "waker-group-name-sync-failed",
          channelId,
          error: messageOf(error),
        });
      }
      return called;
    },
  };
}
