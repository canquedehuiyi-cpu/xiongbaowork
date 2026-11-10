import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, credentials, deploymentPackages, users } from "./core";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Schema owned by Plugins: MCP servers a deployment has added, the tools they offer, packaged
 * skills, and which Bots may use any of it.
 *
 * One surface for both. A tool from an MCP server and a
 * packaged skill are different things to build and the same thing to govern: somebody adds it once
 * for the deployment, and then decides which Bots may use it. Two tables with two grant surfaces
 * would give an operator two places to look and two ways to be wrong about what a Bot can reach.
 */

/**
 * An MCP server this deployment has added.
 *
 * Account-wide, not per-Bot. Adding a server is an administrative act with a
 * credential behind it; which Bots may use its tools is a separate decision, recorded in
 * {@link pluginGrants}. Conflating them would mean adding a server to a second Bot re-entered the
 * credential, and a deployment would end up with the same vendor authorised several times over with
 * no single place to revoke it.
 *
 * `id` is the slug and a contract: it prefixes every tool name the model is offered, so a tool
 * from two servers can never collide, and a rule written against `mcp.server == "atlassian"` keeps
 * meaning the same thing after somebody renames the display title.
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    tenantId: tenantId(),
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    logo: text("logo"),
    /** The vendor this server is maintained by, which is what the first-party rule is checked against. */
    vendor: text("vendor").notNull(),
    url: text("url").notNull(),
    /**
     * `first-party` for a curated entry, `custom` for one an administrator added by URL, `composio`
     * for an app enabled through the broker.
     *
     * Recorded because the three are not the same risk. A curated entry has reviewed source provenance
     * and a pinned host. A custom one is a URL somebody typed, and every surface that lists it says so.
     * Storing which it is means the Plugins page, the audit trail and anybody reading the database
     * later all agree about how a server got here, rather than inferring it from whether the host
     * happens to still be in this build's catalogue.
     *
     * AND `composio` IS NOT MERELY A THIRD LABEL — it decides how the row is REACHED. `accessFor`
     * reads this column to answer that a call is brokered, which is what makes it run in the account
     * of the person asking rather than on the deployment's own credential, and `toolkitOf` then reads
     * which app out of {@link mcpServers.url}. So this column and that one are ONE FACT IN TWO PLACES,
     * and the invariant every writer keeps is that they are written together: a `composio://` url
     * carries `provenance = composio`, and a row saying `composio` carries a url naming an app. Half
     * of the pair is not a mislabelled row, it is a row dialled one way and governed another — see
     * `requireNotBrokered` in `plugins/store.ts` for which writes are refused to keep the pair whole,
     * and `addBrokeredApp` for the one that converts.
     */
    provenance: text("provenance").notNull().default("first-party"),
    /**
     * The vault row holding this server's credential, or null for a server that needs none.
     *
     * A pointer rather than the secret: the vault owns encryption, rotation and revocation, and a
     * second copy of a token here would be a second thing to remember to revoke.
     *
     * A REAL foreign key, where this was `text` against a `uuid` primary key with none. That is not a
     * typing nicety. The database was willing to hold a pointer to a credential row that did not
     * exist, and it did: a test deleted the credential an administrator had registered and left this
     * column addressing nothing, so the connector reported "no OAuth client registered yet" while the
     * row still looked configured. Nothing caught it because nothing was checking.
     *
     * `restrict`, not `cascade` or `set null`. A credential this server points at should not be
     * removable out from under it — the two legitimate ways to change it are replacing it, which
     * repoints this column first, and removing the server, which takes the row with it. Anything else
     * is a mistake, and should be refused rather than silently tidied into a working-looking state.
     */
    credentialId: uuid("credential_id").references(() => credentials.id, {
      onDelete: "restrict",
    }),
    /**
     * How this app connects, as it was resolved when somebody enabled it.
     *
     * Recorded rather than re-derived, because the catalogue is somebody else's and a vendor that
     * starts publishing a new scheme for an app must not move live connections onto a different
     * flow underneath them.
     *
     * THE VENDOR'S OWN SCHEME LITERAL, NOT A {@link BrokerConnection} KIND — `OAUTH2`, `DCR_OAUTH`,
     * `API_KEY`, `BASIC`, `BEARER_TOKEN`, `BASIC_WITH_JWT`, `NO_AUTH`. Those two vocabularies name one
     * fact, and this column is where a reader comes to find out which of them is written down, so it
     * says: somebody looking here for `consent` or `fields` is reading the other one. Migration 0038
     * backfilled every row whose provenance is `composio` to `OAUTH2`, because managed OAuth was the
     * only config this deployment ever created and `addBrokeredApp` writes the row only after that
     * config stands. A null is therefore not an older brokered row this deployment WROTE.
     *
     * WHICH IS NOT THE SAME AS A NULL BEING UNREACHABLE ON A BROKERED READ, and the difference has
     * cost a verdict already. Every reader finds an app's row by {@link mcpServers.url}, which carries
     * no unique index — two rows may name one app, and the one that answers is not always the one an
     * enable wrote a scheme onto. Add a row inserted by hand, a row restored from elsewhere, or an app
     * whose `BrokerConnection` was `unsupported`, and a brokered read really does meet a null here. So
     * a reader must have three answers and not two: a key, a consent, and a column it cannot act on.
     * `schemeKind` in `plugins/broker.ts` is that reading, and `confirmBrokeredConnection` is what
     * happened without it — a null read as consent, and `verified: true` written on every page load
     * over evidence nobody had.
     */
    authScheme: text("auth_scheme"),
    /** What the deployment last heard back from it. `null` until the first successful listing. */
    toolsRefreshedAt: timestamp("tools_refreshed_at", { withTimezone: true }),
    /** The last failure, kept so the Plugins page can say why a server has no tools. */
    lastError: text("last_error"),
    /**
     * 这台应用的工具是按哪一版的清单读法存下的：每次存下工具的刷新都写 `plugins/store.ts` 里的
     * `LISTING_REVISION`，这一列出现之前存的行是 0（迁移 0152，上游 0080）。
     *
     * 同一份 vendor 清单，OpenBot 记下的东西会随版本变：0146 开始把 Composio 什么标签都没给的动作
     * 记为 `unclassified`，之前记的是普通写操作。存下的行分不清这两种，所以不改写，而是重新列：
     * 每次启动，配置了 Composio 的部署把落后的 broker 应用重新列一次（`relistOutdatedBrokeredApps`），
     * 升级上来的部署就记下和全新安装一样的东西，不需要谁去按「刷新工具」。
     */
    listingRevision: integer("listing_revision").notNull().default(0),
    addedBy: text("added_by"),
    /**
     * WHICH CATALOGUE ENTRY this row is an instance of — ADR-0002's option B, and the reason the row
     * identity is allowed to be per-tenant.
     *
     * `id` used to carry both facts: the row's identity and the catalogue key. Since the key is a global
     * primary key, one deployment could hold exactly one `google-drive` row, so the first tenant that
     * added it owned it and every later tenant's "connect my own account" was refused by row-level
     * security and surfaced as a 500. Spec J4 asks for the opposite: the platform publishes a catalogue,
     * each tenant opens the entry into ITS OWN account, which means one row per (tenant, entry).
     *
     * So the two facts are split. Readers that mean "which app is this" — the catalogue lookup behind
     * the auth kind, `credentials.provider`, `plugin_grants.ref`, `skill_tools.ref`, the tool listings a
     * grant names — go to this column. Readers that mean "this row" keep `id`, and every child table's
     * `server_id` still points at a globally unique row, so no foreign key or cascade had to move.
     *
     * Null on rows that arrived without a catalogue entry at all: a URL an administrator typed
     * (`provenance = 'custom'`) and a brokered app (`composio-<slug>`) are each their own thing, not an
     * instance of a curated key, so a writer after the split leaves this null for them. Migration 0073
     * backfilled EVERY existing row from `id`, which is a faithful copy rather than a guess: before the
     * split, `id` was the key for exactly the rows the catalogue wrote, and for the others it was their
     * own name and nothing more.
     */
    catalogueKey: text("catalogue_key"),
    /**
     * broker 应用用谁的账号：`personal` 是每个人自己的账号，`shared` 是部署的一个团队账号（上游 0052，
     * fork 迁移 0180）。由 `plugins/shared-accounts.ts` 的 `accountFor` 读，只有管理员经
     * `plugins/account-mode.ts` 切换。
     *
     * 默认 `personal`，而上游是 NULL 再回填：fork 在这一列出现之前每个 broker 应用都是个人账号，默认值就是
     * 那个既有行为，不需要谁重新决定。NOT NULL；`accountFor` 对读不懂的值仍拒绝而不是猜。
     * 对不需要账号的应用（`NO_AUTH`）与非 broker 行，这一列不被读取。
     */
    accountMode: text("account_mode").notNull().default("personal"),
    /**
     * Shared 应用的团队账号在 vendor 处登记的身份，切到 Shared 时由 `mintDeploymentVendorUserId` 铸一次；
     * Personal 应用为 NULL（CHECK 保证）。
     */
    sharedVendorUserId: text("shared_vendor_user_id"),
    /**
     * 团队账号的连接状态，与 {@link composioConnections} 一个人的那一行是同一组事实：何时连接、谁连接的、
     * 是否经过检查、最后一次检查花在哪个动作上（读法见 {@link composioConnections.probeAction}）。
     *
     * 记在应用行上而不是另开一张「团队连接」表，是 fork 的取舍：应用行已经是 `team` 标记，任何人的帧都能读
     * （成员的调用要知道团队账号是否已连接），只有带管理员能力的请求能写（只有管理员能连接团队账号）。另开
     * 一张共享表需要新的 `team_*` 策略，而 0122 固定了共享表的集合。
     */
    sharedConnectedAt: timestamp("shared_connected_at", {
      withTimezone: true,
    }),
    sharedConnectedBy: text("shared_connected_by"),
    sharedVerified: boolean("shared_verified").notNull().default(false),
    sharedVerifiedAt: timestamp("shared_verified_at", { withTimezone: true }),
    sharedProbeAction: text("shared_probe_action"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "mcp_servers_account_mode_check",
      sql`${table.accountMode} IN ('personal', 'shared')`,
    ),
    check(
      "mcp_servers_shared_account_check",
      sql`(${table.accountMode} = 'shared' AND ${table.sharedVendorUserId} IS NOT NULL AND (${table.sharedConnectedAt} IS NULL OR ${table.sharedConnectedBy} IS NOT NULL)) OR (${table.accountMode} = 'personal' AND ${table.sharedVendorUserId} IS NULL AND ${table.sharedConnectedAt} IS NULL AND ${table.sharedConnectedBy} IS NULL AND ${table.sharedVerified} = false AND ${table.sharedVerifiedAt} IS NULL AND ${table.sharedProbeAction} IS NULL)`,
    ),
    /*
     * One row per tenant per catalogue entry — the constraint spec J4 actually asks for, and the whole
     * point of splitting the key off the identity.
     *
     * A unique index, not a primary key, so nothing that references a server row by `id` has to change:
     * `mcp_tools.server_id` and `mcp_user_credentials.server_id` still point at a globally unique row and
     * their cascades still mean what they meant. `catalogue_key` is nullable, and Postgres lets any number
     * of nulls stand in a unique index, which is exactly right: a URL an administrator typed and a brokered
     * app belong to no catalogue entry, so they must not be limited to one row per tenant between them.
     */
    uniqueIndex("mcp_servers_tenant_catalogue_key").on(
      table.tenantId,
      table.catalogueKey,
    ),
  ],
);

