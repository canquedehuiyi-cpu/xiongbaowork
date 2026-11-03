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
 * three doors are reachable by a member's or a signed-out request on purpose, each one narrow read:
 * `delivery/store.ts` (`registerDevice`'s platform lookup of who already holds a device token, plan
 * (d)) and `agents/profile-store.ts` (the callback route's `asPlatform` read of {id, tenantId} by
 * token hash, PCB), which both hand the work back to a person's frame; and `app.ts`'s
 * `/api/capabilities` count of identity providers, which signed-out requests reach too (P16a): it
 * reads deployment rows and only the count leaves.
 */
const SRC_DOORS: Record<string, Record<string, number>> = {
  "src/admin/controls.ts": { 'runAsTenant("platform"': 6 },
  "src/admin/routes.ts": { "asAdminPlatform(": 1, 'runAsTenant("platform"': 1 },
  "src/agents/bot-owner.ts": { "asPlatform(": 2 },
  "src/agents/handoff-runner.ts": { 'runAsTenant("platform"': 1 },
  "src/agents/profile-store.ts": { "asPlatform(": 1 },
  "src/agents/routes.ts": { "adminActAsOwner(": 1, "asAdminPlatform(": 3 },
  "src/agents/wake-up.ts": { 'runAsTenant("platform"': 2 },
  // The fourth is the signed-out /api/capabilities count of identity providers (deployment rows).
  "src/app.ts": {
    "adminActAsOwner(": 1,
    "asAdminPlatform(": 1,
    'runAsTenant("platform"': 4,
  },
  "src/audit-retention.ts": {
    'runAsTenant("platform"': 1,
    "set_config('app.tenant_id', 'platform'": 1,
  },
  "src/audit.ts": { 'runAsTenant("platform"': 1 },
  // The scheduler's `dueTriggers`: which triggers are due across every tenant (background sweep).
  "src/automations/store.ts": { 'runAsTenant("platform"': 1 },
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
  "src/delivery/opentag-agent.ts": { 'runAsTenant("platform"': 2 },
  "src/delivery/router.ts": { 'runAsTenant("platform"': 3 },
  "src/delivery/store.ts": { 'runAsTenant("platform"': 3 },
  "src/devices/store.ts": { 'runAsTenant("platform"': 4 },
  "src/index.ts": { 'runAsTenant("platform"': 2 },
  "src/memory/ingestion.ts": { 'runAsTenant("platform"': 2 },
  "src/pipeline/reap.ts": { 'runAsTenant("platform"': 1 },
  "src/pipeline/store.ts": { 'runAsTenant("platform"': 1 },
  "src/platform/store.ts": { 'runAsTenant("platform"': 3 },
  "src/plugins/logos.ts": { 'runAsTenant("platform"': 2 },
  "src/plugins/routes.ts": { "adminActAsOwner(": 1, "asAdminPlatform(": 1 },
  // Install listings (admin-only), and `removeServer`'s reach over every person's rows tied to one
  // team server (their tokens, brokered connections and grants for it), after `requireServerWriter`
  // has checked the admin capability (P21).
  "src/plugins/store.ts": { 'runAsTenant("platform"': 3 },
  "src/proactive/engine.ts": { 'runAsTenant("platform"': 2 },
  "src/quota/routes.ts": { 'runAsTenant("platform"': 1 },
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
  "src/tenant-package.ts": { 'runAsTenant("system"': 1 },
  "src/tenant/access.ts": { 'runAsTenant("platform"': 1 },
  // `asPlatform` itself.
  "src/tenant/context.ts": { 'runAsTenant("platform"': 1 },
  "src/wakerflows/recovery.ts": { 'runAsTenant("platform"': 3 },
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
      where n.nspname = 'public' and p.proname like 'openbot\\_team\\_%'
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
      ]),
    );
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
