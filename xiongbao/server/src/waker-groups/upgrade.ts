import { eq, type SQL, sql } from "drizzle-orm";
import postgres from "postgres";
import type { GroupConversations, GroupStore } from "../channels/group";
import type { Database } from "../db/client";
import { wakerGroupMembers } from "../db/schema";
import { TEAM_TENANT } from "../db/schema/tenant";
import { asPlatform, isPersonTenant, runAsTenant } from "../tenant/context";
import { channelOwner, stateOf, type WakerGroupLink } from "./channel-link";
import {
  type ConversionClaims,
  MAX_MEMBERS,
  MIN_MEMBERS,
} from "./linked-actions";

/*
 * 开机升级任务（设计稿 docs/specs/2026-11-13-group-unify.md 第 5 节）。第一阶段：已有群组转成可以聊天的群组。
 *
 * 在 `platform` 帧枚举 `waker_groups`，逐项按 5.1 的表格处理，台账 `waker_group_upgrades`（0211）记下每一项的
 * 结果。聊天沿用上游的建群路径，在所有者帧（`runAsTenant(owner)`）里建，权限检查、`team` 戳、成员行和线程行
 * 都与平时建群一样；挂接、改名、写镜像交给 `link.adopt`。台账一律在 `platform` 帧写，`tenant_id` 与
 * `original_owner` 都是群组当时的所有者；`original_owner` 之后不改（0212 收回了这一列的 UPDATE 权限）。
 *
 * 转换分五步（5.1 规则 6）：① 台账 `started`（被筛掉的员工记进 `dropped_agent_ids`）；② 建聊天；③ 台账记
 * `channel_id`；④ `adopt`；⑤ 台账 `converted`。每一步之间都可能崩溃，下次开机从台账续做（5.3）：
 * - `started`、有 `channel_id`：从 ④ 续做（`adopt` 对已挂上的同一个群组幂等）。
 * - `started`、没有 `channel_id`：先找 ② 建出来的「孤儿」（`orphanOf`），找到从 ③ 续做；找不到就从规则 3 起
 *   重新判断，① 改写原行（`original_owner` 不动），再建。
 * - 其余结果都是终态，不再处理。
 *
 * 规则 2 从严：任何频道挂过的群组都不处理，挂着的频道已软删的也算（表格写的是「未删除」）。频道上这一列 0206
 * 才有，挂过频道的群组都是新代码建的或挂过的，不是升级前的老群组。最后一人退群（Q6）或频道被删之后，群组仍归
 * 所有者、状态是「未开始聊天」，要不要再开聊天由他决定，开机任务不替他重开。
 *
 * 装包不写 `waker_groups`（写它的只有 store.ts、channel-link.ts 与 WakerFlow），没有装包来的群组需要排除。
 *
 * Task 14 补的几条（控制方裁定）：
 * - `started` 行记下的聊天后来被删了：不再续做，也不记日志，群组留着、聊天不重开（与规则 2 从严同理）。
 * - ④ 撞上唯一挂接索引（转换途中本人从群组页给同一群组开了聊天），或下次开机发现群组已挂着别的未删聊天：
 *   以已挂上的那个为准，台账 `converted`；这次转换建的聊天没有消息就软删，有消息就留着并
 *   记一行 {"type":"waker-group-upgrade-chat-kept","groupId","channelId","linkedChannelId"}。
 * - 台账的 `channel_id` 只记这次转换自己建的聊天（续做时是台账记下的或收养的孤儿），可以为空，从不指向本人
 *   自己开的聊天：回滚手册第 1 步按它软删，本人的聊天不能被当成转换建的删掉（控制方裁定 2026-11-13）。
 * - 所有者一个角色都没有（`hasRole` 为假，生产里 `actorFor` 会抛错），或已被停用（地址在 `revoked_access`，
 *   与 0207 一样算退群）：记 `no_owner`，不问 `canUse`。
 * - 第二阶段软删的、没有人类成员的老共享群聊（`handOver` 无人可交）记一行
 *   {"type":"waker-group-upgrade-chat-dropped","channelId"}。
 * - 收养孤儿时补一次上游的 `seedOrder`：孤儿可能是在上游「建频道」与「种顺序」两步之间崩溃留下的。
 *
 * 单项失败记 {"type":"waker-group-upgrade-item-failed","groupId","error"}，继续下一项。
 *
 * 第二阶段（5.4）：已有群聊补群组，台账 `backfilled`。第三阶段（4.5）：已挂接的聊天各自愈一次。两个阶段对
 * 共享群都先在 `platform` 帧移交一次（3.1.1 第 4.4 条）。装包物化的频道不是群组，第二阶段不碰。被未完成的
 * 转换占用的频道（`createConversionClaims`）第二阶段跳过，留给第一阶段续做。单项失败记
 * {"type":"waker-group-upgrade-item-failed","channelId","error"}。
 *
 * `runGroupUpgrade` 一个副本跑（咨询锁），`XIONGBAO_GROUP_UPGRADE=off` 整个跳过；结束打一行汇总
 * {"type":"waker-group-upgrade",…}。`startGroupUpgrade` 是开机时的后台装配。
 */