/**
 * A tool one server says it offers, as of the last listing.
 *
 * A cache of what the server said, never a source of truth about what it will accept. The row exists
 * so the Plugins page and the `@` menu can show a list without a network call per render, and so a
 * grant can name a tool that is not reachable this second. Every actual call re-reads the server.
 *
 * Rows are replaced wholesale on each refresh rather than merged, so a tool a vendor withdrew stops
 * being offered instead of lingering as a name the model will call and the server will reject.
 */
export const mcpTools = pgTable(
  "mcp_tools",
  {
    tenantId: tenantId(),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** The tool's own JSON Schema, passed to the model unchanged. */
    inputSchema: jsonb("input_schema").notNull().default({}),
    /**
     * What this action does, as the vendor itself described it, or null when nothing said.
     *
     * Recorded here rather than derived per call because the source is the listing: Composio labels
     * every action, and those labels arrive with the tool list and nowhere else. A hand-written write
     * list per app — which is what {@link CatalogueEntry.writeTools} is — cannot be kept for a
     * catalogue of several hundred apps that changes weekly, and a list naming only the actions
     * somebody thought of reads as a guard while behaving like a gap.
     *
     * PLAIN TEXT RATHER THAN AN ENUM, deliberately. The value is somebody else's vocabulary, so a
     * database enum would need a migration every time a vendor invents a label, and the migration
     * would be the thing standing between a refresh and a correct classification. `classifyTool`
     * defends instead: only the exact string `read` produces a read, so an unrecognised value fails
     * closed. Same reasoning as `mcp_servers.provenance`, which is text for the same reason.
     *
     * NULLABLE, AND NOT DEFAULTED TO "write". Every row that already exists was listed before this
     * column did, and a default would reclassify every Notion read as a write when the migration ran.
     * Null means "nothing said", and the classifier decides that means write.
     */
    effect: text("effect"),
    /**
     * Whether the vendor marked this action as destroying something.
     *
     * Separate from {@link mcpTools.effect} rather than a third value in it, so the rule engine keeps
     * the two values every existing policy is written against and nobody's rules need migrating. It
     * is recorded now because the confirmation card is what needs it, and re-listing every app later
     * to backfill a column is worse than carrying it from the start.
     *
     * `false` for an action nothing said about — the same fail-closed direction as `effect` without
     * claiming a vendor said something it did not. An unclassified action is already gated as a
     * write; marking it destructive as well would paint every ordinary write as dangerous and teach
     * an approver to click through the colour.
     */
    destructive: boolean("destructive").notNull().default(false),
    /**
     * vendor 列出了这个动作，却对它做什么只字未提：MCP 服务器没有 `readOnlyHint` 也没有
     * `destructiveHint`，或 Composio 没有只读、破坏性、新建、修改中的任何一个标签（迁移 0146）。
     *
     * 和 {@link mcpTools.destructive} 分开记：destructive 是 vendor 自己说的，会让每次调用都先问；
     * 这里没人说过它会删除什么。{@link mcpTools.effect} 记为 `write`，聊天里按普通修改处理；后台
     * 只读路径（连接探测等）对它和 destructive 一样谨慎，不去调用。
     *
     * 只在 catalogue 条目的名单没有覆盖它时才记：名单覆盖的工具照旧由名单决定读写，这里是 `false`。
     * 本列出现之前列出的行也是 `false`，应用下次刷新时重新记录。
     */
    unclassified: boolean("unclassified").notNull().default(false),
    /**
     * The vendor's version for this action, as the listing gave it — `20260903_00` and the like.
     *
     * NOT OPTIONAL BOOKKEEPING. Composio refuses to execute an action without a specific version,
     * and refuses the word `latest` too, so this column is what makes a call possible at all. It is
     * stored rather than fetched per call because it arrives free with the listing and fetching it
     * would be a second round trip on every single call.
     *
     * Null for every other transport, which publishes no such thing, and for rows listed before this
     * column existed. The Composio transport treats a missing version as a reason to refuse rather
     * than a reason to guess — a guessed version is a call against an action's other behaviour.
     */
    version: text("version"),
    /**
     * 厂商执行这个动作用的名字，与 {@link mcpTools.name} 不同时才有（X5，上游 0057）。Arcade 的
     * `qualified_name` 是 `Gmail.ListEmails`，点号不能出现在模型工具名里，所以 `name` 记 `ListEmails`、
     * 这里记原名，调用时发这里的。NULL 表示与 `name` 相同（迁移 0192 不回填）。
     */
    vendorName: text("vendor_name"),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.serverId, table.name] })],
);

