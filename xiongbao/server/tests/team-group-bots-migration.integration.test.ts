import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The data statements of migration 0128, run against rows written the way P10 wrote them.
 *
 * 0128 moves a group from rows stamped with whoever wrote them to shared ones: it deletes the rows
 * stamped with one person that name another (squats, and pre-P11 invitations, which were written in
 * the inviter's frame), and moves the private part of every waiting or running Bot reply out of the
 * shared row into `group_message_private`, stamped with its sender. Nothing else in the suite runs
 * those statements on old-shaped data, and every deployment runs them exactly once.
 *
 * Read from the file rather than restated here, so the test proves what the migration does (the
 * pattern of the 0113 and backfill tests), and run inside a transaction that is rolled back: the
 * statements touch every row of their tables, and must leave the shared test database as it was.
 * The rows are written in the `platform` frame, the only one whose policies admit the old shapes;
 * the schema they are written into is the one 0128 leaves, which differs from the one it found only
 * by what these statements read from (the new private table) and by policies `platform` passes.
 */
const MIGRATION = await Bun.file(
  new URL(
    "../recovery/recovery-20261018-v1/sql/0128_team_group_bots.sql",
    import.meta.url,
  ),
).text();

const DATA_STATEMENTS = MIGRATION.split("--> statement-breakpoint").filter(
  (statement) =>
    /DELETE FROM public\.%1\$I/.test(statement) ||
    /^INSERT INTO public\.group_message_private\b/m.test(statement) ||
    /^UPDATE public\.group_messages m\b/m.test(statement),
);

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
afterAll(async () => {
  await database.$client.close();
});

/** Thrown to unwind the transaction, so the migration never touches the shared database's rows. */
class Rollback extends Error {}

const run = randomUUID();
const alice = `mig128-${run}-alice`;
const bob = `mig128-${run}-bob`;
const carol = `mig128-${run}-carol`;
const bot = `mig128-${run}-bot`;
const group = `mig128-${run}-group`;
const legacy = `mig128-${run}-legacy`;
const m = (name: string) => `mig128-${run}-${name}`;

type Seen = {
  memberships: [string, string, string][];
  mappings: [string, string, string][];
  threads: [string, string][];
  shared: Record<string, { text: string; details: unknown; tenantId: string }>;
  held: Record<string, { text: string; details: unknown; tenantId: string }>;
  heldForAlice: string[];
};

describe("migration 0128 on rows written before it", () => {
  test("its data statements are the three this test runs, in order", () => {
    expect(DATA_STATEMENTS).toHaveLength(3);
    expect(DATA_STATEMENTS[0]).toContain("DELETE FROM public.%1$I");
    expect(DATA_STATEMENTS[1]).toMatch(
      /^INSERT INTO public\.group_message_private\b/m,
    );
    expect(DATA_STATEMENTS[2]).toMatch(/^UPDATE public\.group_messages m\b/m);
  });

  test("drops cross-person rows, splits held replies off, and stamps every private part with its sender", async () => {
    let seen: Seen | undefined;
    try {
      await runAsTenant("platform", () =>
        database.transaction(async (tx) => {
          // P10's shapes: everything in the group's creator's frame, invitations included.
          await tx.execute(
            sql`insert into users (id, email) values (${alice}, ${`${alice}@x.test`}), (${bob}, ${`${bob}@x.test`}), (${carol}, ${`${carol}@x.test`})`,
          );
          await tx.execute(
            sql`insert into agents (id, name, type, configuration, tenant_id) values (${bot}, 'Bot', 'built_in', '{}', ${alice})`,
          );
          await tx.execute(
            sql`insert into channels (id, name, description, tenant_id, created_by) values (${group}, 'G', '', ${alice}, ${alice}), (${legacy}, 'Legacy', '', ${alice}, null)`,
          );
          await tx.execute(
            sql`insert into channel_memberships (channel_id, user_id, tenant_id) values (${group}, ${alice}, ${alice}), (${group}, ${bob}, ${alice}), (${legacy}, ${alice}, ${alice}), (${legacy}, ${carol}, ${alice})`,
          );
          await tx.execute(
            sql`insert into intelligence_channel_mappings (user_id, channel_id, thread_id, tenant_id) values (${alice}, ${group}, ${m("t-a1")}, ${alice}), (${bob}, ${group}, ${m("t-b1")}, ${alice}), (${alice}, ${legacy}, ${m("t-a0")}, ${alice}), (${carol}, ${legacy}, ${m("t-c0")}, ${alice})`,
          );
          await tx.execute(
            sql`insert into group_bot_threads (owner_user_id, channel_id, agent_id, thread_id, tenant_id) values (${alice}, ${group}, ${bot}, ${m("gt-1")}, ${alice}), (${bob}, ${group}, ${bot}, ${m("gt-2")}, ${alice})`,
          );
          const message = (
            id: string,
            agentId: string | null,
            text: string,
            status: string,
            details: unknown,
            tenantId: string,
            owner = alice,
          ) =>
            tx.execute(
              sql`insert into group_messages (id, channel_id, owner_user_id, agent_id, thread_id, text, status, details, tenant_id) values (${id}, ${group}, ${owner}, ${agentId}, ${agentId ? m("gt-1") : null}, ${text}, ${status}, ${JSON.stringify(details)}::text::jsonb, ${tenantId})`,
            );
          await message(
            m("m1"),
            null,
            "hello",
            "completed",
            { agentIds: [bot] },
            alice,
          );
          await message(
            `${m("m1")}:${bot}`,
            bot,
            "",
            "waiting",
            {
              kind: "approval",
              approvalId: m("ap1"),
              requestId: m("ap1"),
              message: "Waiting for permission",
              privateShare: {
                text: "secret held",
                continuation: { runId: "r" },
              },
              depth: 1,
              fromAgentId: "bot0",
            },
            alice,
          );
          await message(
            `${m("m2")}:${bot}`,
            bot,
            "partial secret",
            "running",
            {},
            alice,
          );
          // Waiting rows the unframed fallback and the platform frame stamped: still alice's waits.
          await message(
            `${m("m3")}:${bot}`,
            bot,
            "",
            "waiting",
            { approvalId: m("ap3"), message: "w" },
            "system",
          );
          await message(
            `${m("m4")}:${bot}`,
            bot,
            "",
            "waiting",
            { approvalId: m("ap4"), message: "w" },
            "platform",
          );
          await message(
            `${m("m5")}:${bot}`,
            bot,
            "done reply",
            "completed",
            { approvalId: "old", via: "x" },
            alice,
          );
          // A squat: stamped with alice, naming bob.
          await message(m("m6"), null, "squat", "completed", {}, alice, bob);

          for (const statement of DATA_STATEMENTS)
            await tx.execute(sql.raw(statement));

          const rows = async <T>(query: ReturnType<typeof sql>) =>
            Array.from((await tx.execute(query)) as unknown as ArrayLike<T>);
          const keyed = (
            list: {
              id: string;
              text: string;
              details: unknown;
              tenantId: string;
            }[],
          ) =>
            Object.fromEntries(
              list.map(({ id, ...rest }) => [
                id.replace(`mig128-${run}-`, ""),
                rest,
              ]),
            );
          const short = (value: string) => value.replace(`mig128-${run}-`, "");
          seen = {
            memberships: (
              await rows<{ c: string; u: string; t: string }>(
                sql`select channel_id as c, user_id as u, tenant_id as t from channel_memberships where channel_id in (${group}, ${legacy}) order by 1, 2`,
              )
            ).map((row) => [short(row.c), short(row.u), short(row.t)]),
            mappings: (
              await rows<{ c: string; u: string; t: string }>(
                sql`select channel_id as c, user_id as u, tenant_id as t from intelligence_channel_mappings where channel_id in (${group}, ${legacy}) order by 1, 2`,
              )
            ).map((row) => [short(row.c), short(row.u), short(row.t)]),
            threads: (
              await rows<{ u: string; t: string }>(
                sql`select owner_user_id as u, tenant_id as t from group_bot_threads where channel_id = ${group} order by 1`,
              )
            ).map((row) => [short(row.u), short(row.t)]),
            shared: keyed(
              await rows(
                sql`select id, text, details, tenant_id as "tenantId" from group_messages where channel_id = ${group}`,
              ),
            ),
            held: keyed(
              await rows(
                sql`select p.message_id as id, p.text, p.details, p.tenant_id as "tenantId" from group_message_private p join group_messages g on g.id = p.message_id where g.channel_id = ${group}`,
              ),
            ),
            heldForAlice: [],
          };
          // What the sender's own frame reads of the private rows: the wait `waitingFor` resumes.
          await tx.execute(
            sql`select set_config('app.tenant_id', ${alice}, true)`,
          );
          seen.heldForAlice = (
            await rows<{ id: string }>(
              sql`select message_id as id from group_message_private where message_id like ${`mig128-${run}-%`} order by 1`,
            )
          ).map((row) => short(row.id));
          throw new Rollback();
        }),
      );
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    const at = `:${bot}`;
    // Pre-P11 invitations are dropped: they named the invitee in the inviter's frame. The creator's
    // own rows stay.
    expect(seen?.memberships).toEqual([
      ["group", "alice", "alice"],
      ["legacy", "alice", "alice"],
    ]);
    expect(seen?.mappings).toEqual([
      ["group", "alice", "alice"],
      ["legacy", "alice", "alice"],
    ]);
    expect(seen?.threads).toEqual([["alice", "alice"]]);
    expect(seen?.shared).not.toHaveProperty("m6");

    // The shared rows keep only what every member may read.
    expect(seen?.shared).toEqual({
      m1: { text: "hello", details: { agentIds: [bot] }, tenantId: alice },
      [`m1${at}`]: {
        text: "",
        details: { message: "Waiting for permission" },
        tenantId: alice,
      },
      [`m2${at}`]: { text: "", details: {}, tenantId: alice },
      [`m3${at}`]: { text: "", details: { message: "w" }, tenantId: "system" },
      [`m4${at}`]: {
        text: "",
        details: { message: "w" },
        tenantId: "platform",
      },
      [`m5${at}`]: {
        text: "done reply",
        details: { approvalId: "old", via: "x" },
        tenantId: alice,
      },
    });
    // The private parts, every one stamped with the sender, whatever the shared row was stamped.
    expect(seen?.held).toEqual({
      [`m1${at}`]: {
        text: "",
        details: {
          kind: "approval",
          approvalId: m("ap1"),
          requestId: m("ap1"),
          privateShare: { text: "secret held", continuation: { runId: "r" } },
          depth: 1,
          fromAgentId: "bot0",
        },
        tenantId: alice,
      },
      [`m2${at}`]: { text: "partial secret", details: {}, tenantId: alice },
      [`m3${at}`]: {
        text: "",
        details: { approvalId: m("ap3") },
        tenantId: alice,
      },
      [`m4${at}`]: {
        text: "",
        details: { approvalId: m("ap4") },
        tenantId: alice,
      },
    });
    expect(seen?.heldForAlice).toEqual([
      `m1${at}`,
      `m2${at}`,
      `m3${at}`,
      `m4${at}`,
    ]);
  });
});
