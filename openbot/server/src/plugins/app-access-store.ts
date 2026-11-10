import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type AuditEventInput,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import type { Database } from "../db/client";
import {
  agentProfiles,
  appAccessRequests,
  composioConnections,
  credentials as credentialRows,
  mcpServers,
  mcpUserCredentials,
  teamBotConsentDefaults,
  teamBotConsents,
  teamBotPublications,
  userRoles,
} from "../db/schema";
import { TEAM_TENANT } from "../db/schema/tenant";
import { currentTenant } from "../tenant/context";
import {
  type AppAccess,
  type AppAccessFacts,
  type AppAccessRequestKind,
  type AppConnect,
  type AppProvider,
  accountOf,
  appAccessState,
  connectOf,
  ownerGrantsOf,
  REQUEST_KIND_FOR,
  type Unavailable,
  unavailableReason,
} from "./app-access";
import type { BrokerApp, BrokerConnection } from "./broker";
import { CATALOGUE, type CatalogueEntry, catalogueEntry } from "./catalogue";
import { toolkitOf } from "./composio";
import { asAccountMode, brokeredProvenance } from "./shared-accounts";
import { admits, STRICTEST_APPROVAL } from "./shared-use";

/**
 * 一位员工持有的每个应用、或按名字问的一个应用，对一个人是什么状态（上游 `plugin-store/app-access.ts`，
 * 按 fork 改写）。规则本身在 `./app-access.ts`；这里只把事实从表里读出来。
 *
 * 在调用者的帧里读：应用行是 `team` 的和调用者自己的（行安全），连接是调用者自己的。员工持有什么用
 * store 的 `listForAgent` 回答——运行时给模型的就是它，所以「已授予」和员工真正拿到的不会是两个答案。
 *
 * 与上游的差异：
 * - 应用的键是 `coalesce(catalogue_key, id)`（fork 的授予 ref 前缀），不是行 id。
 * - Shared 应用的团队账号读应用行的 `shared_*` 列（X1），不是 `brokered_connections` 的 deployment 行。
 * - 共享闸门的受众固定为 X1 的 {@link STRICTEST_APPROVAL}（员工主人与管理员），与调用时的闸门同一个函数。
 * - Team Bot 上谁的账号：与 `teamBots.credentialActorFor` 同一规则的只读版本（主人连了就是主人的；否则是
 *   自己的，没有同意时第一次会先问），不花一次性同意。
 * - 主人自己给员工应用（X3）不在这里：`mayGiveOwn` 恒为 false，`ownerGrants` 只有按账号的默认值。
 */

/** 只问没有行的应用时才问目录。 */
export type AppDirectory = () => Promise<BrokerApp[]>;

/** 员工主人帧里的授予（路由经 `asBotOwner` 读）；见 `heldKeys`。 */
export type OwnersHeld = () => Promise<{ tools: { ref: string }[] }>;

type ServerRow = {
  id: string;
  tenantId: string;
  catalogueKey: string | null;
  title: string;
  logo: string | null;
  url: string;
  provenance: string;
  authScheme: string | null;
  accountMode: string | null;
  credentialId: string | null;
  sharedConnectedAt: Date | null;
  sharedVerified: boolean;
  sharedProbeAction: string | null;
};

type AppCandidate = {
  key: string;
  title: string;
  logo: string | null;
  provider: AppProvider;
  present: boolean;
  /** 授予与申请记在哪一行；没有行时为 null。 */
  answeringId: string | null;
  rowIds: string[];
  toolkit: string | null;
  entry: CatalogueEntry | null;
  authScheme: string | null;
  listedConnect: AppConnect;
  accountMode: "personal" | "shared" | null;
  hasCredential: boolean;
  /** 这个应用只有调用者自己添加的行：是他自己的，不归管理员管。 */
  own: boolean;
  /** 团队账号的连接状态（Shared 应用）。 */
  team: { connectedAt: Date | null; usable: boolean } | null;
  /** 除了调用者的话，还有什么说明这个应用存在：一行、一个目录条目，或 broker 的目录。 */
  vouched: boolean;
};

/** 一个应用对部署、以及（问到人时）对这个人是什么。 */
export type AppInspection = {
  access: AppAccess;
  unavailable: Unavailable | null;
  answeringId: string | null;
  rowIds: string[];
  toolkit: string | null;
  entry: CatalogueEntry | null;
  sharedUsable: boolean;
  vouched: boolean;
  own: boolean;
};