/**
 * One person's Composio connection to one app.
 *
 * WHY THIS IS NOT `mcp_user_credentials`. That table's whole guarantee is that a row means real held
 * access: it points at a vault row, not-null, and the vault is what offboarding scans. Composio holds
 * the account, so there is no secret to point at and none to scan for — and `retireConnectionsFor`
 * deliberately reads the VAULT rather than the join table, because the join row is deleted along with
 * the person while the vault row survives. Putting a Composio connection there would mean removing
 * somebody deletes the only record of it, leaving their mailbox connected at Composio with nothing
 * left to revoke it by, while an administrator has been told they removed it.
 *
 * So `user_id` is plain text with NO foreign key and no cascade. The row outliving the person is the
 * point, not an oversight: it is the only thing that lets offboarding say "this person had Gmail
 * connected, tell Composio to drop it". A scope column would be a lie — Composio returns no scope we
 * see, and the column on the other table exists precisely to record what the vendor said it granted —
 * so there is none.
 *
 * A CACHE, NOT THE TRUTH. Composio is authoritative about whether a connection is live; this row
 * exists so the settings page can be drawn without a network call per row, and so offboarding has
 * something to iterate. A call against an app the person never connected fails at Composio, and that
 * refusal is the answer rather than this table's absence.
 */