export type GroupUpgradeDeps = {
  database: Database;
  /**
   * The undecorated `baseGroupConversations`: the crew already exists, `adopt` links it. Its `store`
   * seeds the answering order of an adopted orphan.
   */
  groups: Pick<GroupConversations, "create" | "store">;
  link: WakerGroupLink;
  /** The groups service's own `canUseBot` (S/index.ts): the owner can read the Bot's profile. */
  canUse(ownerUserId: string, agentId: string): Promise<boolean>;
  /**
   * Whether the person holds a role `actorFor` (S/index.ts) acts for: `admin` or `user`, or anyone in
   * single-user mode. Asked before `canUse`, which throws for anyone else.
   */
  hasRole(userId: string): Promise<boolean>;
  /** Asked between items and between phases: true once the server is shutting down. */
  stopped?: () => boolean;
  log?: (line: Record<string, unknown>) => void;
};

export type PhaseOneCounts = {
  converted: number;
  pending: number;
  tooMany: number;
  noOwner: number;
};

type Outcome =
  | "started"
  | "converted"
  | "backfilled"
  | "pending_members"
  | "too_many"
  | "no_owner";

/** Outcomes the task never comes back to (5.3); only `started` is picked up again. */
const SETTLED = new Set<string>([
  "converted",
  "backfilled",
  "pending_members",
  "too_many",
  "no_owner",
]);

/** Which count each outcome of this phase adds to. */
const COUNTED: Partial<Record<Outcome, keyof PhaseOneCounts>> = {
  converted: "converted",
  pending_members: "pending",
  too_many: "tooMany",
  no_owner: "noOwner",
};

/** A `text[]` value, empty included: a JS array in `sql` becomes a list of parameters, not an array. */
export function textArray(values: readonly string[]): SQL {
  return values.length > 0
    ? sql`ARRAY[${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )}]::text[]`
    : sql`'{}'::text[]`;
}

/**
 * 5.3's orphan of the ledger row aliased `l`: the chat a crash left between ② and ③. A shared group
 * the owner started since the conversion started, still unlinked and not hidden, whose Bots are
 * exactly the crew's roster less the ones the conversion left out. The oldest, when there is more
 * than one. Never a package's channel (user decision 2026-11-13: not a crew's, and `adopt` refuses
 * it). Phase 1 adopts by it and `claimedBy` keeps phase 2 and for-channel off it: one condition.
 */
const ORPHAN_OF_LEDGER_ROW = sql`(
  select c.id from channels c
   where c.tenant_id = 'team' and c.created_by = l.tenant_id
     and c.waker_group_id is null and c.deleted_at is null and c.package_id is null
     and c.created_at >= l.started_at
     and array(select a.agent_id from channel_agents a
                where a.channel_id = c.id order by a.agent_id)
       = array(select m.agent_id from waker_group_members m
                where m.group_id = l.group_id
                  and m.agent_id <> all (l.dropped_agent_ids)
                order by m.agent_id)
   order by c.created_at, c.id
   limit 1)`;

/**
 * The crew's roster in `position` order, the order the crew pages show it in (store.ts `shape`).
 * In the caller's frame.
 */