/** 读这些事实时要用到的 store 方法（`this`），由 store 把本模块的方法并进自己时提供。 */
type Host = {
  listForAgent(agentId: string): Promise<{ tools: { ref: string }[] }>;
};

const COMPOSIO_ID_PREFIX = "composio-";
const iso = (value: Date | null | undefined) =>
  value ? value.toISOString() : null;

/** 目录说一个应用怎么连接，用卡片的词：同意页类的是 consent，其余在打开之前不知道。 */
function connectOfListing(connection: BrokerConnection): AppConnect {
  switch (connection.kind) {
    case "consent":
    case "self-registering":
      return "consent";
    case "fields":
    case "no-auth":
    case "unsupported":
      return null;
  }
}

export function appAccessMethods(context: {
  database: Database;
  auditStore: AuditStore;
}) {
  const { database, auditStore } = context;

  /** 调用者帧里看得见的所有应用行：team 的在前，自己的其次，同一顺序下按 id。 */
  async function allRows(): Promise<ServerRow[]> {
    return database
      .select({
        id: mcpServers.id,
        tenantId: mcpServers.tenantId,
        catalogueKey: mcpServers.catalogueKey,
        title: mcpServers.title,
        logo: mcpServers.logo,
        url: mcpServers.url,
        provenance: mcpServers.provenance,
        authScheme: mcpServers.authScheme,
        accountMode: mcpServers.accountMode,
        credentialId: mcpServers.credentialId,
        sharedConnectedAt: mcpServers.sharedConnectedAt,
        sharedVerified: mcpServers.sharedVerified,
        sharedProbeAction: mcpServers.sharedProbeAction,
      })
      .from(mcpServers)
      .orderBy(
        sql`case when ${mcpServers.tenantId} = ${TEAM_TENANT} then 0 when ${mcpServers.tenantId} = ${currentTenant()} then 1 else 2 end`,
        asc(mcpServers.id),
      );
  }

  /**
   * 行归成应用，按应用的键和每一个行 id 都能找到。broker 应用按 url 归一（同一个 url 的几行是一个应用，
   * 最小的 id 回答，与 store 的 `brokeredAppRowsAt` 同一规则）；目录应用按目录键归一，team 的行回答。
   */
  function group(rows: ServerRow[]) {
    const byKey = new Map<string, AppCandidate>();
    const byName = new Map<string, AppCandidate>();
    const brokeredHead = new Map<string, ServerRow>();
    for (const row of [...rows].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      const toolkit = brokeredProvenance(row.provenance)
        ? toolkitOf(row.url)
        : null;
      if (toolkit && !brokeredHead.has(row.url)) brokeredHead.set(row.url, row);
    }
    for (const row of rows) {
      const toolkit = brokeredProvenance(row.provenance)
        ? toolkitOf(row.url)
        : null;
      const head = toolkit ? (brokeredHead.get(row.url) ?? row) : row;
      const key = toolkit ? head.id : (row.catalogueKey ?? row.id);
      let app = byKey.get(key);
      if (!app) {
        const entry = toolkit ? null : catalogueEntry(row.catalogueKey ?? "");
        const mode = asAccountMode(head.accountMode);
        app = {
          key,
          title: entry?.title ?? head.title,
          logo: head.logo,
          provider: toolkit ? "composio" : entry ? "catalogue" : "custom",
          present: true,
          answeringId: head.id,
          rowIds: [],
          toolkit,
          entry,
          authScheme: head.authScheme,
          listedConnect: null,
          accountMode: mode,
          hasCredential: head.credentialId !== null,
          own:
            head.tenantId === currentTenant() && head.tenantId !== TEAM_TENANT,
          team:
            toolkit && mode === "shared"
              ? {
                  connectedAt: head.sharedConnectedAt,
                  usable:
                    head.sharedConnectedAt !== null &&
                    !(head.sharedProbeAction !== null && !head.sharedVerified),
                }
              : null,
          vouched: true,
        };
        byKey.set(key, app);
      }
      app.rowIds.push(row.id);
      byName.set(row.id, app);
    }
    for (const app of byKey.values()) byName.set(app.key, app);
    return { byKey, byName };
  }

  function absent(input: {
    key: string;
    title: string;
    logo?: string | null;
    provider: AppProvider;
    toolkit?: string | null;
    entry?: CatalogueEntry | null;
    vouched?: boolean;
    listedConnect?: AppConnect;
  }): AppCandidate {
    return {
      key: input.key,
      title: input.title,
      logo: input.logo ?? null,
      provider: input.provider,
      present: false,
      answeringId: null,
      rowIds: [],
      toolkit: input.toolkit ?? null,
      entry: input.entry ?? null,
      authScheme: null,
      listedConnect: input.listedConnect ?? null,
      accountMode: null,
      hasCredential: false,
      own: false,
      team: null,
      vouched: input.vouched ?? true,
    };
  }

  /** 目录读不到是「没有」，不是错误：它是这里唯一出本进程的读。 */
  async function readDirectory(directory: AppDirectory | undefined) {
    if (!directory) return null;
    try {
      return await directory();
    } catch {
      return null;
    }
  }

  /** 一个没有行的键，尽量叫出它的名字：目录条目，或 broker 目录里的应用。 */
  async function absentFor(
    key: string,
    directory: AppDirectory | undefined,
    listed: BrokerApp[] | null | undefined,
  ): Promise<AppCandidate | null> {
    const entry = catalogueEntry(key);
    if (entry)
      return absent({
        key: entry.key,
        title: entry.title,
        provider: "catalogue",
        entry,
      });
    const slug = key.startsWith(COMPOSIO_ID_PREFIX)
      ? key.slice(COMPOSIO_ID_PREFIX.length)
      : key;
    if (toolkitOf(`composio://${slug}`) !== slug) return null;
    const apps = listed === undefined ? await readDirectory(directory) : listed;
    const app = apps?.find((candidate) => candidate.slug === slug);
    if (app)
      return absent({
        key: `${COMPOSIO_ID_PREFIX}${app.slug}`,
        title: app.name,
        logo: app.logo,
        provider: "composio",
        toolkit: app.slug,
        listedConnect: connectOfListing(app.connection),
      });
    // 一个 composio- 键目录不认识：可能是授予比行活得久，照键叫它，但不能拿来申请打开。
    if (key.startsWith(COMPOSIO_ID_PREFIX))
      return absent({
        key,
        title: slug,
        provider: "composio",
        toolkit: slug,
        vouched: false,
      });
    return null;
  }

  /**
   * 按调用者给的任何叫法找一个应用：键、行 id、broker 的 slug（带不带 `composio-`）、应用名。名字先找已
   * 打开的应用（同名时先找这位员工持有的），再找目录条目，最后问 broker 的目录。
   */
  async function candidateFor(
    app: string,
    directory: AppDirectory | undefined,
    held: Set<string>,
  ): Promise<AppCandidate | null> {
    const asked = app.trim();
    if (!asked) return null;
    const lower = asked.toLowerCase();
    const { byKey, byName } = group(await allRows());
    const enabled = [...byKey.values()];

    const exact = byName.get(asked);
    if (exact) return exact;

    const slug = lower.startsWith(COMPOSIO_ID_PREFIX)
      ? lower.slice(COMPOSIO_ID_PREFIX.length)
      : lower;
    const bySlug = enabled.find((candidate) => candidate.toolkit === slug);
    if (bySlug) return bySlug;

    const keyed = catalogueEntry(lower);
    if (keyed)
      return byKey.get(keyed.key) ?? absentFor(keyed.key, undefined, null);

    const titled = enabled.filter(
      (candidate) => candidate.title.toLowerCase() === lower,
    );
    const heldOne = titled.find((candidate) => held.has(candidate.key));
    if (heldOne ?? titled[0]) return heldOne ?? titled[0] ?? null;

    const entry = CATALOGUE.find((item) => item.title.toLowerCase() === lower);
    if (entry) return absentFor(entry.key, undefined, null);

    const listed = await readDirectory(directory);
    const named = listed?.find(
      (candidate) =>
        candidate.slug === slug || candidate.name.toLowerCase() === lower,
    );
    if (named)
      return absentFor(`${COMPOSIO_ID_PREFIX}${named.slug}`, undefined, listed);
    return absentFor(
      lower.startsWith(COMPOSIO_ID_PREFIX) ? lower : asked,
      undefined,
      listed,
    );
  }

  /**
   * 员工持有的应用键：`listForAgent` 给出的每个工具 ref 的前缀，在调用者的帧里读。
   *
   * `ownersHeld` 是路由给的第二次读：管理员看别人的私有员工时，授予盖的是员工主人的章，管理员自己的帧里
   * 看不见；路由经 `asBotOwner`（已有的那道门，带能力的管理员才会进主人的帧）再读一次，取并集。本模块不
   * 自己开 platform 帧。
   */
  async function heldKeys(
    host: Host,
    agentId: string,
    ownersHeld?: () => Promise<{ tools: { ref: string }[] }>,
  ): Promise<Set<string>> {
    const [mine, owners] = await Promise.all([
      host.listForAgent(agentId),
      ownersHeld ? ownersHeld() : { tools: [] },
    ]);
    return new Set(
      [...mine.tools, ...owners.tools]
        .map((tool) => tool.ref.split("/")[0] ?? "")
        .filter(Boolean),
    );
  }

  /**
   * 一个人的个人连接：broker 应用读 `composio_connections`（X1 的个人账号行），目录应用读
   * `mcp_user_credentials` 与它指向的凭据是否撤回。与 `GET /connections` 读同一组列，不问 vendor。
   */
  async function connectionFacts(apps: AppCandidate[], userId: string) {
    const toolkits = [
      ...new Set(apps.flatMap((app) => (app.toolkit ? [app.toolkit] : []))),
    ];
    const heldIds = apps
      .filter((app) => app.provider === "catalogue" && app.present)
      .flatMap((app) => app.rowIds);
    const [brokered, held] = await Promise.all([
      toolkits.length > 0
        ? database
            .select({
              toolkit: composioConnections.toolkit,
              verified: composioConnections.verified,
              probeAction: composioConnections.probeAction,
              connectedAt: composioConnections.connectedAt,
            })
            .from(composioConnections)
            .where(
              and(
                eq(composioConnections.userId, userId),
                inArray(composioConnections.toolkit, toolkits),
              ),
            )
        : [],
      heldIds.length > 0
        ? database
            .select({
              serverId: mcpUserCredentials.serverId,
              revokedAt: credentialRows.revokedAt,
              connectedAt: mcpUserCredentials.connectedAt,
            })
            .from(mcpUserCredentials)
            .innerJoin(
              credentialRows,
              eq(credentialRows.id, mcpUserCredentials.credentialId),
            )
            .where(
              and(
                eq(mcpUserCredentials.userId, userId),
                inArray(mcpUserCredentials.serverId, heldIds),
              ),
            )
        : [],
    ]);
    const brokeredBy = new Map(
      brokered.map((row) => [
        row.toolkit,
        {
          usable: !(row.probeAction !== null && !row.verified),
          connectedAt: iso(row.connectedAt),
        },
      ]),
    );
    const heldBy = new Map(
      held.map((row) => [
        row.serverId,
        { usable: row.revokedAt === null, connectedAt: iso(row.connectedAt) },
      ]),
    );
    return (app: AppCandidate) =>
      app.toolkit
        ? brokeredBy.get(app.toolkit)
        : app.provider === "catalogue"
          ? app.rowIds
              .map((id) => heldBy.get(id))
              .find((value) => value !== undefined)
          : undefined;
  }

  /** 已发布的 Team Bot 的主人，看的人不是主人时；其余为 null。与 `teamBots.credentialActorFor` 读同一张表。 */
  async function teamBotOwnerFor(agentId: string, userId: string) {
    const [row] = await database
      .select({ ownerUserId: agentProfiles.ownerUserId })
      .from(teamBotPublications)
      .innerJoin(
        agentProfiles,
        eq(agentProfiles.agentId, teamBotPublications.agentId),
      )
      .where(
        and(
          eq(teamBotPublications.agentId, agentId),
          eq(teamBotPublications.tenantId, TEAM_TENANT),
          isNull(agentProfiles.deletedAt),
        ),
      )
      .limit(1);
    const owner = row?.ownerUserId ?? null;
    return owner && owner !== userId ? owner : null;
  }

  /** 这个人允许这位 Team Bot 不问就用自己账号的应用键：对这位员工的同意，或对所有员工的默认。 */
  async function standingConsents(userId: string, agentId: string) {
    const [forBot, forEvery] = await Promise.all([
      database
        .select({ serverId: teamBotConsents.serverId })
        .from(teamBotConsents)
        .where(
          and(
            eq(teamBotConsents.userId, userId),
            eq(teamBotConsents.agentId, agentId),
          ),
        ),
      database
        .select({ serverId: teamBotConsentDefaults.serverId })
        .from(teamBotConsentDefaults)
        .where(eq(teamBotConsentDefaults.userId, userId)),
    ]);
    return new Set([...forBot, ...forEvery].map((row) => row.serverId));
  }

  async function botOwnerOf(agentId: string): Promise<string | null> {
    const [row] = await database
      .select({ ownerUserId: agentProfiles.ownerUserId })
      .from(agentProfiles)
      .where(
        and(
          eq(agentProfiles.agentId, agentId),
          isNull(agentProfiles.deletedAt),
        ),
      )
      .limit(1);
    return row?.ownerUserId ?? null;
  }

  async function holdsAdminRole(userId: string): Promise<boolean> {
    const [held] = await database
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.role, "admin")))
      .limit(1);
    return held !== undefined;
  }

  /** 这个人在这位员工上待处理的申请，按应用键。 */
  async function pendingFor(userId: string, agentId: string) {
    const rows = await database
      .select({
        id: appAccessRequests.id,
        key: sql<string>`coalesce(${mcpServers.catalogueKey}, ${appAccessRequests.serverId}, ${appAccessRequests.appKey})`,
        kind: appAccessRequests.kind,
        createdAt: appAccessRequests.createdAt,
      })
      .from(appAccessRequests)
      .leftJoin(mcpServers, eq(mcpServers.id, appAccessRequests.serverId))
      .where(
        and(
          eq(appAccessRequests.requesterUserId, userId),
          eq(appAccessRequests.botId, agentId),
          eq(appAccessRequests.status, "pending"),
        ),
      )
      .orderBy(asc(appAccessRequests.createdAt));
    return rows;
  }

  async function describe(
    host: Host,
    apps: AppCandidate[],
    input: {
      userId: string | null;
      agentId: string;
      composioConfigured: boolean;
      ownersHeld?: OwnersHeld;
    },
  ): Promise<AppInspection[]> {
    const { userId, agentId } = input;
    const held = await heldKeys(host, agentId, input.ownersHeld);
    const owner = userId ? await teamBotOwnerFor(agentId, userId) : null;
    const [mine, owners, consented, pending, botOwner, isAdmin] =
      await Promise.all([
        userId ? connectionFacts(apps, userId) : null,
        owner ? connectionFacts(apps, owner) : null,
        owner && userId ? standingConsents(userId, agentId) : new Set<string>(),
        userId ? pendingFor(userId, agentId) : [],
        botOwnerOf(agentId),
        userId ? holdsAdminRole(userId) : false,
      ]);
    return apps.map((app) => {
      const granted = [app.key, ...app.rowIds].some((id) => held.has(id));
      const own = mine?.(app);
      const ownersAccount = owners?.(app);
      const personal = ownersAccount ?? own;
      const sharedUsable = app.team?.usable === true;
      const known: AppAccessFacts = {
        provider: app.provider,
        present: app.present,
        composioConfigured: input.composioConfigured,
        authScheme: app.authScheme,
        listedConnect: app.listedConnect,
        accountMode: app.accountMode,
        catalogueAuth: app.entry?.auth ?? null,
        hasCredential: app.hasCredential,
        granted,
        ownerGrants: null,
        mayGiveOwn: false,
        personal: personal === undefined ? null : { usable: personal.usable },
        shared: app.team ? { usable: sharedUsable } : null,
        sharedAdmitted: null,
      };
      const account = accountOf(known);
      /*
       * 共享闸门：与调用时 store 的闸门同一个函数、同一档受众（X3 之前只有员工主人与管理员）。只在能改变
       * 答案的地方问：持有、团队账号可用、问到了人。
       */
      const facts: AppAccessFacts =
        account === "shared" && sharedUsable && granted && userId
          ? {
              ...known,
              sharedAdmitted: admits(
                STRICTEST_APPROVAL,
                botOwner,
                { actorId: userId, isAdmin, groups: [] },
                { outside: false },
              ),
            }
          : known;
      const state = appAccessState(facts);
      const holder = ownersAccount !== undefined ? "owner" : "you";
      const requestKind = REQUEST_KIND_FOR[state];
      /*
       * 这个状态那一种申请；fork 的工具对已有行、未上架的应用提的是 enable（请管理员上架），批准后主人自己装，
       * 同样能让员工用上，所以已有行时它也算「已申请」。
       */
      const request =
        requestKind === null
          ? undefined
          : pending.find(
              (row) =>
                row.key === app.key &&
                (row.kind === requestKind ||
                  (requestKind === "grant" &&
                    row.kind === "enable" &&
                    app.present)),
            );
      return {
        access: {
          key: app.key,
          displayName: app.title,
          logo: app.logo,
          provider: app.provider,
          account,
          connect: connectOf(facts),
          authScheme: brokeredProvenance(app.provider) ? app.authScheme : null,
          accountMode: app.accountMode,
          state,
          unavailable: unavailableReason(facts),
          accountHolder: account === "personal" ? holder : null,
          asksFirst:
            state === "ready" &&
            account === "personal" &&
            holder === "you" &&
            owner !== null &&
            ![app.key, ...app.rowIds].some((id) => consented.has(id)),
          granted,
          ownerGrants: ownerGrantsOf(facts),
          givenByOwner: false,
          needsConnect: false,
          connectedAt:
            account === "shared"
              ? iso(app.team?.connectedAt)
              : account === "personal"
                ? (personal?.connectedAt ?? null)
                : null,
          requestKind,
          request: request
            ? {
                id: request.id,
                kind: request.kind as AppAccessRequestKind,
                createdAt: iso(request.createdAt) ?? "",
              }
            : null,
        },
        unavailable: unavailableReason(facts),
        answeringId: app.answeringId,
        rowIds: app.rowIds,
        toolkit: app.toolkit,
        entry: app.entry,
        sharedUsable,
        vouched: app.vouched,
        own: app.own,
      };
    });
  }

  return {
    /**
     * 员工持有的每个应用，各自对这个人是什么。按名字排序，两次读同一顺序。
     */
    async appAccessForBot(
      this: Host,
      input: {
        userId: string;
        agentId: string;
        composioConfigured: boolean;
        directory?: AppDirectory;
        ownersHeld?: OwnersHeld;
      },
    ): Promise<AppAccess[]> {
      const held = await heldKeys(this, input.agentId, input.ownersHeld);
      if (held.size === 0) return [];
      const { byName } = group(await allRows());
      const apps = new Map<string, AppCandidate>();
      const missing: string[] = [];
      for (const key of held) {
        const app = byName.get(key);
        if (app) apps.set(app.key, app);
        else missing.push(key);
      }
      const listed = missing.some((key) => key.startsWith(COMPOSIO_ID_PREFIX))
        ? await readDirectory(input.directory)
        : null;
      for (const key of missing) {
        const app =
          (await absentFor(key, undefined, listed)) ??
          absent({ key, title: key, provider: "custom" });
        if (!apps.has(app.key)) apps.set(app.key, app);
      }
      const described = await describe(this, [...apps.values()], input);
      return described
        .map((item) => item.access)
        .sort((left, right) =>
          left.displayName.localeCompare(right.displayName),
        );
    },

    /**
     * 一个应用，按调用者的任何叫法，对这位员工以及（给了 `userId` 时）这个人。叫不出来的为 null。
     * 对话卡片问它；批准路由不带人问它，只要部署这一半。
     */
    async inspectApp(
      this: Host,
      input: {
        app: string;
        agentId: string;
        userId: string | null;
        composioConfigured: boolean;
        directory?: AppDirectory;
        ownersHeld?: OwnersHeld;
      },
    ): Promise<AppInspection | null> {
      const candidate = await candidateFor(
        input.app,
        input.directory,
        await heldKeys(this, input.agentId, input.ownersHeld),
      );
      if (!candidate) return null;
      const [described] = await describe(this, [candidate], input);
      return described ?? null;
    },

    /**
     * 审计轨迹里关于申请的一行（上游 `app_access.*` 词汇），经与其他插件事件同一个脱敏写入器写。目标是
     * 应用键。
     */
    async recordAppAccessEvent(
      event: Omit<AuditEventInput, "targetType"> & {
        eventType:
          | "app_access.requested"
          | "app_access.cancelled"
          | "app_access.approved"
          | "app_access.dismissed"
          | "app_access.refused";
      },
    ): Promise<void> {
      await recordAuditEvent(auditStore, {
        ...event,
        targetType: "mcp_server",
      });
    },
  };
}
