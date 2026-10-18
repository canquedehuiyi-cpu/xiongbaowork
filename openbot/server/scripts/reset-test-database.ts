/**
 * Put the integration-test database back to a clean slate (ticket 025).
 *
 * WHY THIS EXISTS. A full server suite leaves rows behind in every table it fills — credentials,
 * model registry entries, agents and their profiles among them. Those rows carry foreign keys, so the
 * next run's fixtures fail in `beforeAll` with a constraint violation that names a table nobody
 * touched, and the suite's failures stop meaning anything. This was done by hand twice during
 * development; a reset that has to be remembered is a reset that will be forgotten.
 *
 * WHY IT REFUSES. It truncates with `RESTART IDENTITY CASCADE`. Pointed at a real workspace's
 * database that is not a wipe of everything, so the target is checked against the test database's
 * name before a single statement runs, and the check is on the connection string the operator
 * actually passed rather than on an environment default.
 */

/**
 * The imports below are deliberately dynamic so nothing connects before the refusals run, which leaves
 * the file with no static import or export. TypeScript then reads it as a global script rather than a
 * module, and a global script may not use top-level `await`. This line is what makes it a module.
 */
export {};

const TARGET_DATABASE = "openbot_test";

/**
 * Every table the suite writes, in dependency order where it matters.
 *
 * `CASCADE` covers the rest, so this list is about naming what is deliberately emptied rather than
 * being exhaustive: a table nobody seeds is cleaned by its parent's cascade.
 */
const TABLES = [
  "mcp_servers",
  "mcp_user_credentials",
  "responsibility_source_bindings",
  "responsibility_triggers",
  "model_registry",
  "credentials",
  "agents",
  "agent_profiles",
  "agent_preferences",
  // Added after the first run proved the list incomplete. The board is where ticket 007 onward is
  // judged, so a "clean slate" that leaves last month's cards behind is not one — and the two crew
  // tables are unreachable by CASCADE from `agents`, because a membership names an agent id without
  // an foreign key to it.
  "tasks",
  "waker_group_members",
  "waker_groups",
];

const url = process.env.DATABASE_URL ?? "";

function databaseName(input: string): string {
  try {
    return new URL(input).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
}

const target = databaseName(url);
if (target !== TARGET_DATABASE) {
  console.error(
    `Refusing to reset: DATABASE_URL points at "${target || "nothing readable"}", and only "${TARGET_DATABASE}" is a test database.\n` +
      "Set DATABASE_URL to the test database explicitly if that is what you meant.",
  );
  process.exit(1);
}

/*
 * A name is not proof. A staging server with a database called `openbot_test` would sail through the
 * check above, and this script cannot tell it apart from a laptop — so wiping it is a deliberate act
 * with a deliberately awkward flag, not something that happens because a variable was left exported.
 */
if (process.env.CONFIRM_TEST_RESET !== "yes") {
  console.error(
    "Refusing to reset without CONFIRM_TEST_RESET=yes.\n" +
      `The database name alone does not prove it is disposable: this truncates ${TABLES.length} tables with CASCADE.\n` +
      "Re-run with CONFIRM_TEST_RESET=yes if you are certain this is your test database.",
  );
  process.exit(1);
}

const { createDatabase } = await import("../src/db/client");
const { sql } = await import("drizzle-orm");

const database = createDatabase(url);

/*
 * TRUNCATE is not a data privilege. The role the application runs as (`openbot_app`) is granted
 * select, insert, update and delete and nothing else, so a wipe through it fails with
 * `permission denied for table …` — an error that reads like a broken ACL rather than like the wrong
 * key. Said here instead, because the fix is a different connection string, not a grant.
 */
const [{ who }] = (await database.execute(
  sql.raw(`select current_user as who`),
)) as unknown as { who: string }[];
if (who === "openbot_app") {
  console.error(
    `Refusing to reset as "${who}": that role holds data privileges only, and TRUNCATE is not one of them.\n` +
      "Connect as the database owner (the URL drizzle-kit migrates with) and run it again.",
  );
  process.exit(1);
}

await database.execute(
  sql.raw(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`),
);
console.log(
  `reset ${TABLES.length} test tables (and their dependants) in ${target} as ${who}`,
);