export const composioConnections = pgTable(
  "composio_connections",
  {
    tenantId: tenantId(),
    /** The Composio app slug, lower case, as their directory spells it: `gmail`, `slack`. */
    toolkit: text("toolkit").notNull(),
    /**
     * The person, as `users.id`.
     *
     * The same value sent to Composio as the identity a call runs under, so the two cannot drift:
     * what this row says somebody connected is what a call will act as.
     */
    userId: text("user_id").notNull(),
    /** When they connected, shown on their own settings page. */
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Whether a real call was made with this connection and answered. See the verify path.
     *
     * TRUE ON EVERY ROW THAT PREDATES THIS COLUMN WITHOUT A PROBE BEHIND IT. Migration 0038 —
     * `server/drizzle/0038_composio_schemes.sql`, which is where this pair and `auth_scheme` are
     * both added and both backfilled; every "0038" in this file names that one file —
     * backfilled them to true with `verified_at = connected_at`, and no call was made to earn it:
     * every one of the rows it touched is a consent connection, which is verified by construction,
     * because the only way it exists at all is that the vendor's own screen sent the person back
     * connected. So on a backfilled row the timestamp is the moment of consent, not the moment of a
     * check, and a reader treating every `verified_at` as "this connection answered then" would be
     * wrong about exactly the rows that were here first.
     *
     * AND THE SAME NOW HOLDS OF EVERY CONSENT ROW AND NOT ONLY THE BACKFILLED ONES, because the
     * writer that records a connection sets `verified` itself: `recordBrokeredConnection` is the
     * one place a row is written, and `confirmBrokeredConnection` calls it with `verified: true` on
     * the vendor's yes. So a consent connection made today carries the same true migration 0038
     * wrote and earns it the same way — the vendor answered that the account is attached — and its
     * `verified_at` is the moment of that answer: the consent itself on the first confirm, and the
     * vendor's yes again on every later one, because a confirm really does go and ask. What it used
     * to do was insert on the defaults, and until it stopped, every consent connection made since
     * the backfill read `false` beside a null `verified_at` — the very pair a key connection nobody
     * has ever checked reads — so nothing could tell the two apart, and the rows the migration
     * touched were the only ones in the table saying anything true.
     *
     * ON A CONSENT ROW, AND ONLY THERE. That confirm runs from an effect on mount, so what it
     * writes it writes on every page load — and the vendor's yes is evidence about a KEY of
     * nothing, because Composio takes a key when it is typed and never tests it again. So the
     * confirm branches on the scheme recorded on the app's row: it writes this flag where consent
     * IS the check, and leaves a key connection's recorded verdict exactly as the last real call
     * left it. Written across a key row instead, it restated the consent pair below — `verified`
     * true beside a null `probe_action` — over the record of a check that had actually happened,
     * and moved this timestamp to the page load, so the page's own sentence named a day on which
     * nothing was checked.
     *
     * AND A CHECK THAT COULD NOT BE MADE LEAVES THIS COLUMN ALONE, which is the one thing a writer
     * of it must not improvise. `false` here means "no evidence that this connection answers", and
     * a Composio outage produces no evidence in EITHER direction — so on a connect, whose row has
     * to exist whatever happens, the outage is written as the unchecked pair, and on a re-check,
     * which finds a row already standing, NOTHING IS WRITTEN AT ALL. Clearing a verification
     * because the vendor could not be reached destroys the only record anywhere that this
     * connection was ever checked, and the date beside it, on the word of an event that says
     * nothing about the key. See {@link composioConnections.probeAction}.
     *
     * WHAT THE PAIR SEPARATES IS A CHECKED CONNECTION FROM AN UNCHECKED ONE, and never one KIND of
     * connection from another. Which kind a row is comes from the app's own `auth_scheme`, which
     * the settings page branches on first; this column says only that somebody established the
     * account is live, and `verified_at` when that was last done.
     */
    verified: boolean("verified").notNull().default(false),
    /** When that check last passed, which is what the page reports instead of a present tense. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /**
     * The action the last check SPENT on this connection, and null where it spent none.
     *
     * A RECORD OF WHAT HAPPENED, NOT A QUESTION ASKED OF TODAY'S METADATA — which is the whole
     * reason it is a column at all. `verified` is a fact about a check made against the app's action
     * listing as it stood THEN; this used to be derived on read from the listing as it stands NOW,
     * and the argument that the two agreed held only for as long as nothing changed in between.
     * Something can: `POST /servers/:id/refresh` is a generic administrator's route keyed on a
     * server id and `composio-<slug>` is one, so an ordinary press of Refresh re-lists a brokered
     * app's actions — the very press the Composio transport tells an operator to make when an
     * action gains the version that makes it callable. The moment it did, a row that truthfully
     * said "the key was accepted without being checked, because this app publishes nothing safe to
     * try one on" began reading as a NAMED probe beside `verified: false`, which the settings page
     * draws as "your key was checked and rejected, and the account still stands — disconnect it".
     * Every clause of that is false for somebody whose key was never tried, and it persisted: it is
     * what every page load said until they pressed Re-check.
     *
     * SO THE WRITER RECORDS IT, and the writer is the one place that cannot be wrong about it.
     * `recordBrokeredConnection` is the single writer of this row, every caller knows what it spent
     * — a probe's name, or nothing — and it is passed in beside `verified` because the two are one
     * fact: what was checked, and how it went.
     *
     * NULL MEANS NO ACTION WAS SPENT, WHICH IS NOT THE SAME AS UNCHECKED. Read beside `verified` it
     * says which:
     *
     *   null, not verified   — nothing was tried, so nothing is known about the key. EITHER the app
     *                          published nothing safe to spend one on at the moment of the check,
     *                          OR a check was attempted and could not be made — Composio
     *                          unreachable, a socket closed, an answer `@composio/core` could not
     *                          parse. A fact about the app or about the vendor's availability, and
     *                          in neither case about the key.
     *
     *                          THE OUTAGE WAS NOT ALWAYS HERE, and where it used to land is the
     *                          reason this clause is spelled out. `callTool` answers with a result
     *                          rather than throwing, so every failure it has wears `isError`, and
     *                          the probe read that as the vendor's verdict: an outage was written
     *                          down as the FOURTH state below — the accusation — while the connect
     *                          path deleted the account somebody had just made and told them their
     *                          key was refused. An unreachable vendor is not a fifth state and has
     *                          no column of its own, because the row records what is KNOWN about a
     *                          connection and an outage establishes nothing: the honest record is
     *                          the mildest pair, and the trail carries the attempt. See
     *                          {@link BrokeredProbe} in `plugins/store.ts` for the four answers a
     *                          check can reach and which of them may be written here.
     *   null, verified       — a CONSENT connection. The vendor's own yes at the end of its own
     *                          screen is the evidence, and no call was ever made against the
     *                          account, so there is no action to name and there never will be.
     *                          Which is why `confirmBrokeredConnection`, the one writer of this
     *                          pair, writes it only for a consent app: on a key row it is not a
     *                          heal but one of the other three states overwritten by a page load.
     *   a name, verified     — it ran in this person's account and the vendor took the key.
     *   a name, not verified — it ran and the vendor refused the key, and the account it ran in is
     *                          still standing. A live account with a bad key behind it.
     *
     *                          AND ONLY A CALL THE VENDOR ANSWERED MAY WRITE IT. This pair is an
     *                          accusation — the settings page draws it as "your key was checked and
     *                          rejected, disconnect it" — so the name is withheld from every
     *                          outcome that cannot be shown to have run in the account. That is
     *                          structural rather than a rule anybody has to remember:
     *                          {@link BrokeredProbe} carries no action name on the unreachable
     *                          outcome, so the writer has none to record.
     *
     * AND NULL ON A ROW WRITTEN BEFORE THIS COLUMN EXISTED, which is the same null and deliberately
     * so. No backfill is possible or wanted: what a check spent in March is not recoverable, and
     * today's chooser answering for it is exactly the inference this column retires. The rows
     * migration 0038 touched are consent rows, where null is permanently right; a key row that
     * predates it reads as unchecked, the mildest of the four states and the only safe direction to
     * be uncertain in — a name invented for it would be the false accusation above, written down.
     *
     * WHAT A CALLER MUST NOT READ IT AS is "the action this app could be checked with now". That is
     * a different question, asked of `probeActionFor`, and the two answers diverge exactly when
     * the app's listing has moved since the check.
     */
    probeAction: text("probe_action"),
    /**
     * 这一行连接属于哪个提供商（X5，迁移 0192）。默认 `composio`：这之前的每一行都是。启动时据此拒绝在
     * 另一个提供商还持有连接时切换（`assertActivatable`）。同一时间只有一个提供商写入，所以主键不变。
     */
    provider: text("provider")
      .$type<"composio" | "arcade">()
      .notNull()
      .default("composio"),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "composio_connections_provider_check",
      sql`${table.provider} IN ('composio', 'arcade')`,
    ),
    primaryKey({ columns: [table.toolkit, table.userId] }),
    // "What has this person connected" is the settings page's only query, and offboarding's.
    index("composio_connections_user_idx").on(table.userId),
  ],
);

