import { randomUUID } from "node:crypto";
import { eq, type SQL, sql } from "drizzle-orm";
import type { GroupStore } from "../channels/group";
import type { Database } from "../db/client";
import { channels, wakerGroupMembers, wakerGroups } from "../db/schema";
import { TEAM_TENANT } from "../db/schema/tenant";
import { asPlatform, runAsTenant } from "../tenant/context";

/*
 * 群聊与群组一对一挂接（设计稿 docs/specs/2026-11-13-group-unify.md 第 3.1、4.1、4.4、4.5 节）。
 *
 * `channels` 上熊宝自加、未进 Drizzle 的列，用 `sql` 片段读写（同 approvals/extra-columns.ts）：
 *
 *   channels.waker_group_id  uuid，可空，FK waker_groups ON DELETE SET NULL  0205
 *   channels.created_by      text，可空（0122 加，未进 Drizzle），只读
 *
 * 不写进 db/schema/core.ts（上游文件），同步上游零冲突。DRIZZLE 不知道这两列：任何对照真实数据库
 * 同步 schema 的做法（例如 `drizzle-kit push`）会把它们当成多余的列删掉。不要对部署的库那样做。
 *
 * 群聊一侧是真相（成员 `channel_agents`、回答顺序 `group_bot_threads`），`waker_group_members` 是
 * 镜像：按运行时回答顺序整体改写。名字的真相是频道的 `title ?? name`。
 *
 * 帧：每个方法先在 `platform` 帧读频道，按 `channelOwner` 定所有者，读真相、写群组与挂接都在
 * `runAsTenant(所有者)` 里。挂接触发器借这个帧的 RLS 判断群组是不是所有者的（0205）。
 */

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

/** 3.1 归属规则：team → created_by（为 NULL 则无所有者）；否则 tenant_id。 */
export function channelOwner(row: {
  tenantId: string;
  createdBy: string | null;
}): string | null {
  return row.tenantId === TEAM_TENANT ? row.createdBy : row.tenantId;
}

const NAME_LIMIT = 80;

/** At most `limit` UTF-16 units, never ending in half of a surrogate pair. */
function clip(text: string, limit: number) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The name a crew would take for `wanted` before any clash: trimmed, within 80 characters. */
const baseName = (wanted: string) => clip(wanted.trim(), NAME_LIMIT);

/** `body` with `suffix` after it, the body cut so the whole stays within 80 characters. */
const suffixed = (body: string, suffix: string) =>
  `${clip(body, NAME_LIMIT - suffix.length)}${suffix}`;

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
  /** 未挂接时：所有者帧里一个事务建群组（名字 = title ?? name，经 pickGroupName）、写镜像、挂接；已挂接返回原 id；无所有者返回 null。 */
  linkChannel(channelId: string): Promise<string | null>;
  /** 把已有群组挂到频道：一个事务里挂接、title 改成群组名、改写镜像。 */
  adopt(groupId: string, channelId: string): Promise<void>;
  /** 4.5：按 runtimeOrder(order(), bots()) 改写镜像，title ?? name 与群组名不同时改名（撞名保留原名并记日志）；未挂接返回 false。 */
  reconcile(channelId: string): Promise<boolean>;
  /** 频道改名后同步群组名；撞名保留原名，记 {"type":"waker-group-name-taken","channelId","groupId","name"}。 */
  syncName(channelId: string): Promise<void>;
  linkedGroupOf(channelId: string): Promise<string | null>;
  /** 挂着它的未删除频道，调用者帧下读得到才返回。 */
  liveChannelOf(groupId: string): Promise<string | null>;
};

type ChannelFacts = {
  tenantId: string;
  createdBy: string | null;
  /** What the conversation is called: its title when it has one, else its name. */
  called: string;
  groupId: string | null;
  deleted: boolean;
};

/** Thrown inside the link transaction when another writer linked the channel first. */
class AlreadyLinked extends Error {}

/** The SQLSTATE drizzle wraps; Bun reports it as `errno` (see store.ts `create`). */
const stateOf = (error: unknown) => {
  const failure = error as {
    errno?: string | number;
    cause?: { errno?: string | number };
  };
  return String(failure.errno ?? failure.cause?.errno ?? "");
};

export function createWakerGroupLink(deps: {
  database: Database;
  groupStore: Pick<GroupStore, "order" | "bots">;
  log?: (line: Record<string, unknown>) => void;
}): WakerGroupLink {
  const { database, groupStore } = deps;
  const log =
    deps.log ??
    ((line: Record<string, unknown>) => console.error(JSON.stringify(line)));

  /** The channel as `platform` reads it, or null when there is no such row. */
  async function facts(channelId: string): Promise<ChannelFacts | null> {
    const rows = (await asPlatform(() =>
      database.execute(
        sql`select ${channels.tenantId} as tenant_id, ${channelCreatedBy} as created_by,
                   ${channels.title} as title, ${channels.name} as name,
                   ${channelWakerGroupId} as waker_group_id,
                   ${channels.deletedAt} is not null as deleted
              from ${channels} where ${channels.id} = ${channelId}`,
      ),
    )) as unknown as {
      tenant_id: string;
      created_by: string | null;
      title: string | null;
      name: string;
      waker_group_id: string | null;
      deleted: boolean;
    }[];
    const [row] = rows;
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      createdBy: row.created_by,
      called: row.title?.trim() ? row.title : row.name,
      groupId: row.waker_group_id,
      deleted: row.deleted,
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
    if ((await pickGroupName(database, wanted, { except: groupId })) !== wanted)
      return taken();
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
      if (channel.deleted) return null;
      try {
        return await runAsTenant(owner, async () => {
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
        if (!(error instanceof AlreadyLinked)) throw error;
        return (await facts(channelId))?.groupId ?? null;
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
          await setChannelWakerGroup(tx, channelId, groupId);
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
      await runAsTenant(found.owner, async () => {
        const members = await truth(channelId);
        await database.transaction((tx) => writeMirror(tx, groupId, members));
        await followName(channelId, groupId, found.channel.called);
      });
      return true;
    },

    async syncName(channelId) {
      const found = await owned(channelId);
      const groupId = found?.channel.groupId;
      if (!found || !groupId) return;
      await runAsTenant(found.owner, () =>
        followName(channelId, groupId, found.channel.called),
      );
    },

    async linkedGroupOf(channelId) {
      return (await facts(channelId))?.groupId ?? null;
    },

    async liveChannelOf(groupId) {
      const rows = (await database.execute(
        sql`select ${channels.id} as id from ${channels}
             where ${channelWakerGroupId} = ${groupId}::uuid and ${channels.deletedAt} is null
             limit 1`,
      )) as unknown as { id: string }[];
      return rows[0]?.id ?? null;
    },
  };
}
