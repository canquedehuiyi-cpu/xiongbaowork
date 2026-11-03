import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createAgentTrailReader } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Story D5: the employee detail page reads the Bot's recent audit trail.
 *
 * Asked of the real reader over the real table, as the NOBYPASSRLS application role, because the
 * three things the story turns on are all decided by the database: which rows name this agent, which
 * of them the viewer may see, and which tenant they belong to.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const reader = createAgentTrailReader(database);

const OWNER = "trail-owner";
const COLLEAGUE = "trail-colleague";

type Row = {
  eventType: string;
  targetType?: string;
  targetId?: string;
  actorUserId?: string;
  initiatorKind?: string;
  payload?: Record<string, unknown>;
};

/** Rows in one statement, the first newest, one second apart, inside the given tenant. */
function insertTrail(tenant: string, agentId: string, rows: Row[]) {
  return runAsTenant(tenant, () =>
    database
      .insert(auditEvents)
      .values(
        rows.map((row, index) => ({
          eventType: row.eventType,
          targetType: row.targetType ?? "agent",
          targetId: row.targetId ?? agentId,
          actorUserId: row.actorUserId ?? null,
          initiatorKind: row.initiatorKind ?? "person",
          payload: row.payload ?? {},
          createdAt: sql`now() - ${index}::int * interval '1 second'`,
        })),
      )
      .returning({ id: auditEvents.id, eventType: auditEvents.eventType }),
  );
}

async function walk(
  tenant: string,
  query: { agentId: string; viewerUserId: string; seesEveryone: boolean },
  limit: number,
) {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await runAsTenant(tenant, () =>
      reader.listAgentTrail({
        ...query,
        limit,
        ...(cursor ? { cursor } : {}),
      }),
    );
    seen.push(...result.events.map((event) => event.id));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return seen;
}

async function fixture() {
  const tenant = `tenant-trail-${crypto.randomUUID()}`;
  const agentId = `agent-trail-${crypto.randomUUID()}`;
  const rows = await insertTrail(tenant, agentId, [
    { eventType: "bot.updated", actorUserId: OWNER },
    { eventType: "bot.paused", actorUserId: COLLEAGUE },
    {
      eventType: "agent.handoff_offered",
      initiatorKind: "handoff",
      payload: { to: "agent-2" },
    },
    { eventType: "bot.paused", actorUserId: OWNER },
    { eventType: "bot.duplicated", actorUserId: COLLEAGUE },
    // Written past `recordAuditEvent`, so only the read-side redaction stands between it and a page.
    {
      eventType: "bot.updated",
      actorUserId: OWNER,
      payload: { token: "sk-should-not-leave", fields: ["endpoint"] },
    },
    // Same agent id, different target type: not this agent's trail.
    { eventType: "channel.created", targetType: "channel", actorUserId: OWNER },
    // Same target type, different agent.
    {
      eventType: "bot.updated",
      targetId: `other-${crypto.randomUUID()}`,
      actorUserId: OWNER,
    },
  ]);
  const [
    ownerUpdate,
    colleaguePause,
    handoff,
    ownerPause,
    colleagueDuplicate,
    secretUpdate,
  ] = rows.map((row) => row.id);
  return {
    tenant,
    agentId,
    ids: {
      ownerUpdate,
      colleaguePause,
      handoff,
      ownerPause,
      colleagueDuplicate,
      secretUpdate,
    },
  };
}