/**
 * One person's grant on one MCP server: the row that makes a Bot answer as the asker.
 *
 * A table rather than a column, and this is the whole architectural point of the knowledge lane.
 * `mcp_servers.credential_id` holds what the DEPLOYMENT has — for a `user-oauth` vendor that is the
 * OAuth client, which reaches nobody's documents by itself. What reaches somebody's documents is
 * here, one row per person, and a call picks the row belonging to whoever asked. Two people asking
 * the same question therefore get the answers their own accounts can see, and neither can be served
 * the other's.
 *
 * The key is the pair. "Which credential serves this server for this person" must have exactly one
 * answer: with a surrogate id and no unique constraint, two rows for one pair are legal, and then
 * the answer is whichever the query happened to order first — so somebody who reconnected could keep
 * being served the grant they thought they had replaced.
 *
 * A pointer to the vault, never the secret, the same as everywhere else. The vault owns encryption,
 * rotation and revocation, and a second copy of a refresh token here would be a second thing to
 * remember to revoke when somebody disconnects.
 */
export const mcpUserCredentials = pgTable(
  "mcp_user_credentials",
  {
    tenantId: tenantId(),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * The vault row holding this person's refresh token.
     *
     * A real foreign key, unlike {@link mcpServers.credentialId}, which is `text` against a `uuid`
     * primary key and so references nothing the database will check. The new table does not copy
     * that.
     *
     * Deliberately not cascading. A revoked credential row is kept for the trail, and deleting the
     * row that says whose it was would take the trail with it.
     */
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => credentials.id),
    /**
     * What the vendor actually granted, as it said it — not what we asked for.
     *
     * The two differ in practice: a person can decline part of a consent screen. Storing the reply
     * rather than the request means a tool failing for want of a scope can be explained instead of
     * being a mystery about a permission we assumed we had.
     */
    scope: text("scope").notNull(),
    /**
     * When this person connected.
     *
     * Written out rather than using the shared `createdAt()` helper, which fixes the column name to
     * `created_at`. This row records an act somebody performed and a date they are shown on their
     * own settings page, so it is worth the column saying which act.
     */
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.userId] }),
    index("mcp_user_credentials_user_idx").on(table.userId),
  ],
);

