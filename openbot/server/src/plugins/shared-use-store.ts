import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ownerTenantOfBot } from "../agents/bot-owner";
import type { AuditEventInput, AuditInitiator } from "../audit";
import { type AuditStore, recordAuditEvent } from "../audit";
import { createRoleRepository } from "../auth/guards";
import type { OpenBotRole } from "../auth/roles";
import type { Database } from "../db/client";
import { agents, users } from "../db/schema/core";
import { agentProfiles } from "../db/schema/coworker";
import { mcpServers, pluginGrants } from "../db/schema/plugins";
import {
  responsibilities,
  responsibilityTriggers,
} from "../db/schema/responsibilities";
import {
  sharedUseApprovalMembers,
  sharedUseApprovals,
  sharedUseRequests,
} from "../db/schema/shared-use";
import {
  teamBotAssignments,
  teamBotAudience,
  teamBotPublications,
} from "../db/schema/team-bots";
import { currentTenant, runAsTenant } from "../tenant/context";
import { toolkitOf } from "./composio";
import { ownerStillGives } from "./owner-grants";
import {
  type ActorFacts,
  type ApprovalMember,
  admits,
  type BotFacts,
  covers,
  exposureOf,
  type SharedUseApproval,
} from "./shared-use";

/**
 * 共享使用批准的存储与闸门（上游 `shared-use-store.ts`，按 fork 的租户模型改写）。
 *
 * 帧（与上游最大的不同）。三张表的行都属于员工的主人（迁移 0196）。本模块里存储的每个方法都在调用方给的
 * 帧里读写，调用方负责把它放进主人的帧：
 * - 闸门与 {@link SharedAudience.admitsPerson}：经 `agents/bot-owner.ts` 读出员工的主人（那里只有主人的 id
 *   离开 platform），然后在主人的帧里只读批准与员工的开放范围——和 SEC1 读员工安全底线同一种做法
 *   （`approvals/store.ts` 的 `employee`），不放宽任何策略，不开新门。别人的帧里一个字都不写：只有调用
 *   本身就在主人帧里时（主人自己、主人的例行任务和职责），被拒的调用才顺手建一条申请。
 * - 管理员的批准与驳回：路由经已有的 `asBotOwner`（`adminActAsOwner`）进主人的帧。
 * - 管理员收件箱：路由经插件路由已有的那道 `asAdminPlatform` 列出所有人的申请。
 * 写批准前再确认一次当前帧就是员工的主人（{@link assertOwnerFrame}），写错帧的行不会出现。
 *
 * 没有主人的员工（目录里的公开员工、主人已不在的团队员工）没有可以记批准的租户：闸门直接拒绝，也不建申请。
 */

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class SharedUseRequestDecidedError extends Error {
  constructor() {
    super("这条申请已经处理过了。");
    this.name = "SharedUseRequestDecidedError";
  }
}

/** 批准只能写在员工主人的帧里；别的帧（包括管理员自己的）写不进来。 */
/** 应用此刻不是 Shared：不写批准（切换账号模式之后才落下的批准会在再切回时复活）。 */
export class SharedUseNotSharedError extends Error {
  constructor() {
    super("这个应用现在不是团队账号，不需要也不能批准。");
    this.name = "SharedUseNotSharedError";
  }
}

/**
 * 一个应用的共享使用锁的键：写批准拿共享锁，改「谁可以给员工」、切换账号模式拿排他锁。按 broker 应用的
 * 工具包（同一地址上的每一行是同一个应用），读不出时按行 id。
 */
export function sharedUseAppLockKey(url: string | null, appId: string) {
  return JSON.stringify(["shared-use-app", (url && toolkitOf(url)) || appId]);
}

/** 在指定的人的帧里只读；本来就在那里时不换帧。 */
const inFrame = <T>(tenant: string, read: () => Promise<T>): Promise<T> =>
  tenant === currentTenant() ? read() : runAsTenant(tenant, read);

export class SharedUseFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedUseFrameError";
  }
}

export type SharedUseRequestRow = {
  id: string;
  botId: string;
  botName: string;
  ownerUserId: string | null;
  serverId: string;
  title: string;
  proposed: SharedUseApproval;
  current: SharedUseApproval | null;
  reason: string;
  requestedBy: string;
  status: string;
  createdAt: string;
};