async function rosterOf(database: Database, groupId: string) {
  const rows = await database
    .select({
      agentId: wakerGroupMembers.agentId,
      position: wakerGroupMembers.position,
    })
    .from(wakerGroupMembers)
    .where(eq(wakerGroupMembers.groupId, groupId));
  return rows
    .map((row) => ({
      agentId: row.agentId,
      position: Number(row.position) || 0,
    }))
    .sort(
      (a, b) => a.position - b.position || a.agentId.localeCompare(b.agentId),
    )
    .map((row) => row.agentId);
}

/**
 * What upstream's `create` does after making the channel (`seedOrder`), for an orphan a crash left
 * before it: the chat's Bots in the crew's `position` order. Threads already there are kept, so it
 * changes nothing for a chat that was seeded. In the owner's frame.
 */
async function seedRoster(
  database: Database,
  store: Pick<GroupStore, "seedOrder" | "bots">,
  owner: string,
  groupId: string,
  channelId: string,
) {
  const [roster, bots] = await Promise.all([
    rosterOf(database, groupId),
    store.bots(channelId),
  ]);
  const onChat = new Set(bots);
  await store.seedOrder(
    owner,
    channelId,
    roster.filter((agentId) => onChat.has(agentId)),
  );
}

/**
 * 5.4：未完成的转换占用的频道（台账 `started` 记下的 `channel_id`，或孤儿条件命中的频道）。`claimedBy` 在调用者
 * 帧里读：第二阶段在 `platform` 帧，`for-channel` 在创建者本人帧（台账、群组名单都是他的）。群组已经挂着别的
 * 聊天的转换不占用：那个聊天未删，下次第一阶段会收尾；已删，第一阶段不再续做（同裁定 3a），占用随之放开。`finish` 在调用者帧（所有者本人）补种顺序、`adopt`，台账改
 * `converted` 并写 `channel_id`。
 */
export function createConversionClaims(deps: {
  database: Database;
  link: WakerGroupLink;
  /** The groups service's store (`baseGroupConversations.store`): an orphan's order is seeded. */
  groupStore: Pick<GroupStore, "seedOrder" | "bots">;
}): ConversionClaims {
  const { database, link } = deps;
  return {
    async claimedBy(channelId) {
      const rows = (await database.execute(
        sql`select l.group_id::text as group_id from waker_group_upgrades l
             where l.outcome = 'started'
               and (l.channel_id = ${channelId}
                    or (l.channel_id is null and ${ORPHAN_OF_LEDGER_ROW} = ${channelId}))
               and not exists (select 1 from channels x
                                where x.waker_group_id = l.group_id and x.id <> ${channelId})
             order by l.started_at, l.group_id
             limit 1`,
      )) as unknown as { group_id: string }[];
      return rows[0]?.group_id ?? null;
    },
    async finish(groupId, channelId) {
      const [crew] = (await database.execute(
        sql`select tenant_id from waker_groups where id = ${groupId}::uuid`,
      )) as unknown as { tenant_id: string }[];
      if (!crew) throw new Error(`crew ${groupId} is not the caller's`);
      await seedRoster(
        database,
        deps.groupStore,
        crew.tenant_id,
        groupId,
        channelId,
      );
      await link.adopt(groupId, channelId);
      await database.execute(
        sql`update waker_group_upgrades
               set outcome = 'converted', channel_id = ${channelId}, updated_at = now()
             where group_id = ${groupId}::uuid`,
      );
    },
  };
}

/** A crew as the task enumerates it, with its ledger row when it has one. */
type Crew = {
  id: string;
  tenantId: string;
  /** A WakerFlow's internal crew (rule 1). */
  flow: boolean;
  /** Every chat linked to it, hidden ones too. */
  linked: string[];
  /** The chats linked to it that are not hidden. */
  live: string[];
  /** Whether `users` still has the person its `tenant_id` names. */
  person: boolean;
  /** Whether that person's address is in `revoked_access` (deactivated: counts as having left). */
  deactivated: boolean;
  outcome: string | null;
  channelId: string | null;
  /** The ledger's chat is hidden or no longer there. */
  channelGone: boolean;
};