/**
 * A packaged skill: a named instruction a person invokes with `/` and a Bot follows.
 *
 * Not a tool, and the difference matters. A tool is something a Bot calls; a skill is something a
 * Bot is told. Writing one adds no capability at all: it can only ask a Bot to use what that Bot was
 * already granted, and every one of those calls is still decided, policy-checked and audited. The
 * firewall is at the tool call, not at the prose, which is why anybody may write a skill while
 * adding an MCP server stays an administrator's decision.
 */
export const skills = pgTable(
  "skills",
  {
    tenantId: tenantId(),
    /**
     * The slug for a `system` row, which the package sync upserts on and `plugin_grants.ref` names;
     * a uuid for every tenant row (migration 0113), so a tenant row can never hold the id a catalogue
     * skill of the same slug needs.
     */
    id: text("id").primaryKey(),
    /**
     * Whose skill this is. Null means the deployment's: written by an administrator, or shipped,
     * and offered to everybody.
     *
     * A person's own skill is theirs alone. They may write one freely and put it on a Bot they own,
     * and nobody else sees it in their `/` menu or their list.
     */
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    /**
     * What a person types after `/`, unique within one tenant rather than across the deployment.
     *
     * Global uniqueness let the first tenant to write `/standup` take the name from every other one
     * (audit #9). A tenant's row under a slug the platform ships shadows the platform's row for that
     * tenant only; the platform's row is never edited by it. Every read by slug must therefore name
     * the tenant explicitly (`plugins/store.ts`), never lean on row security alone: the platform
     * frame sees every tenant's row under the same slug.
     */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    /** One line, shown in the catalogue and in the `/` menu. */
    summary: text("summary").notNull(),
    /** The instruction itself, prepended to the run when the skill is invoked. */
    instructions: text("instructions").notNull(),
    /** Where it came from: `catalogue` for one we ship, `yours` for one somebody wrote here. */
    origin: text("origin").notNull().default("yours"),
    installedBy: text("installed_by"),
    /**
     * Which deployment package brought this skill in — the marker that lets a brand switch take its own
     * content back out (ticket 029).
     *
     * Coworkers and conversations already carried it; skills did not, and that absence is what made a
     * sweep over them delete *another* package's skill. A deployment can hold more than one brand's rows
     * at once — `a redeploy takes back only grants from the package being synchronized` is an existing
     * test, not a wish — so "every catalogue skill this package does not declare" is not the same
     * question as "every catalogue skill there is".
     *
     * Null on a skill nobody can attribute: one a person wrote here, and one a shipped package paired
     * with no coworker, since the grant pairing is the only trail back to a brand. A sweep leaves nulls
     * alone, which keeps a ghost skill on the page rather than deleting somebody else's.
     */
    packageId: uuid("package_id").references(() => deploymentPackages.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("skills_tenant_slug_key").on(table.tenantId, table.slug),
    index("skills_owner_idx").on(table.ownerUserId),
    index("skills_package_idx").on(table.packageId),
  ],
);

/**
 * The tools a skill says it needs. A row is a declaration, and a declaration is not a grant.
 *
 * WHY THIS EXISTS. Choosing between a thousand tools is a retrieval problem, and the unit being
 * retrieved has to be the skill rather than the tool: a model picks the skill from its summary, and
 * the skill says which tools to load. Without this table there is no such unit. See K3.
 *
 * IT GRANTS NOTHING, AND THAT IS LOAD-BEARING RATHER THAN TIDY. Anybody signed in may write a skill,
 * precisely because a skill adds no capability — `plugins/routes.ts` says so where it declines to
 * require an administrator. If naming a tool here could make it callable, then writing a skill would
 * be a way to grant yourself a tool, and the one surface in this deployment that is deliberately not
 * an administrator's would become the way around every surface that is. What a Bot may call stays
 * `plugin_grants`; this only ever narrows what is offered out of what was already granted.
 *
 * NO FOREIGN KEY TO `mcp_tools`, on purpose. Refreshing a server deletes every one of its tool rows
 * and writes them again (`plugins/store.ts`), so a composite key with `on delete cascade` would empty
 * every skill's declarations on a routine refresh. `plugin_grants.ref` is plain text for the same
 * reason, and holding the two in the same shape is what lets them be compared without either side
 * parsing the other's format. The cost is a ref that can outlive the tool it names, which is the
 * price grants already pay, and is why a missing tool must read as "load nothing" rather than as an
 * error at run time.
 */
export const skillTools = pgTable(
  "skill_tools",
  {
    tenantId: tenantId(),
    skillId: text("skill_id")
      .notNull()
      // ON UPDATE CASCADE so the re-key in migration 0113 carries every declaration along.
      .references(() => skills.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    /** `<serverId>/<toolName>`, the same key a grant is written against. */
    ref: text("ref").notNull(),
    declaredBy: text("declared_by"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.skillId, table.ref] }),
    // Answering "which skills want this tool" without scanning, for the withdrawal question in #106.
    index("skill_tools_ref_idx").on(table.ref),
  ],
);

