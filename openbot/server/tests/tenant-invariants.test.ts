import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sql } from "drizzle-orm";
import ts from "typescript";
import { createDatabase } from "../src/db/client";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The G01-E security invariants (plan §1, I1–I10) that can be read off the code and the catalogue
 * rather than exercised one route at a time. Each is a door counted, not a behaviour sampled: a new
 * way into `platform`, a new fallback to `system`, a frame opened as `team`, or a policy or definer
 * function that does not fit the shape every other one has, fails here until somebody decides it.
 *
 * The source checks parse each file with the TypeScript compiler, so a call split over lines counts
 * the same as one on a single line, and a call named in a comment does not count at all.
 */

const SERVER = join(import.meta.dir, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")
        ? [path]
        : [];
    })
    .sort();
}

type Parsed = { file: string; text: string; source: ts.SourceFile };

function parse(directory: string): Parsed[] {
  return sourceFiles(join(SERVER, directory)).map((path) => {
    const text = readFileSync(path, "utf8");
    return {
      file: relative(SERVER, path),
      text,
      source: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true),
    };
  });
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const lineOf = (parsed: Parsed, node: ts.Node) =>
  `${parsed.file}:${parsed.source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

/** The ways out of a person's frame into one that is nobody's, or into someone else's. */
const DOORS = [
  "asPlatform",
  "asAdminPlatform",
  "adminActAsOwner",
  "withCapability",
] as const;
const DOOR_NAMES = new Set<string>(DOORS);

/** The tenant constants, read as the literal they stand for. */
const TENANT_CONSTANTS: Record<string, string> = {
  PLATFORM_TENANT: "platform",
  SYSTEM_TENANT: "system",
  TEAM_TENANT: "team",
};

/** The name a call is made through: `f(...)` and `scope.f(...)` both answer `f`. */
function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** `runAsTenant`'s first argument when it is a literal tenant (or a tenant constant), else undefined. */
function literalTenant(call: ts.CallExpression): string | undefined {
  const [first] = call.arguments;
  if (!first) return undefined;
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
    return first.text;
  if (ts.isIdentifier(first)) return TENANT_CONSTANTS[first.text];
  return undefined;
}

/**
 * Per file: how many times each door is called, and how many times `runAsTenant` is called with
 * each literal tenant, keyed the way the map below spells them.
 */
function doorCounts(files: Parsed[]): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const parsed of files) {
    const bump = (key: string) => {
      const file = counts[parsed.file] ?? {};
      file[key] = (file[key] ?? 0) + 1;
      counts[parsed.file] = file;
    };
    walk(parsed.source, (node) => {
      if (!ts.isCallExpression(node)) return;
      const name = calleeName(node);
      if (name !== undefined && DOOR_NAMES.has(name)) bump(`${name}(`);
      if (name === "runAsTenant") {
        const tenant = literalTenant(node);
        if (tenant !== undefined) bump(`runAsTenant(${JSON.stringify(tenant)}`);
      }
    });
    // A raw session setting is a frame too, opened beside the client instead of through it.
    for (const match of parsed.text.matchAll(
      /set_config\(\s*'app\.tenant_id'\s*,\s*([^,)]+?)\s*,/g,
    ))
      bump(`set_config('app.tenant_id', ${match[1]}`);
    /*
     * WF9: the share token is a door too, into exactly one other tenant's row (a share link). It is
     * counted with its third argument, so a session-wide setting (`false`) reads as a new door.
     */
    for (const match of parsed.text.matchAll(
      /set_config\(\s*'app\.flow_share_token'\s*,\s*[^,)]+?\s*,\s*(\w+)\s*\)/g,
    ))
      bump(`set_config('app.flow_share_token', local=${match[1]}`);
  }
  return counts;
}

/**
 * I5: every door out of a person's frame in `src`, by file, with its count and literal argument.
 *
 * `platform` is for admins and background work only: admin routes open it after `requireAdmin`
 * through `asAdminPlatform` / `adminActAsOwner`, and background, boot, identity and script code
 * through `runAsTenant("platform")` / `asPlatform`, for one call. No member request path opens it.
 * A changed count here is a door added or removed: say which, and why it is not a member path, in
 * the change that moves it.
 *
 * Beside the identity layer (`auth/guards.ts`, `index.ts`'s runtime actor lookup, `app.ts`'s auth
 * handler) and the refusal rows `app.ts` files as nobody's for a bad worker secret or callback token,
 * five doors are reachable by a member's or a signed-out request on purpose, each one narrow read:
 * `delivery/store.ts` (`registerDevice`'s platform lookup of who already holds a device token, plan
 * (d), and `bind`'s lookup of who already holds a delivery identity — a row stamped with the
 * holder's tenant that the caller's frame cannot see, so the refusal is answered instead of a bare
 * 42501) and `agents/profile-store.ts` (the callback route's `asPlatform` read of {id, tenantId} by
 * token hash, PCB), which both hand the work back to a person's frame; `app.ts`'s
 * `/api/capabilities` count of identity providers, which signed-out requests reach too (P16a): it
 * reads deployment rows and only the count leaves; and `automations/ingress-routes.ts`'s public
 * hook (D06 AUT2, signed out): one read of a webhook trigger by id — its owner, secret hash and the
 * automation's limits — after which the secret is checked and the queue offer and audit row run in
 * the owner's frame the trigger row names, never in one the request could choose.
 */
const SRC_DOORS: Record<string, Record<string, number>> = {
  "src/admin/controls.ts": { 'runAsTenant("platform"': 6 },
  "src/admin/routes.ts": { "asAdminPlatform(": 1, 'runAsTenant("platform"': 1 },
  "src/agents/bot-owner.ts": { "asPlatform(": 2 },
  "src/agents/handoff-runner.ts": { 'runAsTenant("platform"': 1 },
  // A Bot's audit trail for an administrator holding the capability (D07): finding another person's
  // private Bot as `platform` (as GET /api/agents/:agentId does), and reading its rows across tenants.
  "src/agents/lifecycle-routes.ts": { "asAdminPlatform(": 2 },
  "src/agents/profile-store.ts": { "asPlatform(": 1 },
  "src/agents/routes.ts": { "adminActAsOwner(": 1, "asAdminPlatform(": 3 },
  "src/agents/wake-up.ts": { 'runAsTenant("platform"': 2 },
  // The fourth is the signed-out /api/capabilities count of identity providers (deployment rows).
  // The second `asAdminPlatform` is the audit trail's CSV export (upstream #751), read as the list is.
  // M5: the third and fourth are upstream's admin drafting routes (#1381, #1397–#1399), which
  // replay a draft over everybody's trail (`adminAuditReader`) and approval requests
  // (`adminApprovals`), only for an administrator holding the capability.
  "src/app.ts": {
    "adminActAsOwner(": 1,
    "asAdminPlatform(": 4,
    'runAsTenant("platform"': 4,
  },
  // M3: the second is upstream's prune of everybody's check-in ledger and pings (housekeeping).
  "src/audit-retention.ts": {
    'runAsTenant("platform"': 2,
    "set_config('app.tenant_id', 'platform'": 1,
  },
  "src/audit.ts": { 'runAsTenant("platform"': 1 },
  // The signed-out automation hook's trigger lookup by id (see the header); the rest is the owner's.
  "src/automations/ingress-routes.ts": { 'runAsTenant("platform"': 1 },
  // The scheduler's background statements across every tenant: `dueTriggers` (which triggers are
  // due) and `reapAbandonedFirings` (firings a dead server left running are marked failed).
  "src/automations/store.ts": { 'runAsTenant("platform"': 2 },
  "src/auth/admin-scope.ts": { "asPlatform(": 3, "withCapability(": 1 },
  "src/auth/dev-actor.ts": { 'runAsTenant("platform"': 2 },
  "src/auth/guards.ts": { 'runAsTenant("platform"': 2 },
  "src/auth/role-writer-lifecycle.ts": { 'runAsTenant("platform"': 3 },
  "src/channels/summary.ts": { 'runAsTenant("platform"': 2 },
  "src/computer/policy-store.ts": { 'runAsTenant("platform"': 1 },
  "src/computer/routes.ts": { "asAdminPlatform(": 1 },
  // A signed-out runtime `/info` reads the deployment's catalogue roster, as `system` (P16f).
  "src/copilot.ts": { 'runAsTenant("system"': 1 },
  "src/credentials-reseal.ts": { 'runAsTenant("platform"': 2 },
  "src/db/client.ts": { "set_config('app.tenant_id', ${tenant}": 2 },
  // M3: the third finds the binding a chat sender names, then checked against its own tenant.
  "src/delivery/opentag-agent.ts": { 'runAsTenant("platform"': 3 },
  "src/delivery/router.ts": { 'runAsTenant("platform"': 3 },
  // `bind`'s fourth: who already holds a delivery identity. The holder's row is stamped with the
  // holder's tenant and so invisible to the caller's frame; it is read as `platform`, a holder who
  // is not the caller is refused there, and the write stays in the caller's own frame.
  "src/delivery/store.ts": { 'runAsTenant("platform"': 4 },
  "src/devices/store.ts": { 'runAsTenant("platform"': 4 },
  // The third is the background translator (migration 0145): it reads and writes only
  // `text_translations`, a deployment-wide cache with no tenant column and no row security, and
  // touches no tenant's rows. The fourth is the boot refresh of OpenBot's own apps' saved tools
  // (`refreshOwnListings`, upstream #1130): not awaited, it reads every `mcp_servers` row and rewrites
  // the `mcp_tools` of a Routines, Google Drive or 百度网盘 row whose saved list differs from this
  // build's code, each stamped with its own server's tenant. No request reaches it. The fifth is each
  // round of the broker relist (`relistOutdatedBrokeredApps`, upstream #1185), started only when
  // Composio is configured: it re-lists the Composio apps whose `listing_revision` is behind, through
  // the ordinary `refreshTools`, each app's tools stamped with its own row's tenant. No request
  // reaches it either.
  // Linked accounts (upstream #763): who an outside account is, which person a code was issued to,
  // cancelling an exposed code — each about a sender nobody knows yet — and clearing codes a day
  // dead. Every other write runs as the person the row belongs to.
  "src/identity/store.ts": { 'runAsTenant("platform"': 4 },
  // Learning's container assignment is the deployment's (start, the nudge on read, Admin's check),
  // and the GitHub callback's "is this person still active" reads the deployment's people table.
  // M3: upstream's wiring adds "who is this" reads, each commented where it is made: the session,
  // roles and Entra token of a request not yet framed, a Bot's isolation switch and owner for its
  // computer seat, people's names and their OpenBot browsers for the admin computer list, Learning's
  // open sources, withheld skills and people, every live Recorder connection, the boot-time model
  // check; and the background translator of `text_translations` (no tenant column).
  // The three `runAsTenant("platform")` are that translator and, from main, the boot refresh of
  // OpenBot's own apps' saved tools (`refreshOwnListings`) and the broker relist rounds
  // (`relistOutdatedBrokeredApps`), described above.
  // M5: the nineteenth `asPlatform` is `adminRead`, the reads behind upstream's admin drafting
  // routes (audit questions, what-if, grant decisions), taken only while the capability is held.
  "src/index.ts": { 'runAsTenant("platform"': 3, "asPlatform(": 19 },
  // M3: an administrator's review of everybody's skill-sharing requests, behind the admin gate.
  "src/learning/routes.ts": { "asPlatform(": 2 },
  "src/memory/ingestion.ts": { 'runAsTenant("platform"': 2 },
  // Whose memories are out of step with Intelligence (upstream #773); each person's are then
  // mirrored in their own frame.
  "src/memory/store.ts": { 'runAsTenant("platform"': 1 },
  "src/pipeline/reap.ts": { 'runAsTenant("platform"': 1 },
  // Which run holds an approval (I3), and WF7's restart sweep for parents waiting on an ended child;
  // each run found is then settled in the tenant on its own row.
  "src/pipeline/store.ts": { 'runAsTenant("platform"': 2 },
  // Spec J5's operator reads, after `requireAdmin` and the re-checked admin capability: a page of
  // the tenant list and one tenant's audit trail as `platform`, and each listed tenant's model tokens
  // in that tenant's own frame (`model_token_calls` is owner-only), through the audited owner door.
  "src/platform/routes.ts": { "adminActAsOwner(": 1, "asAdminPlatform(": 2 },
  "src/platform/store.ts": { 'runAsTenant("platform"': 3 },
  "src/plugins/logos.ts": { 'runAsTenant("platform"': 2 },
  // 授予时进入 Bot 主人的帧（asBotOwner），以及申请访问的收件箱（迁移 0153）：持有 capability 的管理员
  // 在 platform 帧里列出所有人的 pending 申请、按 id 读一条，处理结果经 adminActAsOwner 写回申请人的帧。
  // 申请人自己的读、撤回都在本人的帧里，不经过这些入口。
  "src/plugins/routes.ts": { "adminActAsOwner(": 2, "asAdminPlatform(": 3 },
  // Install listings (admin-only), and `removeServer`'s reach over every person's rows tied to one
  // team server (their tokens, brokered connections and grants for it), after `requireServerWriter`
  // has checked the admin capability (P21). The fourth is reachable from a member's request on
  // purpose: `discoverToolsOnConnect` (upstream #1073), from the OAuth callback once the sealed
  // state's person has been checked and their connection recorded. It refuses unless the frame is
  // that person's own, and acts only when the app holds no tools at all. The row is resolved, the
  // person's token exchanged and the vendor asked in the PERSON's frame, so P10 still applies there,
  // and it never registers a replacement OAuth client (`reRegister: false`: an `invalid_client` only
  // lands in `lastError`). Only the writes after the listing (the server's `team` tool rows, its
  // status columns and the audit rows) run as `platform`.
  "src/plugins/store.ts": { 'runAsTenant("platform"': 4 },
  // M3: upstream's engine asks as `platform` what is unoffered, whom to ping, what is stale and
  // what is due; each setting then runs in the tenant stamped on its own row.
  "src/proactive/engine.ts": { 'runAsTenant("platform"': 5 },
  // L1: the local learning sweep asks as `platform` which people have had conversations lately and
  // claims those due (one conditional upsert on `local_learning_state`, people who still exist only),
  // and closes runs a dead process left `running`. Each person then learns in their own frame.
  "src/local-learning/engine.ts": { "asPlatform(": 2 },
  "src/quota/routes.ts": { 'runAsTenant("platform"': 1 },
  // M3: the Recorder (upstream): a connect code is spent before anybody is known, so its refusals,
  // the code's owner and every live connection are read as `platform`; the connection itself is made
  // in the owner's frame.
  "src/recorder/connections.ts": { "asPlatform(": 3 },
  "src/recorder/routes.ts": { "asPlatform(": 1 },
  "src/recorder/wiring.ts": { "asPlatform(": 3 },
  "src/recovery/abandoned-work.ts": { 'runAsTenant("platform"': 1 },
  "src/responsibilities/email.ts": { 'runAsTenant("platform"': 1 },
  "src/responsibilities/github.ts": { 'runAsTenant("platform"': 1 },
  "src/responsibilities/slack.ts": { 'runAsTenant("platform"': 1 },
  "src/responsibilities/trigger-routes.ts": { 'runAsTenant("platform"': 1 },
  "src/routines/runner.ts": { 'runAsTenant("platform"': 1 },
  "src/routines/store.ts": { 'runAsTenant("platform"': 6 },
  "src/tasks/projector.ts": { 'runAsTenant("platform"': 1 },
  "src/team-bots/routes.ts": { "adminActAsOwner(": 1, "asAdminPlatform(": 5 },
  // The catalogue sync writes the deployment's own `system` rows (package-declared Bots).
  // M3: the second is `deploymentNameOf`, reading at boot which former package rows the sync keeps.
  // The platform reads are the connector conflict precheck and the agent conflict precheck — both
  // BEFORE the sync's transaction (4a-A1; the agent read also needs a pooled connection of its own,
  // which inside the transaction deadlocked against the one the transaction pins) — and
  // `clearDanglingConnectorRefs` after its commit. All three read rows stamped by other frames and
  // write nothing in any of them; the sync refuses with the id before it writes. 用户已批准的补登：
  // 前两处在门清单建档前就已存在（agent 预查从事务内移到事务旁不增减门的数量）。
  "src/tenant-package.ts": {
    'runAsTenant("platform"': 3,
    'runAsTenant("system"': 2,
  },
  "src/tenant/access.ts": { 'runAsTenant("platform"': 1 },
  // `asPlatform` itself.
  "src/tenant/context.ts": { 'runAsTenant("platform"': 1 },
  // 群组挂接（设计稿 group-unify 3.1、4.5）：`facts()` 以 `platform` 读一行频道的 tenant_id、
  // created_by、title、name、waker_group_id、是否软删，用来定所有者。共享群的所有者是创建者，不一定是
  // 调用者的帧（开机任务、自愈），所以这一读不能在调用者帧里做。读到之后，建群组、写镜像、挂接、改名
  // 全在 `runAsTenant(所有者)` 里，所有者只认个人租户（`channelOwner`）。`linkedGroupOf` 只用于调用方
  // 已校验过读权限的频道 id。
  "src/waker-groups/channel-link.ts": { "asPlatform(": 1 },
  // WF8: the fourth finds retries a restart left `prepared`, across tenants; each is settled in its own.
  "src/wakerflows/recovery.ts": { 'runAsTenant("platform"': 4 },
  /*
   * WF9 (D1, D7): an importer reads, and adds one use to, the one share link whose token they hold,
   * in their OWN frame: `SET LOCAL app.flow_share_token` inside one transaction, never platform. What
   * that row may become in a frame not its owner's is fixed by `openbot_flow_share_guard` (0141).
   */
  "src/wakerflows/sharing.ts": {
    "set_config('app.flow_share_token', local=true": 1,
  },
  "src/work/culler.ts": { 'runAsTenant("platform"': 2 },
  "src/work/loop.ts": { 'runAsTenant("platform"': 1 },
  "src/work/queue.ts": { 'runAsTenant("platform"': 6 },
};

/**
 * (c) The test files that name `team` as a frame, each to assert that it is refused (and, in
 * `team-tenant-rls`, the whitelisted exploit test that a raw `team` session reads and writes
 * nothing). Pinned so a new one is a decision, not an accident.
 */
const TEST_TEAM_FRAMES: Record<string, number> = {
  "tests/agent-handoff-endtoend.integration.test.ts": 1,
  "tests/local-threads.test.ts": 1,
  "tests/team-tenant-rls.integration.test.ts": 1,
  "tests/tenant-frame-guard.test.ts": 4,
  "tests/tenant-rls.test.ts": 1,
  "tests/tenant-transaction-frame.integration.test.ts": 2,
};

const src = parse("src");
const tests = parse("tests").filter(
  (parsed) => parsed.file !== "tests/tenant-invariants.test.ts",
);

describe("doors out of a person's frame (I5, I6, I10)", () => {
  test("every call that opens platform, acts as an owner or grants the capability is in the map", () => {
    expect(doorCounts(src)).toEqual(SRC_DOORS);
  });

  test("the admin capability is granted in exactly one place", () => {
    const granted = Object.entries(doorCounts(src))
      .filter(([, counts]) => counts["withCapability("] !== undefined)
      .map(([file]) => file);
    expect(granted).toEqual(["src/auth/admin-scope.ts"]);
  });

  test("no door is handed around by name, where the counts above would not see it called", () => {
    const handed: string[] = [];
    for (const parsed of src)
      walk(parsed.source, (node) => {
        if (!ts.isIdentifier(node) || !DOOR_NAMES.has(node.text)) return;
        const parent = node.parent;
        const called =
          (ts.isCallExpression(parent) && parent.expression === node) ||
          (ts.isPropertyAccessExpression(parent) &&
            parent.name === node &&
            ts.isCallExpression(parent.parent) &&
            parent.parent.expression === parent);
        const declared =
          (ts.isFunctionDeclaration(parent) ||
            ts.isVariableDeclaration(parent)) &&
          parent.name === node;
        const imported =
          ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent);
        if (!called && !declared && !imported)
          handed.push(`${parsed.file} ${node.text}`);
      });
    // `createAdminScope` returns its two doors; every caller then calls them by name.
    expect(handed).toEqual([
      "src/auth/admin-scope.ts adminActAsOwner",
      "src/auth/admin-scope.ts asAdminPlatform",
    ]);
  });
});

describe("no silent fallback (I7)", () => {
  test("(b) nothing in src falls back to the system tenant with ?? or ||", () => {
    const fallbacks: string[] = [];
    for (const parsed of src)
      walk(parsed.source, (node) => {
        if (!ts.isBinaryExpression(node)) return;
        const operator = node.operatorToken.kind;
        if (
          operator !== ts.SyntaxKind.QuestionQuestionToken &&
          operator !== ts.SyntaxKind.QuestionQuestionEqualsToken &&
          operator !== ts.SyntaxKind.BarBarToken &&
          operator !== ts.SyntaxKind.BarBarEqualsToken
        )
          return;
        const right = node.right;
        const system =
          ((ts.isStringLiteral(right) ||
            ts.isNoSubstitutionTemplateLiteral(right)) &&
            right.text === "system") ||
          (ts.isIdentifier(right) && right.text === "SYSTEM_TENANT");
        if (system) fallbacks.push(lineOf(parsed, node));
      });
    expect(fallbacks).toEqual([]);
  });
});

describe("team is a stamp, never a frame (I3)", () => {
  const teamFrames = (files: Parsed[]) =>
    Object.fromEntries(
      Object.entries(doorCounts(files))
        .filter(([, counts]) => counts['runAsTenant("team"'] !== undefined)
        .map(([file, counts]) => [file, counts['runAsTenant("team"']]),
    );
  const rawTeamSessions = (files: Parsed[]) =>
    files
      .filter((parsed) =>
        /set_config\(\s*'app\.tenant_id'\s*,\s*'team'/i.test(parsed.text),
      )
      .map((parsed) => parsed.file);

  test("(c) src never opens a team frame, through the client or beside it", () => {
    expect(teamFrames(src)).toEqual({});
    expect(rawTeamSessions(src)).toEqual([]);
  });

  test("(c) tests name team as a frame only where they assert it is refused", () => {
    expect(teamFrames(tests)).toEqual(TEST_TEAM_FRAMES);
    expect(rawTeamSessions(tests)).toEqual([]);
  });
});

/*
 * The catalogue: what the database the server writes to actually enforces. Read in the explicit
 * `system` frame, as every catalogue read in this suite is: `pg_*` are not a tenant's rows.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
afterAll(async () => {
  await database.$client.close();
});

async function catalogue<T>(query: string): Promise<T[]> {
  return Array.from(
    (await runAsTenant("system", () =>
      database.execute(sql.raw(query)),
    )) as ArrayLike<T>,
  );
}

/**
 * The policy names a clause naming `team` may carry: the four families 0122 introduced, and the two
 * RESTRICTIVE stamp checks later migrations added — `team_roster_stamp_insert` (0126: a roster row
 * is stamped `team` unless the platform writes it) and `connector_stamp_insert` (0127: an MCP server
 * or tool is stamped `team` unless the platform or the catalogue writes it).
 */
const TEAM_POLICY_NAME =
  /^(team_read|team_write_(select|insert|update|delete)|team_frame_refused_(select|insert|update|delete)|team_admin_read|.+_team_bot_.+|team_roster_stamp_insert|connector_stamp_insert)$/;

describe("the catalogue (I1–I4, I8)", () => {
  test("(d) every policy that names 'team' belongs to a known family", async () => {
    const rows = await catalogue<{ table: string; name: string }>(`
      select tablename as "table", policyname as "name"
      from pg_policies
      where coalesce(qual, '') ~ '''team''' or coalesce(with_check, '') ~ '''team'''
      order by 1, 2
    `);
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows
        .filter((row) => !TEAM_POLICY_NAME.test(row.name))
        .map((row) => `"${row.table}" ${row.name}`),
    ).toEqual([]);
  });

  test("(e) no person can be called system, platform or team", async () => {
    const [check] = await catalogue<{ table: string; definition: string }>(`
      select conrelid::regclass::text as "table", pg_get_constraintdef(oid) as "definition"
      from pg_constraint where conname = 'users_id_not_reserved'
    `);
    expect(check?.table).toBe("users");
    for (const reserved of ["'system'", "'platform'", "'team'"])
      expect(check?.definition).toContain(reserved);
  });

  test("(f) every openbot_team_* function pins its search_path and grants PUBLIC nothing", async () => {
    const functions = await catalogue<{
      name: string;
      definer: boolean;
      config: string[] | null;
      publicExecute: boolean;
      returns: string;
    }>(`
      select p.proname as "name", p.prosecdef as "definer", p.proconfig as "config",
             has_function_privilege('public', p.oid, 'EXECUTE') as "publicExecute",
             p.prorettype::regtype::text as "returns"
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and (p.proname like 'openbot\\_team\\_%' or p.proname like 'openbot\\_flow\\_share\\_%'
             -- 0206: the crew link's two functions sit beside the shared-group guard.
             or p.proname in ('openbot_waker_group_absent', 'openbot_channel_waker_group_link')
             -- 0207: the shared-group hand-over the app calls, under the new name.
             or p.proname = 'xiongbao_team_channel_hand_over')
      order by 1
    `);
    expect(functions.length).toBeGreaterThan(0);
    const problems = functions.flatMap((fn) => {
      const found: string[] = [];
      /*
       * The functions policies call answer a question the caller's own row security would hide
       * (who is a member, which Bot is visible, the one server secret), so they run as their owner.
       * The two trigger functions are not: a row guard compares OLD with NEW and reads only the
       * session's settings, so it needs no rights the writer lacks, and runs as the writer.
       */
      if (fn.returns !== "trigger" && !fn.definer)
        found.push(`${fn.name} is not SECURITY DEFINER`);
      const searchPath = (fn.config ?? []).find((setting) =>
        setting.startsWith("search_path="),
      );
      if (!searchPath || searchPath.includes("$user"))
        found.push(`${fn.name} does not pin its search_path`);
      if (fn.publicExecute) found.push(`${fn.name} is executable by PUBLIC`);
      return found;
    });
    expect(problems).toEqual([]);
    // The ones the policies and the secret broker depend on exist under these names.
    expect(functions.map((fn) => fn.name)).toEqual(
      expect.arrayContaining([
        "openbot_team_bot_visible",
        "openbot_team_channel_member",
        "openbot_team_channel_seedable",
        "openbot_team_row_guard",
        "openbot_team_server_secret",
        // WF9 (0141): what a share link may become in a frame that is not its owner's.
        "openbot_flow_share_guard",
        // 0206: whether a linked crew is gone (read past row security), and the link check.
        "openbot_waker_group_absent",
        "openbot_channel_waker_group_link",
        // 0207: the one hand-over function the app may call.
        "xiongbao_team_channel_hand_over",
      ]),
    );
    /*
     * 0206's link check reads the crew through the writer's own row security on purpose (a crew the
     * frame cannot see is not the owner's), so it must never become SECURITY DEFINER; the guard's
     * "is the crew gone" question must read past it, or a member could unlink a crew they cannot see.
     */
    const definer = (name: string) =>
      functions.find((fn) => fn.name === name)?.definer;
    expect(definer("openbot_channel_waker_group_link")).toBe(false);
    expect(definer("openbot_waker_group_absent")).toBe(true);
    /*
     * 0207's hand-over reads and moves rows no caller's frame reaches, so it runs as its owner, and the
     * app is the only role it is granted to. Its helpers keep the `openbot_team_` prefix, so the
     * checks above cover them by prefix.
     */
    expect(definer("xiongbao_team_channel_hand_over")).toBe(true);
    // Who the function's ACL grants EXECUTE to, besides its owner: PUBLIC shows up as grantee 0.
    const handOverGrants = await catalogue<{ role: string }>(`
      select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as "role"
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(p.proacl) a
      where n.nspname = 'public' and p.proname = 'xiongbao_team_channel_hand_over'
        and a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner
      order by 1
    `);
    expect(handOverGrants.map((row) => row.role)).toEqual(["openbot_app"]);
  });

  test("(f) the share link guard is a BEFORE UPDATE row trigger on flow_share_links, and only there", async () => {
    const triggers = await catalogue<{
      table: string;
      trigger: string;
      enabled: string;
      type: number;
    }>(`
      select c.relname as "table", t.tgname as "trigger", t.tgenabled as "enabled", t.tgtype as "type"
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc p on p.oid = t.tgfoid
      where p.proname = 'openbot_flow_share_guard' and not t.tgisinternal
    `);
    const BEFORE_UPDATE_ROW = 1 | 2 | 16;
    expect(
      triggers.map((row) => ({
        table: row.table,
        trigger: row.trigger,
        enabled: row.enabled,
        beforeUpdateRow:
          (Number(row.type) & BEFORE_UPDATE_ROW) === BEFORE_UPDATE_ROW,
      })),
    ).toEqual([
      {
        table: "flow_share_links",
        trigger: "openbot_flow_share_guard",
        enabled: "O",
        beforeUpdateRow: true,
      },
    ]);
  });

  test("(f) every table that shares team rows has the row guard, and every guard argument is a real column", async () => {
    const shared = (
      await catalogue<{ table: string }>(`
        select distinct tablename as "table" from pg_policies
        where policyname like 'team\\_%' and schemaname = 'public'
        order by 1
      `)
    ).map((row) => row.table);
    const triggers = await catalogue<{
      table: string;
      trigger: string;
      count: number;
      args: string;
      enabled: string;
      type: number;
    }>(`
      select c.relname as "table", t.tgname as "trigger", t.tgnargs as "count",
             encode(t.tgargs, 'escape') as "args", t.tgenabled as "enabled", t.tgtype as "type"
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc p on p.oid = t.tgfoid
      where p.proname like 'openbot\\_team\\_%' and not t.tgisinternal
    `);
    const columns = new Set(
      (
        await catalogue<{ table: string; column: string }>(`
          select table_name as "table", column_name as "column"
          from information_schema.columns where table_schema = 'public'
        `)
      ).map((row) => `${row.table}.${row.column}`),
    );

    expect(shared.length).toBeGreaterThan(0);
    // ROW (1) | BEFORE (2) | UPDATE (16): the stamp is frozen before the row is written.
    const BEFORE_UPDATE_ROW = 1 | 2 | 16;
    const unguarded = shared.filter(
      (table) =>
        !triggers.some(
          (row) =>
            row.table === table &&
            row.trigger === "openbot_team_row_guard" &&
            row.enabled === "O" &&
            (Number(row.type) & BEFORE_UPDATE_ROW) === BEFORE_UPDATE_ROW,
        ),
    );
    expect(unguarded).toEqual([]);

    const misspelled = triggers.flatMap((row) => {
      const args = row.args.split("\\000").filter((arg) => arg !== "");
      const problems = args
        .filter((arg) => !columns.has(`${row.table}.${arg}`))
        .map((arg) => `"${row.table}" ${row.trigger} names no column ${arg}`);
      if (args.length !== Number(row.count))
        problems.push(
          `"${row.table}" ${row.trigger} arguments were not all read`,
        );
      return problems;
    });
    expect(misspelled).toEqual([]);
  });
});