const logToStderr = (line: Record<string, unknown>) =>
  console.error(JSON.stringify(line));

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function convertGroups(
  deps: GroupUpgradeDeps,
): Promise<PhaseOneCounts> {
  const { database, groups, link } = deps;
  const log = deps.log ?? logToStderr;
  const counts: PhaseOneCounts = {
    converted: 0,
    pending: 0,
    tooMany: 0,
    noOwner: 0,
  };

  /** `canUse` in the owner's frame, asked once per owner and Bot however many crews name it. */
  const asked = new Map<string, Promise<boolean>>();
  const usable = (owner: string, agentId: string) => {
    const key = JSON.stringify([owner, agentId]);
    let answer = asked.get(key);
    if (!answer) {
      answer = runAsTenant(owner, () => deps.canUse(owner, agentId));
      asked.set(key, answer);
    }
    return answer;
  };

  async function crews(): Promise<Crew[]> {
    const rows = (await asPlatform(() =>
      database.execute(
        sql`select g.id::text as id, g.tenant_id,
                   exists (select 1 from waker_flows f where f.group_id = g.id) as flow,
                   array(select c.id from channels c where c.waker_group_id = g.id order by c.id) as linked,
                   array(select c.id from channels c
                          where c.waker_group_id = g.id and c.deleted_at is null order by c.id) as live,
                   exists (select 1 from users u where u.id = g.tenant_id) as person,
                   exists (select 1 from users u join revoked_access r on r.email = lower(u.email)
                            where u.id = g.tenant_id) as deactivated,
                   l.outcome, l.channel_id,
                   l.channel_id is not null
                     and not exists (select 1 from channels c
                                      where c.id = l.channel_id and c.deleted_at is null) as channel_gone
              from waker_groups g
              left join waker_group_upgrades l on l.group_id = g.id
             order by g.created_at, g.id`,
      ),
    )) as unknown as {
      id: string;
      tenant_id: string;
      flow: boolean;
      linked: string[];
      live: string[];
      person: boolean;
      deactivated: boolean;
      outcome: string | null;
      channel_id: string | null;
      channel_gone: boolean;
    }[];
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      flow: row.flow,
      linked: row.linked,
      live: row.live,
      person: row.person,
      deactivated: row.deactivated,
      outcome: row.outcome,
      channelId: row.channel_id,
      channelGone: row.channel_gone,
    }));
  }

  /** Whether the person holds a role, asked once per person in their own frame. */
  const roles = new Map<string, Promise<boolean>>();
  const holdsRole = (owner: string) => {
    let answer = roles.get(owner);
    if (!answer) {
      answer = runAsTenant(owner, () => deps.hasRole(owner));
      roles.set(owner, answer);
    }
    return answer;
  };

  /**
   * Write the crew's ledger row as `outcome`. A first write names `tenant` as both the row's tenant
   * and its `original_owner`; writing over a `started` row (a rebuild) leaves both as they were.
   */
  async function record(
    groupId: string,
    tenant: string,
    outcome: Outcome,
    dropped: string[] = [],
  ) {
    await asPlatform(() =>
      database.execute(
        sql`insert into waker_group_upgrades
              (group_id, tenant_id, original_owner, outcome, dropped_agent_ids)
            values (${groupId}::uuid, ${tenant}, ${tenant}, ${outcome}, ${textArray(dropped)})
            on conflict (group_id) do update
              set outcome = excluded.outcome, dropped_agent_ids = excluded.dropped_agent_ids,
                  channel_id = null, started_at = now(), updated_at = now()`,
      ),
    );
  }

  /** ③: the chat this conversion made, written down before anything links it. */
  async function recordChannel(groupId: string, channelId: string) {
    await asPlatform(() =>
      database.execute(
        sql`update waker_group_upgrades set channel_id = ${channelId}, updated_at = now()
             where group_id = ${groupId}::uuid`,
      ),
    );
  }

  /**
   * ⑤, or a settled race: the crew is converted. `channelId` is the chat this conversion made, null
   * when it made none; never one the person opened themselves (the rollback runbook hides it).
   */
  async function converted(groupId: string, channelId: string | null) {
    await asPlatform(() =>
      database.execute(
        sql`update waker_group_upgrades
               set outcome = 'converted', channel_id = ${channelId}, updated_at = now()
             where group_id = ${groupId}::uuid`,
      ),
    );
  }

  /** A chat not hidden that links the crew, other than `except`; null when there is none. */
  async function liveChannelOf(groupId: string, except: string) {
    const rows = (await asPlatform(() =>
      database.execute(
        sql`select c.id from channels c
             where c.waker_group_id = ${groupId}::uuid and c.deleted_at is null and c.id <> ${except}
             limit 1`,
      ),
    )) as unknown as { id: string }[];
    return rows[0]?.id ?? null;
  }

  /**
   * The person opened the crew's chat themselves while its conversion was under way: theirs is the
   * crew's chat. The one this conversion made (`ours`) is hidden while it is still unlinked and nobody
   * has said anything in it, and said once; with messages it is left as it is, and said once too.
   *
   * Hidden in the owner's frame, as their own delete would be: `ours` is a shared group they started
   * (`groups.create` ran in their frame, and an orphan's `created_by` is them), so row security and
   * 0122's guard (only the creator hides a shared group) both still have their say.
   */
  async function settle(
    owner: string,
    groupId: string,
    ours: string | null,
    theirs: string,
  ) {
    if (ours !== null) {
      const outcome = await runAsTenant(owner, async () => {
        const hidden = (await database.execute(
          sql`update channels set deleted_at = now(), updated_at = now()
               where id = ${ours} and deleted_at is null and waker_group_id is null
                 and not exists (select 1 from group_messages m where m.channel_id = ${ours})
               returning id`,
        )) as unknown[];
        if (hidden.length > 0) return "hidden" as const;
        // Not hidden: already gone or linked elsewhere (nothing to say), or spoken in (kept).
        const [open] = (await database.execute(
          sql`select 1 from channels c
               where c.id = ${ours} and c.deleted_at is null and c.waker_group_id is null`,
        )) as unknown[];
        return open === undefined ? null : ("kept" as const);
      });
      if (outcome)
        log({
          type:
            outcome === "hidden"
              ? "waker-group-upgrade-chat-hidden"
              : "waker-group-upgrade-chat-kept",
          groupId,
          channelId: ours,
          linkedChannelId: theirs,
        });
    }
    // The ledger names the chat this conversion made, not theirs: the runbook may hide what it names.
    await converted(groupId, ours);
  }

  /** ④ and ⑤: link the crew to its chat (the title and the mirror follow), then it is converted. */
  async function finish(owner: string, groupId: string, channelId: string) {
    try {
      await link.adopt(groupId, channelId);
    } catch (error) {
      // 23505 on the one-live-chat-per-crew index: the person linked another chat meanwhile.
      const theirs =
        stateOf(error) === "23505"
          ? await liveChannelOf(groupId, channelId)
          : null;
      if (!theirs) throw error;
      return settle(owner, groupId, channelId, theirs);
    }
    await converted(groupId, channelId);
  }

  /** Upstream's `seedOrder` for a crew's chat, in the owner's frame; harmless on a seeded chat. */
  function seed(owner: string, groupId: string, channelId: string) {
    return runAsTenant(owner, () =>
      seedRoster(database, groups.store, owner, groupId, channelId),
    );
  }

  /** 5.3: the chat a crash left between ② and ③ (`ORPHAN_OF_LEDGER_ROW`). */
  async function orphanOf(groupId: string) {
    const rows = (await asPlatform(() =>
      database.execute(
        sql`select ${ORPHAN_OF_LEDGER_ROW} as id
              from waker_group_upgrades l where l.group_id = ${groupId}::uuid`,
      ),
    )) as unknown as { id: string | null }[];
    return rows[0]?.id ?? null;
  }

  /** Rules 3–6, for a crew with no ledger row or a `started` one with nothing to pick up. */
  async function convert(crew: Crew): Promise<Outcome> {
    const owner = crew.tenantId;
    // An owner with no role at all: `actorFor` would refuse them, and every boot would fail on it.
    // A deactivated owner counts as having left (the 0207 rule): no shared group is made under them.
    if (
      !isPersonTenant(owner) ||
      !crew.person ||
      crew.deactivated ||
      !(await holdsRole(owner))
    ) {
      await record(crew.id, owner, "no_owner");
      return "no_owner";
    }
    const members = await asPlatform(() => rosterOf(database, crew.id));
    const answers = await Promise.all(
      members.map((agentId) => usable(owner, agentId)),
    );
    const kept = members.filter((_, at) => answers[at]);
    const dropped = members.filter((_, at) => !answers[at]);
    // The roster is left as it is either way: who goes is the person's to decide (Q3).
    if (kept.length < MIN_MEMBERS) {
      await record(crew.id, owner, "pending_members");
      return "pending_members";
    }
    if (kept.length > MAX_MEMBERS) {
      await record(crew.id, owner, "too_many");
      return "too_many";
    }
    await record(crew.id, owner, "started", dropped);
    const channel = await runAsTenant(owner, () =>
      groups.create(owner, { agentIds: kept }),
    );
    await recordChannel(crew.id, channel.id);
    await finish(owner, crew.id, channel.id);
    return "converted";
  }

  /** One crew, from wherever its ledger row says it got to; null when there is nothing to do. */
  async function upgrade(crew: Crew): Promise<Outcome | null> {
    if (crew.flow) return null;
    if (crew.outcome && SETTLED.has(crew.outcome)) return null;
    const resuming = crew.outcome === "started";
    // The person opened the crew's chat themselves since the conversion started: theirs wins.
    const theirs = resuming
      ? crew.live.find((channelId) => channelId !== crew.channelId)
      : undefined;
    if (theirs) {
      await settle(
        crew.tenantId,
        crew.id,
        crew.channelId ?? (await orphanOf(crew.id)),
        theirs,
      );
      return "converted";
    }
    // Rule 2: a chat links it already, other than the one its own conversion wrote down. For a
    // `started` row that chat is one the person opened and then deleted: passed over without a word,
    // as when its own chat was deleted (below); `claimedBy` lets go of what it wrote down.
    const own = resuming ? crew.channelId : null;
    if (crew.linked.some((channelId) => channelId !== own)) return null;
    if (resuming && crew.channelId) {
      // Its chat was deleted since: the crew stays, and the chat is not opened again (rule 2).
      if (crew.channelGone) return null;
      // The chat may be an orphan written down before its order was seeded (a crash between the
      // two): seed again. A chat that was seeded keeps its threads, so this changes nothing there.
      await seed(crew.tenantId, crew.id, crew.channelId);
      await finish(crew.tenantId, crew.id, crew.channelId);
      return "converted";
    }
    if (resuming) {
      const orphan = await orphanOf(crew.id);
      if (orphan) {
        await recordChannel(crew.id, orphan);
        await seed(crew.tenantId, crew.id, orphan);
        await finish(crew.tenantId, crew.id, orphan);
        return "converted";
      }
    }
    return convert(crew);
  }

  for (const crew of await crews()) {
    if (deps.stopped?.()) break;
    try {
      const outcome = await upgrade(crew);
      const counted = outcome ? COUNTED[outcome] : undefined;
      if (counted) counts[counted] += 1;
    } catch (error) {
      log({
        type: "waker-group-upgrade-item-failed",
        groupId: crew.id,
        error: messageOf(error),
      });
    }
  }
  return counts;
}