describe("an agent's audit trail", () => {
  test("the owner sees the agent's rows, newest first, but not a colleague's own lifecycle", async () => {
    const { tenant, agentId, ids } = await fixture();

    const seen = await walk(
      tenant,
      { agentId, viewerUserId: OWNER, seesEveryone: true },
      50,
    );

    expect(seen).toEqual([
      ids.ownerUpdate,
      ids.handoff,
      ids.ownerPause,
      ids.colleagueDuplicate,
      ids.secretUpdate,
    ]);
    expect(seen).not.toContain(ids.colleaguePause);
  });

  test("a colleague who is not the owner sees only what they did", async () => {
    const { tenant, agentId, ids } = await fixture();

    const seen = await walk(
      tenant,
      { agentId, viewerUserId: COLLEAGUE, seesEveryone: false },
      50,
    );

    expect(seen).toEqual([ids.colleaguePause, ids.colleagueDuplicate]);
  });

  test("a cursor walks every visible row exactly once", async () => {
    const { tenant, agentId, ids } = await fixture();

    const seen = await walk(
      tenant,
      { agentId, viewerUserId: OWNER, seesEveryone: true },
      2,
    );

    expect(seen).toEqual([
      ids.ownerUpdate,
      ids.handoff,
      ids.ownerPause,
      ids.colleagueDuplicate,
      ids.secretUpdate,
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("a payload is redacted on the way out", async () => {
    const { tenant, agentId, ids } = await fixture();

    const { events } = await runAsTenant(tenant, () =>
      reader.listAgentTrail({
        agentId,
        viewerUserId: OWNER,
        seesEveryone: true,
        limit: 50,
      }),
    );
    const secret = events.find((event) => event.id === ids.secretUpdate);

    expect(secret?.payload).toEqual({
      token: "[REDACTED]",
      fields: ["endpoint"],
    });
    expect(JSON.stringify(events)).not.toContain("sk-should-not-leave");
    // The documented shape only: no tenant bookkeeping columns.
    expect(Object.keys(secret ?? {}).sort()).toEqual([
      "actorUserId",
      "createdAt",
      "eventType",
      "id",
      "initiatorId",
      "initiatorKind",
      "payload",
      "targetId",
      "targetType",
    ]);
  });

  test("a colleague's rows are filed in their own tenant: the owner's frame never reads them, an administrator's platform read does", async () => {
    // G01-E: a row is filed in the frame of the person who caused it, so what a colleague did to a
    // shared Bot lives in the colleague's tenant, not the owner's.
    const agentId = `agent-trail-${crypto.randomUUID()}`;
    const ownerTenant = `tenant-trail-owner-${crypto.randomUUID()}`;
    const colleagueTenant = `tenant-trail-colleague-${crypto.randomUUID()}`;
    const [ownerUpdate] = await insertTrail(ownerTenant, agentId, [
      { eventType: "bot.updated", actorUserId: OWNER },
    ]);
    const [colleagueDuplicate, colleaguePause] = await insertTrail(
      colleagueTenant,
      agentId,
      [
        { eventType: "bot.duplicated", actorUserId: COLLEAGUE },
        { eventType: "bot.paused", actorUserId: COLLEAGUE },
      ],
    );

    const owner = await walk(
      ownerTenant,
      { agentId, viewerUserId: OWNER, seesEveryone: true },
      50,
    );
    expect(owner).toEqual([ownerUpdate?.id]);

    const colleague = await walk(
      colleagueTenant,
      { agentId, viewerUserId: COLLEAGUE, seesEveryone: false },
      50,
    );
    expect(colleague).toEqual([colleagueDuplicate?.id, colleaguePause?.id]);

    // The administrator's door (`asAdminPlatform` in agents/lifecycle-routes.ts) reads as
    // `platform`: every tenant's rows for this agent, still without anyone else's own lifecycle.
    const admin = await walk(
      "platform",
      { agentId, viewerUserId: "trail-admin", seesEveryone: true },
      50,
    );
    expect(new Set(admin)).toEqual(
      new Set([ownerUpdate?.id, colleagueDuplicate?.id]),
    );
    expect(admin).not.toContain(colleaguePause?.id);
  });

  test("another tenant's trail for the same agent id is invisible", async () => {
    const { agentId } = await fixture();
    const elsewhere = `tenant-trail-${crypto.randomUUID()}`;

    const { events, nextCursor } = await runAsTenant(elsewhere, () =>
      reader.listAgentTrail({
        agentId,
        viewerUserId: OWNER,
        seesEveryone: true,
        limit: 50,
      }),
    );

    expect(events).toEqual([]);
    expect(nextCursor).toBeUndefined();
  });
});