/**
 * One Bot's hold on one plugin, whether that plugin is an MCP tool or a skill. A row is the grant.
 *
 * Absence is the refusal, the same shape component grants use and for the same reason. A Bot
 * created before a server was added, a deployment that lost this table, a tool nobody ever enabled:
 * all of them land on "not granted", which is a refusal. An `enabled` boolean would make a missing
 * row undefined behaviour, and undefined behaviour in a grant table resolves to "allowed" the first
 * time somebody is in a hurry.
 *
 * One table for both kinds. `kind` says which, and `ref` names it: `<serverId>/<toolName>` for an
 * MCP tool, the slug for a skill. A second table would mean two code paths asking the same question
 * and two chances for them to disagree.
 */
export const pluginGrants = pgTable(
  "plugin_grants",
  {
    tenantId: tenantId(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by"),
    assemblyBinding: jsonb("assembly_binding"),
    grantedAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.ref, table.agentId] }),
    index("plugin_grants_agent_idx").on(table.agentId),
  ],
);

/**
 * A component authored in the browser rather than compiled into the build.
 *
 * This is not a column on `components`. That table governs components the build ships: its rows
 * describe something the code already owns, and a fork that deletes the React file leaves a row the
 * Admin page reports as missing. A sandboxed component has no React file and never will, so the
 * source is the row. Putting the source on the same table would mean every compiled component
 * carried three permanently empty columns, and "is this row backed by code" would become a question
 * about whether a text field happened to be blank.
 *
 * The two share the grant surface and the publish gate, because an operator deciding what a Bot may
 * answer with should not have to know which of the two they are looking at.
 */