export type BackfillCounts = {
  backfilled: number;
  ownerless: number;
  /** Shared groups whose creator had left, handed to their earliest member first. */
  handedOver: number;
};

export type ReconcileCounts = { reconciled: number; handedOver: number };

/** A chat as phases 2 and 3 enumerate it. */
type Chat = { id: string; tenantId: string; createdBy: string | null };

async function chatsWhere(database: Database, condition: SQL) {
  const rows = (await asPlatform(() =>
    database.execute(
      sql`select c.id, c.tenant_id, c.created_by from channels c
           where c.deleted_at is null and ${condition}
           order by c.created_at, c.id`,
    ),
  )) as unknown as {
    id: string;
    tenant_id: string;
    created_by: string | null;
  }[];
  return rows.map(
    (row): Chat => ({
      id: row.id,
      tenantId: row.tenant_id,
      createdBy: row.created_by,
    }),
  );
}

/**
 * 3.1.1 第 4.4 条：a shared group whose creator left past the service, or was deactivated while a run
 * held the hand-over off, goes to its earliest member now. In `platform`'s frame; anything else
 * comes back as it was. `moved` when the group changed hands.
 */
async function handOverFirst(link: WakerGroupLink, chat: Chat) {
  if (chat.tenantId !== TEAM_TENANT)
    return { owner: channelOwner(chat), deferred: false, moved: false };
  const handed = await asPlatform(() => link.handOver(chat.id));
  return {
    ...handed,
    moved: Boolean(handed.owner) && handed.owner !== chat.createdBy,
  };
}

