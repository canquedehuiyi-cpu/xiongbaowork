import { eq, type SQL, sql } from "drizzle-orm";
import type { GroupConversations } from "../channels/group";
import type { Database } from "../db/client";
import { wakerGroupMembers } from "../db/schema";
import { asPlatform, isPersonTenant, runAsTenant } from "../tenant/context";
import type { WakerGroupLink } from "./channel-link";
import { MAX_MEMBERS, MIN_MEMBERS } from "./linked-actions";

/*
 * 开机升级任务（设计稿 docs/specs/2026-11-13-group-unify.md 第 5 节）。第一阶段：已有群组转成可以聊天的群组。
 *
 * 在 `platform` 帧枚举 `waker_groups`，逐项按 5.1 的表格处理，台账 `waker_group_upgrades`（0210）记下每一项的
 * 结果。聊天沿用上游的建群路径，在所有者帧（`runAsTenant(owner)`）里建，权限检查、`team` 戳、成员行和线程行
 * 都与平时建群一样；挂接、改名、写镜像交给 `link.adopt`。台账一律在 `platform` 帧写，`tenant_id` 与
 * `original_owner` 都是群组当时的所有者；`original_owner` 之后不改（0211 收回了这一列的 UPDATE 权限）。
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
 * 单项失败记 {"type":"waker-group-upgrade-item-failed","groupId","error"}，继续下一项。
 */

export type GroupUpgradeDeps = {
  database: Database;
  /** The undecorated `baseGroupConversations`: the crew already exists, `adopt` links it. */
  groups: Pick<GroupConversations, "create">;
  link: WakerGroupLink;
  /** The groups service's own `canUseBot` (S/index.ts): the owner can read the Bot's profile. */
  canUse(ownerUserId: string, agentId: string): Promise<boolean>;
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

/** A crew as the task enumerates it, with its ledger row when it has one. */
type Crew = {
  id: string;
  tenantId: string;
  /** A WakerFlow's internal crew (rule 1). */
  flow: boolean;
  /** Every chat linked to it, hidden ones too. */
  linked: string[];
  /** Whether `users` still has the person its `tenant_id` names. */
  person: boolean;
  outcome: string | null;
  channelId: string | null;
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
                   exists (select 1 from users u where u.id = g.tenant_id) as person,
                   l.outcome, l.channel_id
              from waker_groups g
              left join waker_group_upgrades l on l.group_id = g.id
             order by g.created_at, g.id`,
      ),
    )) as unknown as {
      id: string;
      tenant_id: string;
      flow: boolean;
      linked: string[];
      person: boolean;
      outcome: string | null;
      channel_id: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      flow: row.flow,
      linked: row.linked,
      person: row.person,
      outcome: row.outcome,
      channelId: row.channel_id,
    }));
  }

  /** The crew's roster in `position` order, the order the crew pages show it in (store.ts `shape`). */
  async function roster(groupId: string) {
    const rows = await asPlatform(() =>
      database
        .select({
          agentId: wakerGroupMembers.agentId,
          position: wakerGroupMembers.position,
        })
        .from(wakerGroupMembers)
        .where(eq(wakerGroupMembers.groupId, groupId)),
    );
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

  /** ④ and ⑤: link the crew to its chat (the title and the mirror follow), then it is converted. */
  async function finish(groupId: string, channelId: string) {
    await link.adopt(groupId, channelId);
    await asPlatform(() =>
      database.execute(
        sql`update waker_group_upgrades set outcome = 'converted', updated_at = now()
             where group_id = ${groupId}::uuid`,
      ),
    );
  }

  /**
   * 5.3: the chat a crash left between ② and ③. A shared group the owner started since the conversion
   * started, still unlinked and not hidden, whose Bots are exactly the crew's roster less the ones the
   * conversion left out. The oldest, when there is more than one.
   */
  async function orphanOf(groupId: string) {
    const rows = (await asPlatform(() =>
      database.execute(
        sql`select c.id from channels c
              join waker_group_upgrades l on l.group_id = ${groupId}::uuid
             where c.tenant_id = 'team' and c.created_by = l.tenant_id
               and c.waker_group_id is null and c.deleted_at is null
               and c.created_at >= l.started_at
               and array(select a.agent_id from channel_agents a
                          where a.channel_id = c.id order by a.agent_id)
                 = array(select m.agent_id from waker_group_members m
                          where m.group_id = l.group_id
                            and m.agent_id <> all (l.dropped_agent_ids)
                          order by m.agent_id)
             order by c.created_at, c.id
             limit 1`,
      ),
    )) as unknown as { id: string }[];
    return rows[0]?.id ?? null;
  }

  /** Rules 3–6, for a crew with no ledger row or a `started` one with nothing to pick up. */
  async function convert(crew: Crew): Promise<Outcome> {
    const owner = crew.tenantId;
    if (!isPersonTenant(owner) || !crew.person) {
      await record(crew.id, owner, "no_owner");
      return "no_owner";
    }
    const members = await roster(crew.id);
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
    await finish(crew.id, channel.id);
    return "converted";
  }

  /** One crew, from wherever its ledger row says it got to; null when there is nothing to do. */
  async function upgrade(crew: Crew): Promise<Outcome | null> {
    if (crew.flow) return null;
    if (crew.outcome && SETTLED.has(crew.outcome)) return null;
    const resuming = crew.outcome === "started";
    // Rule 2: a chat links it already, other than the one its own conversion wrote down.
    const own = resuming ? crew.channelId : null;
    if (crew.linked.some((channelId) => channelId !== own)) return null;
    if (resuming && crew.channelId) {
      await finish(crew.id, crew.channelId);
      return "converted";
    }
    if (resuming) {
      const orphan = await orphanOf(crew.id);
      if (orphan) {
        await recordChannel(crew.id, orphan);
        await finish(crew.id, orphan);
        return "converted";
      }
    }
    return convert(crew);
  }

  for (const crew of await crews()) {
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