export const sandboxedComponents = pgTable("sandboxed_components", {
  tenantId: tenantId(),
  /** The tool name the model calls. Namespaced on save so it can never collide with a compiled one. */
  name: text("name").primaryKey(),
  title: text("title").notNull(),

  /**
   * The draft, which is what the playground edits, and the published copy, which is the only version
   * that ever renders or reaches a model.
   *
   * Separate columns rather than one live body. Publishing without a rebuild is the whole point of
   * this table, and it is also what makes an editor one keystroke away from changing what every Bot
   * draws in production. A draft absorbs that: it is edited freely, previewed against sample
   * arguments, and changes nothing until somebody publishes it. Same reason the catalogue splits a compiled
   * component's description, and the same fail-closed property: null published means no model is
   * ever offered this component, so a half-written draft cannot be called.
   */
  draftDescription: text("draft_description").notNull().default(""),
  draftHtml: text("draft_html").notNull().default(""),
  draftCss: text("draft_css").notNull().default(""),
  /**
   * Functions the body may call, as source. Runs inside `@jetbrains/websandbox`, so it reaches
   * neither the page, the session nor the network except through what the host hands it.
   */
  draftJsFunctions: text("draft_js_functions").notNull().default(""),
  /**
   * The arguments this component takes, as JSON Schema. This is what the model fills in, so it is
   * the difference between a component a model can use and one it will call wrongly forever.
   */
  draftArgumentSchema: jsonb("draft_argument_schema").notNull().default({}),

  publishedDescription: text("published_description"),
  publishedHtml: text("published_html"),
  publishedCss: text("published_css"),
  publishedJsFunctions: text("published_js_functions"),
  publishedArgumentSchema: jsonb("published_argument_schema"),

  /** Sample arguments the playground previews against, kept so the next editor sees what it draws. */
  sampleArguments: jsonb("sample_arguments").notNull().default({}),
  /** Bumped on every publish, so a reader can tell which version of a component drew something. */
  revision: integer("revision").notNull().default(0),
  published: boolean("published").notNull().default(false),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  authoredBy: text("authored_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * 一次进行中的 Arcade 授权：回程验证拿它核对回来的浏览器（X5，上游 0057，迁移 0192）。
 *
 * `actor_id` 是会话主体（`users.id`），从不是 Team Bot 的 `credentialActorId`：验证路由按回来的浏览器的
 * 会话找这一行。键只有发起人，所以一个人同时最多一次；过期（15 分钟）或已结束的行可被新的发起接管。
 * `auth_id` 把回调绑定到这一次，为 NULL 的尝试永远完成不了；`completed_at` 让完成只发生一次。
 * `user_id` 只能是发起人自己（`person`）或 NULL（`deployment`，团队账号），删一个人不会带走别人发起的尝试。
 */
export const pendingAuthorizations = pgTable(
  "pending_authorizations",
  {
    tenantId: tenantId(),
    actorId: text("actor_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    /** 按「授权」为之发起的那一个动作；「连接」（整应用）为 NULL。 */
    action: text("action"),
    holder: text("holder").$type<"person" | "deployment">().notNull(),
    userId: text("user_id"),
    vendorUserId: text("vendor_user_id").notNull(),
    authId: text("auth_id"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    outcome: text("outcome").$type<
      "completed" | "failed" | "unreconciled" | "withdrawn"
    >(),
  },
  (table) => [
    check(
      "pending_authorizations_holder_check",
      sql`(${table.holder} = 'person' AND ${table.userId} IS NOT NULL) OR (${table.holder} = 'deployment' AND ${table.userId} IS NULL)`,
    ),
    check(
      "pending_authorizations_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('completed', 'failed', 'unreconciled', 'withdrawn')`,
    ),
    check(
      "pending_authorizations_completion_check",
      sql`(${table.completedAt} IS NULL) = (${table.outcome} IS NULL)`,
    ),
    check(
      "pending_authorizations_user_is_actor_check",
      sql`${table.userId} IS NULL OR ${table.userId} = ${table.actorId}`,
    ),
    // 一次尝试落在发起人自己的租户里（评审 M1，迁移 0192）。
    check(
      "pending_authorizations_tenant_is_actor_check",
      sql`${table.tenantId} = ${table.actorId}`,
    ),
    index("pending_authorizations_server_idx").on(table.serverId),
  ],
);