/**
 * 第二阶段（5.4）：每个未删除、员工至少 2 位、未挂接、不是装包物化的频道补一个群组，台账 `backfilled`。被未完成
 * 的转换占用的跳过；定不出所有者的计数后跳过；共享群先移交。名字按 4.4（撞名加「（2）」），成员与顺序取运行时
 * 顺序，都由 `link.linkChannel` 在所有者帧的一个事务里做。
 */
export async function backfillChannels(
  deps: GroupUpgradeDeps,
): Promise<BackfillCounts> {
  const { database, link } = deps;
  const log = deps.log ?? logToStderr;
  const claims = createConversionClaims({
    database,
    link,
    groupStore: deps.groups.store,
  });
  const counts: BackfillCounts = { backfilled: 0, ownerless: 0, handedOver: 0 };
  const chats = await chatsWhere(
    database,
    sql`c.waker_group_id is null and c.package_id is null
        and (select count(*) from channel_agents a where a.channel_id = c.id) >= 2`,
  );
  for (const chat of chats) {
    if (deps.stopped?.()) break;
    try {
      // Left for phase 1 to finish: a crew of its own here could never be linked to the original.
      if (await asPlatform(() => claims.claimedBy(chat.id))) continue;
      if (!channelOwner(chat)) {
        counts.ownerless += 1;
        continue;
      }
      const handed = await handOverFirst(link, chat);
      if (handed.moved) counts.handedOver += 1;
      // Put off by a running flow (logged by `handOver`), or the last one out: nobody to give it to.
      if (handed.deferred) continue;
      if (!handed.owner) {
        log({ type: "waker-group-upgrade-chat-dropped", channelId: chat.id });
        continue;
      }
      const groupId = await link.linkChannel(chat.id);
      if (!groupId) continue;
      await asPlatform(() =>
        database.execute(
          sql`insert into waker_group_upgrades
                (group_id, tenant_id, original_owner, channel_id, outcome)
              select g.id, g.tenant_id, g.tenant_id, ${chat.id}, 'backfilled'
                from waker_groups g where g.id = ${groupId}::uuid
              on conflict (group_id) do nothing`,
        ),
      );
      counts.backfilled += 1;
    } catch (error) {
      log({
        type: "waker-group-upgrade-item-failed",
        channelId: chat.id,
        error: messageOf(error),
      });
    }
  }
  return counts;
}