/**
 * 调用时的闸门。store 已经判过 check-in 与 `steeringOf`（拒绝的不会到这里），所以这里只拿到「是不是外部
 * 输入」。`refusal` 是审计行里的拒绝码。
 */
export type SharedUseGate = (input: {
  botId: string;
  serverId: string;
  title: string;
  actorId: string;
  initiator?: AuditInitiator;
  outside: boolean;
}) => Promise<
  | { allowed: true }
  | {
      allowed: false;
      /** 说给提问人的半句（store 拼成「X 用的是一个共享的团队账号，<why>，所以没有调用。」）。 */
      why: string;
      refusal:
        | "shared_account_not_approved"
        | "shared_audience"
        | "shared_no_owner";
    }
>;

const sameApproval = (left: SharedUseApproval, right: SharedUseApproval) =>
  covers(left, right) && covers(right, left);

const canonicalUrlOf = (toolkit: string) => `composio://${toolkit}`;

export function createSharedUseStore(database: Database) {
  const roles = createRoleRepository(database);

  /*
   * 一个应用在它规范地址上的每一行，id 最小的在前——那一行是应答行（与 store 的 `brokeredAppRowsAt` 同一条
   * `order by id`）。批准是关于应用唯一那个团队账号的事实，不是关于授予恰好经过的哪一行，所以每次读写都先
   * 换成应答行的 id。拨的那一行自己的 id 总在 `ids` 里；没有行的 id 答它自己，读作没人持有的应用。
   */
  async function rowsOfApp(
    serverId: string,
    executor: Database | Transaction = database,
  ): Promise<{ appId: string; url: string | null; ids: string[] }> {
    const [row] = await executor
      .select({ url: mcpServers.url })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    const url = row?.url ?? null;
    const toolkit = url ? toolkitOf(url) : null;
    if (!toolkit) return { appId: serverId, url, ids: [serverId] };
    const siblings = await executor
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.url, canonicalUrlOf(toolkit)))
      .orderBy(asc(mcpServers.id));
    const ids = siblings.map((sibling) => sibling.id);
    if (!ids.includes(serverId)) ids.push(serverId);
    return { appId: siblings[0]?.id ?? serverId, url, ids };
  }

  async function appIdOf(
    serverId: string,
    executor: Database | Transaction = database,
  ): Promise<string> {
    return (await rowsOfApp(serverId, executor)).appId;
  }

  /**
   * 当前帧必须是员工的主人。管理员经 `asBotOwner` 进了主人的帧时也成立；管理员在自己帧里给别人的员工写，
   * 或员工没有主人，都拒绝。
   */
  async function assertOwnerFrame(botId: string): Promise<string> {
    const owner = await ownerTenantOfBot(database, botId);
    if (!owner)
      throw new SharedUseFrameError(
        "这位员工没有主人，团队账号只能给有主人的员工用。",
      );
    if (owner !== currentTenant())
      throw new SharedUseFrameError(
        "共享使用批准只能记在员工主人名下，这次请求不在那里。",
      );
    return owner;
  }

  /**
   * 批准行。`tenant` 只在 platform 帧里读时给（收件箱）：那里看得到所有人的行，必须限定在员工主人的
   * 那一行；在人的帧里行安全已经只给本人的行。
   */
  async function storedApproval(
    botId: string,
    serverId: string,
    tenant?: string,
  ) {
    const [row] = await database
      .select({
        audience: sharedUseApprovals.audience,
        outsideInput: sharedUseApprovals.outsideInput,
        approvedAs: sharedUseApprovals.approvedAs,
        tenantId: sharedUseApprovals.tenantId,
      })
      .from(sharedUseApprovals)
      .where(
        and(
          eq(sharedUseApprovals.agentId, botId),
          eq(sharedUseApprovals.serverId, serverId),
          ...(tenant ? [eq(sharedUseApprovals.tenantId, tenant)] : []),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** 谁定的这位员工在这个应用上的受众：`admin`（NULL 也是）、`owner`，没有为 null。 */
  async function approvalSource(
    botId: string,
    anyServerId: string,
  ): Promise<"admin" | "owner" | null> {
    const row = await storedApproval(botId, await appIdOf(anyServerId));
    if (!row) return null;
    return row.approvedAs === "owner" ? "owner" : "admin";
  }

  /**
   * 这位员工在这个应用上的批准，没有为 null。
   *
   * 主人定的受众只在应用规则仍让主人决定时才算（{@link ownersDecide}）：管理员不再让主人决定时它会被
   * 撤回，但一行撤回失败、或别处切了规则没撤回而留下的，不能让团队账号继续开着。
   */
  async function approvalFor(
    botId: string,
    anyServerId: string,
    tenant?: string,
  ): Promise<SharedUseApproval | null> {
    const serverId = await appIdOf(anyServerId);
    const row = await storedApproval(botId, serverId, tenant);
    if (!row) return null;
    /*
     * 主人定的受众还要主人仍能「给」：人还在、`ownerApps` 没被关掉（`ownerStillGives`，调用时判定）。行属于
     * 员工的主人，所以行的租户就是那位主人。
     */
    if (
      row.approvedAs === "owner" &&
      (!(await ownersDecide(serverId)) ||
        !(await ownerStillGives(database, row.tenantId)))
    )
      return null;
    const members = await database
      .select({
        kind: sharedUseApprovalMembers.kind,
        value: sharedUseApprovalMembers.value,
      })
      .from(sharedUseApprovalMembers)
      .where(
        and(
          eq(sharedUseApprovalMembers.agentId, botId),
          eq(sharedUseApprovalMembers.serverId, serverId),
          ...(tenant ? [eq(sharedUseApprovalMembers.tenantId, tenant)] : []),
        ),
      );
    return {
      audience: row.audience,
      outsideInput: row.outsideInput,
      members: members as ApprovalMember[],
    };
  }

  /**
   * 应用的规则是否让员工的主人决定：应答行是 Shared，且管理员明确选了 `any`（Shared 应用的默认值是只有
   * 管理员）。见 {@link approvalFor}。
   */
  async function ownersDecide(
    serverId: string,
    executor: Database | Transaction = database,
  ): Promise<boolean> {
    const [app] = await executor
      .select({
        accountMode: mcpServers.accountMode,
        ownerGrants: mcpServers.ownerGrants,
      })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    return app?.accountMode === "shared" && app.ownerGrants === "any";
  }

  /**
   * 员工的主人把一个应用规则让主人决定的 Shared 应用给了自己的员工：这次授予设下的受众，写下并答回；不设
   * 时为 null（上游 `approveOwnerGrant`）。在员工主人的帧里。
   *
   * 受众正是现在能用这位员工的人：私人员工是主人自己，Team Bot 是它发布给的人；从不包括外部输入——一封
   * 邮件或一个 Webhook 驾驶团队账号不是「能用这位员工的人」，仍要管理员批准。它是快照，和管理员的批准
   * 一样：之后把员工发布得更宽，由闸门拦下并请管理员批准。
   *
   * 从不覆盖已有的批准：管理员的有它的理由，主人自己之前的已经就是这个。只有应答行是 Shared、规则此刻是
   * `any` 时才写，这里重新读，不信调用方。
   */
  async function approveOwnerGrant(input: {
    botId: string;
    serverId: string;
    by: string;
  }): Promise<SharedUseApproval | null> {
    const serverId = await appIdOf(input.serverId);
    if (!(await ownersDecide(serverId))) return null;
    if (await storedApproval(input.botId, serverId)) return null;
    await assertOwnerFrame(input.botId);
    const facts = await botFacts(input.botId);
    // 读不到员工资料（已删除、不在这个帧里）时不设受众：读不到的开放范围不能写成批准。
    if (facts.ownerUserId === null) return null;
    const approval: SharedUseApproval = {
      ...exposureOf(facts),
      outsideInput: false,
    };
    const written = await database.transaction(async (tx) => {
      const appId = await lockApproval(tx, input.botId, serverId);
      // 拿到应用的锁之后再读一次规则：管理员在这之间改了规则，就不写。
      if (!(await ownersDecide(appId, tx))) return false;
      return writeApproval(tx, {
        botId: input.botId,
        serverId: appId,
        approval,
        by: input.by,
        as: "owner",
      });
    });
    return written ? approval : null;
  }

  /**
   * 撤回主人的授予在一个应用上设下的受众（一位员工的），管理员定的一条都不动。在员工主人的帧里，答撤回了
   * 哪些员工，好各写一行轨迹。
   */
  async function withdrawOwnerApprovals(input: {
    serverId: string;
    botId: string;
  }): Promise<string[]> {
    const { ids } = await rowsOfApp(input.serverId);
    const withdrawn = await database
      .delete(sharedUseApprovals)
      .where(
        and(
          inArray(sharedUseApprovals.serverId, ids),
          eq(sharedUseApprovals.approvedAs, "owner"),
          eq(sharedUseApprovals.agentId, input.botId),
        ),
      )
      .returning({ botId: sharedUseApprovals.agentId });
    return [...new Set(withdrawn.map((row) => row.botId))];
  }

  type ApprovalInput = {
    botId: string;
    serverId: string;
    approval: SharedUseApproval;
    by: string;
    /** 谁定的。只有主人自己给应用时是 `owner`。 */
    as?: "admin" | "owner";
  };

  /** 管理员（或在主人帧里的路由）写一条批准，覆盖原来的。在员工主人的帧里。 */
  async function setApproval(input: ApprovalInput) {
    await assertOwnerFrame(input.botId);
    await database.transaction(async (tx) => {
      const serverId = await lockApproval(tx, input.botId, input.serverId);
      await writeApproval(tx, { ...input, serverId });
    });
  }

  /** 写申请或批准之前锁住这位员工与这个应用（应答行）。 */
  async function lockApproval(
    tx: Transaction,
    botId: string,
    serverId: string,
  ) {
    const { appId, url } = await rowsOfApp(serverId, tx);
    /*
     * 先拿应用这一把的共享锁：改规则、切换账号模式拿它的排他锁（`sharedUseAppLockKey`），所以一次写批准
     * 要么整个在它们之前提交、被它们随后删掉，要么在它们之后开始、重读到新的规则与模式。
     */
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtext(${sharedUseAppLockKey(url, appId)}))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${JSON.stringify(["shared-use-approval", botId, appId])}))`,
    );
    return appId;
  }

  /** 在决定所在的事务里写；调用方已经持有锁。应用此刻不是 Shared 时不写。 */
  async function writeApproval(tx: Transaction, input: ApprovalInput) {
    const serverId = input.serverId;
    const [app] = await tx
      .select({ accountMode: mcpServers.accountMode })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    if (app?.accountMode !== "shared") throw new SharedUseNotSharedError();
    const approvedAs = input.as ?? "admin";
    const insertion = tx.insert(sharedUseApprovals).values({
      agentId: input.botId,
      serverId,
      audience: input.approval.audience,
      outsideInput: input.approval.outsideInput,
      approvedBy: input.by,
      approvedAs,
    });
    const target = [
      sharedUseApprovals.tenantId,
      sharedUseApprovals.agentId,
      sharedUseApprovals.serverId,
    ];
    // 主人只能填补空缺，不能替换另一个事务刚刚提交的批准。
    const written =
      approvedAs === "owner"
        ? await insertion
            .onConflictDoNothing({ target })
            .returning({ botId: sharedUseApprovals.agentId })
        : await insertion
            .onConflictDoUpdate({
              target,
              set: {
                audience: input.approval.audience,
                outsideInput: input.approval.outsideInput,
                approvedBy: input.by,
                approvedAs,
                approvedAt: new Date(),
              },
            })
            .returning({ botId: sharedUseApprovals.agentId });
    if (written.length === 0) return false;
    await tx
      .delete(sharedUseApprovalMembers)
      .where(
        and(
          eq(sharedUseApprovalMembers.agentId, input.botId),
          eq(sharedUseApprovalMembers.serverId, serverId),
        ),
      );
    if (
      input.approval.audience === "people" &&
      input.approval.members.length > 0
    ) {
      // 发布与指派可能点名同一个群组。名单是 (kind, value) 的集合；同名的人和群组仍是两个。
      await tx
        .insert(sharedUseApprovalMembers)
        .values(
          input.approval.members.map((member) => ({
            agentId: input.botId,
            serverId,
            ...member,
          })),
        )
        .onConflictDoNothing();
    }
    /* 这次批准已经回答了的待处理申请按批准关单，收件箱不会问两次。 */
    const pending = await tx
      .select()
      .from(sharedUseRequests)
      .where(
        and(
          eq(sharedUseRequests.agentId, input.botId),
          eq(sharedUseRequests.serverId, serverId),
          eq(sharedUseRequests.status, "pending"),
        ),
      );
    for (const request of pending) {
      const proposed = {
        audience: request.proposedAudience,
        outsideInput: request.proposedOutsideInput,
        members: request.proposedMembers,
      };
      if (covers(input.approval, proposed)) {
        await tx
          .update(sharedUseRequests)
          .set({
            status: "approved",
            decidedBy: input.by,
            decidedAt: new Date(),
          })
          .where(eq(sharedUseRequests.id, request.id));
      }
    }
    return true;
  }

  /**
   * 一个职责的来源：触发器的种类与订阅的来源。读不到这个职责（不在这个帧里、已删除）时答 `unknown`，
   * 按外部输入处理——闭合的方向（上游读不到时答空，会读成由人驾驶）。
   */
  async function sourcesOf(responsibilityId: string): Promise<string[]> {
    const [goal] = await database
      .select({ subscriptions: responsibilities.subscriptions })
      .from(responsibilities)
      .where(eq(responsibilities.id, responsibilityId))
      .limit(1);
    if (!goal) return ["unknown"];
    const triggers = await database
      .select({ kind: responsibilityTriggers.kind })
      .from(responsibilityTriggers)
      .where(eq(responsibilityTriggers.responsibilityId, responsibilityId));
    return [
      ...triggers.map((row) => row.kind as string),
      ...(goal.subscriptions ?? []).map((row) => row.source as string),
    ];
  }

  /** 员工现在的开放范围：主人、可见性、发布名单、指派、职责来源。在主人的帧里读。 */
  async function botFacts(botId: string): Promise<BotFacts> {
    const [profile] = await database
      .select({
        ownerUserId: agentProfiles.ownerUserId,
        visibility: agentProfiles.visibility,
      })
      .from(agentProfiles)
      .where(
        and(eq(agentProfiles.agentId, botId), isNull(agentProfiles.deletedAt)),
      )
      .limit(1);
    const [published] = await database
      .select({ audience: teamBotPublications.audience })
      .from(teamBotPublications)
      .where(eq(teamBotPublications.agentId, botId))
      .limit(1);
    const listed =
      published?.audience === "people"
        ? await database
            .select({
              kind: teamBotAudience.kind,
              value: teamBotAudience.value,
            })
            .from(teamBotAudience)
            .where(eq(teamBotAudience.agentId, botId))
        : [];
    const assigned = await database
      .select({ group: teamBotAssignments.groupName })
      .from(teamBotAssignments)
      .where(eq(teamBotAssignments.agentId, botId));
    const goals = await database
      .select({ id: responsibilities.id })
      .from(responsibilities)
      .where(eq(responsibilities.agentId, botId));
    const sources = (
      await Promise.all(goals.map((goal) => sourcesOf(goal.id)))
    ).flat();
    return {
      /* 读不到资料（不在这个帧里、已删除）的员工按没有主人、不公开处理：失败闭合。 */
      ownerUserId: profile?.ownerUserId ?? null,
      visibility: profile?.visibility ?? "private",
      publication: published
        ? {
            audience: published.audience as "team" | "people",
            members: listed as ApprovalMember[],
          }
        : null,
      assignments: assigned.map((row) => row.group),
      sources,
    };
  }

  /** 提问人是谁：管理员角色与所在群组。在提问人自己的帧里读。 */
  async function actorFacts(actorId: string): Promise<ActorFacts> {
    const [row] = await database
      .select({ groups: users.groups })
      .from(users)
      .where(eq(users.id, actorId))
      .limit(1);
    const held = await roles
      .rolesForUser(actorId)
      .catch((): OpenBotRole[] => []);
    return {
      actorId,
      isAdmin: held.includes("admin"),
      groups: row?.groups ?? [],
    };
  }

  /**
   * 员工持有的 Shared 应用，按应用（应答行）而不是按授予经过的行，每个应用一次。在主人的帧里读：
   * 团队员工的授予是 `team` 标记，私人员工的是主人的。
   */
  async function sharedAppsHeldBy(
    botId: string,
  ): Promise<{ serverId: string; title: string }[]> {
    const grants = await database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.kind, "mcp"), eq(pluginGrants.agentId, botId)),
      );
    const serverIds = [
      ...new Set(grants.map((grant) => grant.ref.split("/")[0] ?? "")),
    ].filter(Boolean);
    if (serverIds.length === 0) return [];
    const granted = await database
      .select({ id: mcpServers.id, url: mcpServers.url })
      .from(mcpServers)
      .where(inArray(mcpServers.id, serverIds));
    const toolkitOfRow = (url: string | null) => (url ? toolkitOf(url) : null);
    const canonicalUrls = [
      ...new Set(
        granted
          .map((row) => toolkitOfRow(row.url))
          .filter((toolkit): toolkit is string => !!toolkit)
          .map(canonicalUrlOf),
      ),
    ];
    const atUrls =
      canonicalUrls.length === 0
        ? []
        : await database
            .select({ id: mcpServers.id, url: mcpServers.url })
            .from(mcpServers)
            .where(inArray(mcpServers.url, canonicalUrls))
            .orderBy(asc(mcpServers.id));
    const answeringAt = new Map<string, string>();
    for (const row of atUrls)
      if (row.url && !answeringAt.has(row.url))
        answeringAt.set(row.url, row.id);
    const appIds = [
      ...new Set(
        granted.map((row) => {
          const toolkit = toolkitOfRow(row.url);
          if (!toolkit) return row.id;
          return answeringAt.get(canonicalUrlOf(toolkit)) ?? row.id;
        }),
      ),
    ];
    return database
      .select({ serverId: mcpServers.id, title: mcpServers.title })
      .from(mcpServers)
      .where(
        and(
          inArray(mcpServers.id, appIds),
          eq(mcpServers.accountMode, "shared"),
        ),
      );
  }

  /** 员工持有、但现有批准盖不住它现在开放范围的 Shared 应用。在主人的帧里。 */
  async function shortfall(botId: string) {
    const needed = exposureOf(await botFacts(botId));
    const held = await sharedAppsHeldBy(botId);
    const short: {
      serverId: string;
      title: string;
      needed: SharedUseApproval;
    }[] = [];
    for (const app of held) {
      if (!covers(await approvalFor(botId, app.serverId), needed))
        short.push({ ...app, needed });
    }
    return short;
  }

  /**
   * 建一条申请，或拿到已有那条一样的；提议不一样时旧的那条作废（superseded）。在员工主人的帧里（行属于
   * 主人，见迁移 0196）。
   */
  async function fileRequest(input: {
    botId: string;
    serverId: string;
    reason: "publish" | "trigger" | "grant" | "refused_call";
    requestedBy: string;
    proposed: SharedUseApproval;
  }): Promise<{ id: string; created: boolean }> {
    await assertOwnerFrame(input.botId);
    const serverId = await appIdOf(input.serverId);
    return database.transaction(async (tx) => {
      await lockApproval(tx, input.botId, serverId);
      const [pending] = await tx
        .select()
        .from(sharedUseRequests)
        .where(
          and(
            eq(sharedUseRequests.agentId, input.botId),
            eq(sharedUseRequests.serverId, serverId),
            eq(sharedUseRequests.status, "pending"),
          ),
        )
        .for("update")
        .limit(1);
      if (pending) {
        const proposed = {
          audience: pending.proposedAudience,
          outsideInput: pending.proposedOutsideInput,
          members: pending.proposedMembers,
        };
        if (sameApproval(proposed, input.proposed))
          return { id: pending.id, created: false };
        await tx
          .update(sharedUseRequests)
          .set({ status: "superseded", decidedAt: new Date() })
          .where(eq(sharedUseRequests.id, pending.id));
      }
      const [created] = await tx
        .insert(sharedUseRequests)
        .values({
          agentId: input.botId,
          serverId,
          reason: input.reason,
          requestedBy: input.requestedBy,
          proposedAudience: input.proposed.audience,
          proposedOutsideInput: input.proposed.outsideInput,
          proposedMembers: input.proposed.members,
        })
        .returning({ id: sharedUseRequests.id });
      return { id: created?.id ?? "", created: true };
    });
  }

  async function rows(
    where: ReturnType<typeof and> | ReturnType<typeof eq>,
  ): Promise<SharedUseRequestRow[]> {
    const found = await database
      .select({
        request: sharedUseRequests,
        botName: agents.name,
        ownerUserId: agentProfiles.ownerUserId,
        title: mcpServers.title,
      })
      .from(sharedUseRequests)
      .innerJoin(agents, eq(agents.id, sharedUseRequests.agentId))
      .leftJoin(
        agentProfiles,
        eq(agentProfiles.agentId, sharedUseRequests.agentId),
      )
      .innerJoin(mcpServers, eq(mcpServers.id, sharedUseRequests.serverId))
      .where(where)
      .orderBy(sql`${sharedUseRequests.createdAt} desc`);
    return Promise.all(
      found.map(async ({ request, botName, ownerUserId, title }) => ({
        id: request.id,
        botId: request.agentId,
        botName,
        ownerUserId: ownerUserId ?? null,
        serverId: request.serverId,
        title,
        proposed: {
          audience: request.proposedAudience,
          outsideInput: request.proposedOutsideInput,
          members: request.proposedMembers,
        },
        // 在申请所在的（员工主人的）帧里只读：platform 帧看得到别人同地址的私有行，会选错应答行。
        current: await inFrame(request.tenantId, () =>
          approvalFor(request.agentId, request.serverId),
        ),
        reason: request.reason,
        requestedBy: request.requestedBy,
        status: request.status,
        createdAt: request.createdAt.toISOString(),
      })),
    );
  }

  /** 待处理的申请（收件箱）。管理员经插件路由已有的 platform 门读；在人的帧里只有本人名下的。 */
  const listRequests = () => rows(eq(sharedUseRequests.status, "pending"));
  const pendingFor = (botId: string) =>
    rows(
      and(
        eq(sharedUseRequests.agentId, botId),
        eq(sharedUseRequests.status, "pending"),
      ),
    );

  /**
   * 撤销一位员工在一个应用上的批准（管理员的入口，路由经 `asBotOwner` 进主人的帧）。答撤销了没有。
   */
  async function revokeApproval(input: {
    botId: string;
    serverId: string;
  }): Promise<boolean> {
    await assertOwnerFrame(input.botId);
    const { ids } = await rowsOfApp(input.serverId);
    const removed = await database
      .delete(sharedUseApprovals)
      .where(
        and(
          eq(sharedUseApprovals.agentId, input.botId),
          inArray(sharedUseApprovals.serverId, ids),
        ),
      )
      .returning({ botId: sharedUseApprovals.agentId });
    return removed.length > 0;
  }

  /** 管理员批准或驳回一条申请。在员工主人的帧里（路由经 `asBotOwner` 进来）。 */
  async function decide(input: {
    id: string;
    by: string;
    decision: "approve" | "decline";
  }) {
    await database.transaction(async (tx) => {
      const [request] = await tx
        .select({
          botId: sharedUseRequests.agentId,
          serverId: sharedUseRequests.serverId,
        })
        .from(sharedUseRequests)
        .where(
          and(
            eq(sharedUseRequests.id, input.id),
            eq(sharedUseRequests.status, "pending"),
          ),
        )
        .limit(1);
      if (!request) throw new SharedUseRequestDecidedError();
      await assertOwnerFrame(request.botId);
      const serverId = await lockApproval(tx, request.botId, request.serverId);
      const [claimed] = await tx
        .update(sharedUseRequests)
        .set({
          status: input.decision === "approve" ? "approved" : "declined",
          decidedBy: input.by,
          decidedAt: new Date(),
        })
        .where(
          and(
            eq(sharedUseRequests.id, input.id),
            eq(sharedUseRequests.status, "pending"),
          ),
        )
        .returning();
      if (!claimed) throw new SharedUseRequestDecidedError();
      if (input.decision === "approve") {
        await writeApproval(tx, {
          botId: claimed.agentId,
          serverId,
          by: input.by,
          approval: {
            audience: claimed.proposedAudience,
            outsideInput: claimed.proposedOutsideInput,
            members: claimed.proposedMembers,
          },
        });
      }
    });
    const [row] = await rows(eq(sharedUseRequests.id, input.id));
    if (!row) {
      throw new Error(
        `共享账号申请 ${input.id} 已${input.decision === "approve" ? "批准" : "驳回"}，但它的员工或应用已经不在了，读不回来。`,
      );
    }
    return row;
  }

  return {
    appIdOf,
    rowsOfApp,
    approvalFor,
    approvalSource,
    setApproval,
    approveOwnerGrant,
    withdrawOwnerApprovals,
    botFacts,
    actorFacts,
    sourcesOf,
    sharedAppsHeldBy,
    shortfall,
    fileRequest,
    listRequests,
    pendingFor,
    decide,
    revokeApproval,
  };
}

export type SharedUseStore = ReturnType<typeof createSharedUseStore>;

/**
 * 闸门与「会不会放这个人进团队账号」的只读问法，都在员工主人的帧里读批准（见文件头）。
 */
export function createSharedAudience(
  database: Database,
  store: SharedUseStore,
  audit: AuditStore,
) {
  /** 在员工主人的帧里只读；本来就在那里时不换帧。 */
  const asOwner = <T>(owner: string, read: () => Promise<T>): Promise<T> =>
    owner === currentTenant() ? read() : runAsTenant(owner, read);

  const gate: SharedUseGate = async ({
    botId,
    serverId,
    actorId,
    initiator,
    outside,
  }) => {
    // 说不出是谁在问的调用：团队账号不猜（`identifyActor` 认不出人时答空串）。
    if (!actorId)
      return {
        allowed: false,
        refusal: "shared_account_not_approved",
        why: "这次调用说不出是谁在问",
      };
    const owner = await ownerTenantOfBot(database, botId);
    if (!owner)
      return {
        allowed: false,
        refusal: "shared_no_owner",
        why: "这位员工没有主人，团队账号只给有主人的员工用",
      };
    const actor = await store.actorFacts(actorId);
    const { approval, facts } = await asOwner(owner, async () => ({
      approval: await store.approvalFor(botId, serverId),
      facts: await store.botFacts(botId),
    }));
    if (approval && admits(approval, owner, actor, { outside }))
      return { allowed: true };
    /*
     * 被拒，同时替主人申请——只在这次调用本来就在主人帧里时（主人自己、主人的例行任务与职责）。提议是员工
     * 现在的开放范围：管理员批准了它，这一次以及以后同样的调用才会通过。队友的调用不往主人名下写东西，
     * 告诉他请员工的主人申请。
     */
    const inOwnersFrame = owner === currentTenant();
    let filed = false;
    if (inOwnersFrame) {
      const request = await store.fileRequest({
        botId,
        serverId,
        reason: "refused_call",
        requestedBy: actorId,
        proposed: exposureOf(facts),
      });
      filed = true;
      if (request.created)
        await recordAuditEvent(audit, {
          eventType: "shared_use.requested",
          targetType: "mcp_server",
          targetId: serverId,
          actorUserId: actorId,
          ...(initiator ? { initiator } : {}),
          payload: {
            bot: botId,
            server: serverId,
            reason: "refused_call",
            request: request.id,
          },
        });
    }
    const next = filed ? "已经请管理员批准" : "请员工的主人向管理员申请";
    if (!approval)
      return {
        allowed: false,
        refusal: "shared_account_not_approved",
        why: `管理员还没有批准这位员工使用它，${next}`,
      };
    return {
      allowed: false,
      refusal: "shared_audience",
      why:
        outside && !approval.outsideInput
          ? `管理员没有批准外部输入驱动这位员工使用它，${next}`
          : `管理员批准的使用范围不包括这次运行，${next}`,
    };
  };

  /**
   * 闸门会不会让这个人自己和这位员工的对话进团队账号——同一个批准、主人与受众判断，不做闸门拒绝之后的
   * 事。给页面说一次调用会遇到什么；每一次调用仍由闸门决定。
   */
  async function admitsPerson(input: {
    botId: string;
    serverId: string;
    actorId: string;
  }): Promise<boolean> {
    const owner = await ownerTenantOfBot(database, input.botId);
    if (!owner) return false;
    const approval = await asOwner(owner, () =>
      store.approvalFor(input.botId, input.serverId),
    );
    if (!approval) return false;
    return admits(approval, owner, await store.actorFacts(input.actorId), {
      outside: false,
    });
  }

  /** 共享使用的一行轨迹，目标是应用。在当前帧里写：管理员的决定经 `asBotOwner` 落在员工主人名下。 */
  const record = (
    event: Omit<AuditEventInput, "targetType"> & {
      eventType:
        | "shared_use.requested"
        | "shared_use.approved"
        | "shared_use.declined"
        | "shared_use.owner_approved"
        | "shared_use.owner_withdrawn"
        | "shared_use.revoked";
    },
  ) => recordAuditEvent(audit, { ...event, targetType: "mcp_server" });

  /** 员工的主人（只有主人的 id 离开 `agents/bot-owner.ts` 的 platform 读）；没有主人为 null。 */
  const ownerOf = (botId: string) => ownerTenantOfBot(database, botId);

  return { gate, admitsPerson, record, ownerOf };
}

export type SharedAudience = ReturnType<typeof createSharedAudience>;