/**
 * 第三阶段（4.5）：每个已挂接、未删除的频道自愈一次（`link.reconcile` 改写镜像、跟名字），共享群先移交。
 * `reconciled` 数的是写了镜像的频道。
 */
export async function reconcileLinked(
  deps: GroupUpgradeDeps,
): Promise<ReconcileCounts> {
  const { database, link } = deps;
  const log = deps.log ?? logToStderr;
  const counts: ReconcileCounts = { reconciled: 0, handedOver: 0 };
  for (const chat of await chatsWhere(
    database,
    sql`c.waker_group_id is not null`,
  )) {
    if (deps.stopped?.()) break;
    try {
      const handed = await handOverFirst(link, chat);
      if (handed.moved) counts.handedOver += 1;
      // Put off by a running flow (logged by `handOver`): the mirror waits for the hand-over.
      if (handed.deferred) continue;
      if (await link.reconcile(chat.id)) counts.reconciled += 1;
    } catch (error) {
      log({
        type: "waker-group-upgrade-item-failed",
        channelId: chat.id,
        error: messageOf(error),
      });
    }
  }
  return counts;
}

export type GroupUpgradeSummary = {
  type: "waker-group-upgrade";
  converted: number;
  pending: number;
  tooMany: number;
  noOwner: number;
  backfilled: number;
  reconciled: number;
  /** Chats phase 2 could not find an owner for (expected to be 0). */
  ownerless: number;
  /** Shared groups handed to their earliest member by phases 2 and 3. */
  handedOver: number;
};

/** The advisory lock one replica holds while it upgrades: a fixed number, the spec's date. */
export const GROUP_UPGRADE_LOCK = 20261113;

/**
 * 5.3：开机任务。`XIONGBAO_GROUP_UPGRADE=off` 整个跳过，不连库。否则在一条自己的连接上抢咨询锁（会话级，
 * 不能走连接池，同 audit-retention.ts），抢不到说明别的副本在跑，跳过；抢到就依次跑三个阶段，结束打一行汇总。
 * 停止标记在阶段之间与项之间检查。
 */
export async function runGroupUpgrade(
  deps: GroupUpgradeDeps & { databaseUrl: string },
  env: Record<string, string | undefined> = process.env,
): Promise<GroupUpgradeSummary | { skipped: "off" | "locked" }> {
  if (env.XIONGBAO_GROUP_UPGRADE === "off") return { skipped: "off" };
  // The lock lives as long as this connection, which sits idle while the pool does the work: neither
  // an idle timeout nor postgres.js's default 30–60 minute lifetime may end it mid-run.
  const connection = postgres(deps.databaseUrl, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
  });
  let held = false;
  try {
    const [lock] = await connection`
      select pg_try_advisory_lock(${GROUP_UPGRADE_LOCK}) as held
    `;
    held = Boolean(lock?.held);
    if (!held) return { skipped: "locked" };
    const stopped = () => deps.stopped?.() ?? false;
    const one = await convertGroups(deps);
    const two = stopped()
      ? { backfilled: 0, ownerless: 0, handedOver: 0 }
      : await backfillChannels(deps);
    const three = stopped()
      ? { reconciled: 0, handedOver: 0 }
      : await reconcileLinked(deps);
    const summary: GroupUpgradeSummary = {
      type: "waker-group-upgrade",
      converted: one.converted,
      pending: one.pending,
      tooMany: one.tooMany,
      noOwner: one.noOwner,
      backfilled: two.backfilled,
      reconciled: three.reconciled,
      ownerless: two.ownerless,
      handedOver: two.handedOver + three.handedOver,
    };
    console.error(JSON.stringify(summary));
    return summary;
  } finally {
    if (held)
      await connection`select pg_advisory_unlock(${GROUP_UPGRADE_LOCK})`.catch(
        () => undefined,
      );
    // Ending the connection releases the lock with it, should the unlock above have failed.
    await connection.end({ timeout: 5 }).catch(() => undefined);
  }
}

/**
 * 开机装配（`startup.acquireSync`）：立即返回，升级在后台跑，不挡健康检查。出错记
 * {"type":"waker-group-upgrade-failed","error"}，不抛；跳过记 {"type":"waker-group-upgrade-skipped","reason"}。
 * `stop()` 让它在下一项之前停下，并等它结束。
 */
export function startGroupUpgrade(
  deps: GroupUpgradeDeps & { databaseUrl: string },
): { done: Promise<unknown>; stop(): Promise<void> } {
  let stopping = false;
  const done = runGroupUpgrade({
    ...deps,
    stopped: () => stopping || (deps.stopped?.() ?? false),
  }).then(
    (result) => {
      if ("skipped" in result)
        logToStderr({
          type: "waker-group-upgrade-skipped",
          reason: result.skipped,
        });
      return result;
    },
    (error: unknown) => {
      logToStderr({
        type: "waker-group-upgrade-failed",
        error: messageOf(error),
      });
      return null;
    },
  );
  return {
    done,
    async stop() {
      stopping = true;
      await done;
    },
  };
}
