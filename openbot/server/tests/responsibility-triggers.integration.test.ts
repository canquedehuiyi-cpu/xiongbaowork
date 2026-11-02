/**
 * Real PostgreSQL: trigger registration, secret rotation in the vault, owner scoping, the store's
 * trigger-targeted matching, per-trigger delivery dedup and paused-never-runs, end to end through
 * the public ingress route. Needs a database with `responsibility_triggers` (parity_dev today).
 *
 * TENANT FRAMES (G01-C). Everything a person does here — creating, pausing, rotating — runs in that
 * person's frame, as the guarded routes run it. The public ingresses (webhook, email, the legacy
 * GitHub binding) are called with NO frame, as a vendor calls them, and must write every row they
 * produce in the tenant stamped on the trigger or binding row: never `system`, and never whatever a
 * payload claims.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, auditEvents, credentials, users } from "../src/db/schema/core";
import {
  responsibilityEvents,
  responsibilityRuns,
  responsibilitySourceBindings,
  responsibilityTriggers,
} from "../src/db/schema/responsibilities";
import { workItems } from "../src/db/schema/work";
import { createResponsibilityBindingStore } from "../src/responsibilities/bindings";
import { createEmailTriggerRoutes } from "../src/responsibilities/email";
import { createGithubResponsibilityRoutes } from "../src/responsibilities/github";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { createTriggerIngressRoutes } from "../src/responsibilities/trigger-routes";
import { createTriggerStore } from "../src/responsibilities/triggers";
import { ResponsibilityNotFoundError } from "../src/responsibilities/types";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `triggers-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const strangerId = `${prefix}-stranger`;
const botId = `${prefix}-bot`;
const channelId = `${prefix}-channel`;
const credentialStore = createCredentialStore(database);
const vault = {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
};
const triggers = createTriggerStore(database, vault);
const bindings = createResponsibilityBindingStore(database, vault);
const asOwner = <T>(work: () => Promise<T>) => runAsTenant(ownerId, work);
const asStranger = <T>(work: () => Promise<T>) => runAsTenant(strangerId, work);
const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);
const store = createResponsibilityStore(database, {
  resolveTarget: async (owner, bot, channel) =>
    owner === ownerId && bot === botId && channel === channelId
      ? { threadId: `${prefix}-thread` }
      : null,
});
const auditStore = createAuditStore(database);
const routes = createTriggerIngressRoutes({
  directory: triggers.directory,
  ingest: (event) => store.ingestEvent(event),
  auditStore,
});
const runIds: string[] = [];

beforeAll(async () => {
  // People are not tenant rows. The built-in Bot is deliberately the deployment's (`system`), as a
  // catalogue Bot is, so every person's responsibility can name it.
  await asPlatform(() =>
    database.insert(users).values([
      { id: ownerId, email: `${ownerId}@example.test` },
      { id: strangerId, email: `${strangerId}@example.test` },
    ]),
  );
  await runAsTenant("system", () =>
    database.insert(agents).values({
      id: botId,
      name: "Trigger test Bot",
      type: "built_in",
      configuration: {},
    }),
  );
});
afterAll(async () => {
  if (runIds.length)
    await asPlatform(() =>
      database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, "responsibility.run"),
            inArray(workItems.key, runIds),
          ),
        ),
    );
  await asPlatform(() =>
    database.delete(users).where(inArray(users.id, [ownerId, strangerId])),
  );
  await asPlatform(() => database.delete(agents).where(eq(agents.id, botId)));
  /*
   * The connector secrets, which are what this file actually provisions: a trigger is a credential
   * plus a row pointing at it, and the store mints both, so no id here names them. Deleting them by
   * the owner recorded in their own metadata is the only handle that reaches exactly this run's rows.
   *
   * Leaving them behind is not untidy, it is load-bearing in the wrong way. When this file seeded
   * unframed they carried the `system` stamp, which row level security shows to EVERY tenant: that
   * is how `tests/quota.test.ts` came to read five orphaned model keys on a used database and none
   * on a fresh one. They are the owner's now (G01-C), and deleted as `platform`, which reaches them.
   */
  await asPlatform(() =>
    database
      .delete(credentials)
      .where(sql`${credentials.metadata}->>'ownerUserId' = ${ownerId}`),
  );
  await database.$client.close();
});

async function goal() {
  return asOwner(() =>
    store.create(ownerId, {
      agentId: botId,
      channelId,
      title: "Triage deploys",
      instruction: "Summarize the deploy.",
      successCriteria: "A summary is posted.",
    }),
  );
}
const post = (id: string, body: string, headers: Record<string, string>) =>
  routes.fetch(
    new Request(`https://openbot.test/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );

test("a generic webhook trigger queues exactly one run per idempotency key, and paused never runs", async () => {
  const responsibility = await goal();
  const created = await asOwner(() =>
    triggers.create(ownerId, responsibility.id, {
      config: { kind: "webhook", filter: { eventTypes: ["deploy"] } },
    }),
  );
  expect(created.secret).toMatch(/^whsec_/);
  const auth = {
    authorization: `Bearer ${created.secret}`,
    "idempotency-key": "k-1",
  };

  const first = await post(
    created.trigger.id,
    JSON.stringify({ type: "deploy.finished" }),
    auth,
  );
  expect(first.status).toBe(200);
  const accepted = (await first.json()) as {
    runIds: string[];
    duplicate: boolean;
  };
  expect(accepted.runIds).toHaveLength(1);
  runIds.push(...accepted.runIds);
  const again = (await (
    await post(
      created.trigger.id,
      JSON.stringify({ type: "deploy.finished" }),
      auth,
    )
  ).json()) as {
    runIds: string[];
    duplicate: boolean;
  };
  expect(again).toMatchObject({ duplicate: true, runIds: accepted.runIds });
  const runs = await asOwner(() =>
    database
      .select()
      .from(responsibilityRuns)
      .where(eq(responsibilityRuns.responsibilityId, responsibility.id)),
  );
  expect(runs).toHaveLength(1);
  expect(runs[0]?.status).toBe("queued");

  // A paused trigger acknowledges but never queues.
  await asOwner(() => triggers.setEnabled(ownerId, created.trigger.id, false));
  const pausedTrigger = await post(
    created.trigger.id,
    JSON.stringify({ type: "deploy.finished" }),
    { authorization: `Bearer ${created.secret}`, "idempotency-key": "k-p" },
  );
  expect(pausedTrigger.status).toBe(409);
  await asOwner(() => triggers.setEnabled(ownerId, created.trigger.id, true));
  expect(
    (await asOwner(() => triggers.listForAgent(ownerId, botId))).some(
      (trigger) => trigger.id === created.trigger.id && trigger.enabled,
    ),
  ).toBe(true);
  // Slack triggers are refused when no Slack access is wired.
  await expect(
    asOwner(() =>
      triggers.create(ownerId, responsibility.id, {
        config: { kind: "slack", teamId: "T1", mode: "message" },
      }),
    ),
  ).rejects.toThrow(/not connected/);

  await asOwner(() => store.transition(ownerId, responsibility.id, "paused"));
  const paused = await post(
    created.trigger.id,
    JSON.stringify({ type: "deploy.finished" }),
    {
      authorization: `Bearer ${created.secret}`,
      "idempotency-key": "k-2",
    },
  );
  expect(paused.status).toBe(409);
  // A run queued before the pause is skipped at dispatch, never run.
  expect(
    await asOwner(() => store.beginRun(accepted.runIds[0] ?? "")),
  ).toBeNull();
  const [skipped] = await asOwner(() =>
    database
      .select()
      .from(responsibilityRuns)
      .where(eq(responsibilityRuns.id, accepted.runIds[0] ?? "")),
  );
  expect(skipped?.status).toBe("skipped");
});

test("rotation revokes the old key in the vault; provider secrets are pasted and never echoed", async () => {
  const responsibility = await goal();
  const created = await asOwner(() =>
    triggers.create(ownerId, responsibility.id, {
      config: { kind: "webhook" },
    }),
  );
  const rotated = await asOwner(() =>
    triggers.setSecret(ownerId, created.trigger.id),
  );
  expect(rotated.secret).not.toBe(created.secret);
  expect(
    await asOwner(() => triggers.revealSecret(ownerId, created.trigger.id)),
  ).toBe(rotated.secret ?? "");
  expect(
    (
      await post(created.trigger.id, "{}", {
        authorization: `Bearer ${created.secret}`,
      })
    ).status,
  ).toBe(401);
  const live = await post(created.trigger.id, "{}", {
    authorization: `Bearer ${rotated.secret}`,
  });
  expect(live.status).toBe(200);
  runIds.push(...((await live.json()) as { runIds: string[] }).runIds);

  const linear = await asOwner(() =>
    triggers.create(ownerId, responsibility.id, {
      config: { kind: "linear" },
    }),
  );
  expect(linear.trigger.hasSecret).toBe(false);
  expect((await post(linear.trigger.id, "{}", {})).status).toBe(503);
  const pasted = await asOwner(() =>
    triggers.setSecret(ownerId, linear.trigger.id, "lin_wh_pasted"),
  );
  expect(pasted).toMatchObject({ secret: null, trigger: { hasSecret: true } });
  await expect(
    asOwner(() => triggers.revealSecret(ownerId, linear.trigger.id)),
  ).rejects.toThrow();
  const body = JSON.stringify({
    action: "create",
    type: "Issue",
    webhookTimestamp: Date.now(),
  });
  const delivered = await post(linear.trigger.id, body, {
    "linear-signature": createHmac("sha256", "lin_wh_pasted")
      .update(body)
      .digest("hex"),
    "linear-delivery": randomUUID(),
  });
  expect(delivered.status).toBe(200);
  runIds.push(...((await delivered.json()) as { runIds: string[] }).runIds);

  await asOwner(() => triggers.remove(ownerId, linear.trigger.id));
  const [revoked] = await asOwner(() =>
    database
      .select({ revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(eq(credentials.keyId, linear.trigger.id)),
  );
  expect(revoked?.revokedAt).toBeInstanceOf(Date);
});

test("another person can neither see, add to, nor name a trigger they do not own", async () => {
  const responsibility = await goal();
  const created = await asOwner(() =>
    triggers.create(ownerId, responsibility.id, {
      config: { kind: "webhook" },
    }),
  );
  await expect(
    asStranger(() => triggers.list(strangerId, responsibility.id)),
  ).rejects.toBeInstanceOf(ResponsibilityNotFoundError);
  await expect(
    asStranger(() =>
      triggers.create(strangerId, responsibility.id, {
        config: { kind: "webhook" },
      }),
    ),
  ).rejects.toBeInstanceOf(ResponsibilityNotFoundError);
  await expect(
    asStranger(() => triggers.revealSecret(strangerId, created.trigger.id)),
  ).rejects.toBeInstanceOf(ResponsibilityNotFoundError);
  // The store re-checks the trigger belongs to the owner and responsibility it claims.
  await expect(
    asStranger(() =>
      store.ingestEvent({
        ownerUserId: strangerId,
        responsibilityId: responsibility.id,
        triggerId: created.trigger.id,
        source: "webhook",
        externalId: "x",
        type: "received",
        payload: {},
      }),
    ),
  ).rejects.toBeInstanceOf(ResponsibilityNotFoundError);
});

/** The tenant stamp on every row one accepted delivery wrote, read as `platform`, which sees them all. */
async function stampsOf(eventId: string, runIdsOf: string[]) {
  return asPlatform(async () => {
    const [event] = await database
      .select({
        tenantId: responsibilityEvents.tenantId,
        ownerUserId: responsibilityEvents.ownerUserId,
      })
      .from(responsibilityEvents)
      .where(eq(responsibilityEvents.id, eventId));
    const runs = await database
      .select({ tenantId: responsibilityRuns.tenantId })
      .from(responsibilityRuns)
      .where(inArray(responsibilityRuns.id, runIdsOf));
    const queued = await database
      .select({ tenantId: workItems.tenantId })
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, "responsibility.run"),
          inArray(workItems.key, runIdsOf),
        ),
      );
    const audited = await database
      .select({ tenantId: auditEvents.tenantId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "responsibility.triggered"),
          sql`${auditEvents.payload}->>'eventId' = ${eventId}`,
        ),
      );
    return {
      event,
      runs: runs.map((row) => row.tenantId),
      queued: queued.map((row) => row.tenantId),
      audited: audited.map((row) => row.tenantId),
    };
  });
}

/** Restamp a trigger's row as an operator could, to stand for a legacy or tampered row. */
const stampTrigger = (id: string, tenantId: string) =>
  asPlatform(() =>
    database
      .update(responsibilityTriggers)
      .set({ tenantId })
      .where(eq(responsibilityTriggers.id, id)),
  );

test("an unframed webhook delivery writes its event, run, queue item and audit row in the trigger's tenant, never system, whatever the payload claims", async () => {
  const responsibility = await goal();
  const created = await asOwner(() =>
    triggers.create(ownerId, responsibility.id, {
      config: { kind: "webhook" },
    }),
  );
  const response = await post(
    created.trigger.id,
    // A payload that names somebody else, and a tenant, decides nothing.
    JSON.stringify({
      type: "deploy.finished",
      ownerUserId: strangerId,
      tenantId: strangerId,
    }),
    {
      authorization: `Bearer ${created.secret}`,
      "idempotency-key": "frame-1",
    },
  );
  expect(response.status).toBe(200);
  const accepted = (await response.json()) as {
    eventId: string;
    runIds: string[];
  };
  runIds.push(...accepted.runIds);
  expect(accepted.runIds).toHaveLength(1);
  expect(await stampsOf(accepted.eventId, accepted.runIds)).toEqual({
    event: { tenantId: ownerId, ownerUserId: ownerId },
    runs: [ownerId],
    queued: [ownerId],
    audited: [ownerId],
  });
  // And the owner, in their own frame, sees what was delivered for them.
  expect(
    await asOwner(() =>
      database
        .select({ id: responsibilityEvents.id })
        .from(responsibilityEvents)
        .where(eq(responsibilityEvents.id, accepted.eventId)),
    ),
  ).toHaveLength(1);
});

test("a webhook trigger whose row names nobody, or somebody other than its owner, is answered as unknown and writes nothing", async () => {
  const responsibility = await goal();
  const created = await asOwner(() =>
    triggers.create(ownerId, responsibility.id, {
      config: { kind: "webhook" },
    }),
  );
  const eventsBefore = () =>
    asPlatform(() =>
      database
        .select({ id: responsibilityEvents.id })
        .from(responsibilityEvents)
        .where(eq(responsibilityEvents.ownerUserId, ownerId)),
    ).then((rows) => rows.length);
  const before = await eventsBefore();
  for (const [index, stamp] of [
    "system",
    "platform",
    "",
    strangerId,
  ].entries()) {
    await stampTrigger(created.trigger.id, stamp);
    const refused = await post(
      created.trigger.id,
      JSON.stringify({ type: "deploy.finished" }),
      {
        authorization: `Bearer ${created.secret}`,
        "idempotency-key": `untrusted-${index}`,
      },
    );
    expect(refused.status).toBe(404);
  }
  expect(await eventsBefore()).toBe(before);
  // Restamped to its owner, the very same trigger delivers again.
  await stampTrigger(created.trigger.id, ownerId);
  const delivered = await post(
    created.trigger.id,
    JSON.stringify({ type: "deploy.finished" }),
    {
      authorization: `Bearer ${created.secret}`,
      "idempotency-key": "untrusted-restored",
    },
  );
  expect(delivered.status).toBe(200);
  runIds.push(...((await delivered.json()) as { runIds: string[] }).runIds);
});

test("an unframed inbound email is delivered in each addressed trigger's own tenant, and a trigger naming nobody is skipped", async () => {
  const responsibility = await goal();
  const owned = await asOwner(() =>
    triggers.create(ownerId, responsibility.id, { config: { kind: "email" } }),
  );
  const legacy = await asOwner(() =>
    triggers.create(ownerId, responsibility.id, { config: { kind: "email" } }),
  );
  await stampTrigger(legacy.trigger.id, "system");
  const domain = "in.openbot.test";
  const topic = "arn:aws:sns:us-east-1:000000000000:openbot-inbound";
  const email = createEmailTriggerRoutes({
    directory: triggers.directory,
    ingest: (event) => store.ingestEvent(event),
    auditStore,
    config: { domain, topicArns: [topic] },
    // The SNS signature is proven in responsibility-triggers.test.ts; here the question is frames.
    verify: async () => true,
    confirmSubscription: async () => undefined,
  });
  const messageId = `${prefix}-mail-${randomUUID()}`;
  const response = await email.fetch(
    new Request("https://openbot.test/sns", {
      method: "POST",
      body: JSON.stringify({
        Type: "Notification",
        MessageId: "m-1",
        TopicArn: topic,
        Timestamp: new Date().toISOString(),
        Message: JSON.stringify({
          notificationType: "Received",
          mail: {
            messageId,
            source: "alerts@example.test",
            commonHeaders: {
              from: ["alerts@example.test"],
              subject: "Disk",
            },
          },
          receipt: {
            recipients: [
              `trigger-${owned.trigger.id}@${domain}`,
              `trigger-${legacy.trigger.id}@${domain}`,
            ],
          },
          content: "Subject: Disk\r\n\r\nThe disk is full.",
        }),
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: true, deliveries: 1 });
  const events = await asPlatform(() =>
    database
      .select({
        id: responsibilityEvents.id,
        tenantId: responsibilityEvents.tenantId,
        externalId: responsibilityEvents.externalId,
      })
      .from(responsibilityEvents)
      .where(
        inArray(responsibilityEvents.externalId, [
          `${owned.trigger.id}:${messageId}`,
          `${legacy.trigger.id}:${messageId}`,
        ]),
      ),
  );
  expect(
    events.map(({ tenantId, externalId }) => ({ tenantId, externalId })),
  ).toEqual([
    { tenantId: ownerId, externalId: `${owned.trigger.id}:${messageId}` },
  ]);
  const runs = await asPlatform(() =>
    database
      .select({ id: responsibilityRuns.id })
      .from(responsibilityRuns)
      .where(eq(responsibilityRuns.eventId, events[0]?.id ?? "")),
  );
  runIds.push(...runs.map((run) => run.id));
  expect(
    await stampsOf(
      events[0]?.id ?? "",
      runs.map((run) => run.id),
    ),
  ).toMatchObject({
    runs: [ownerId],
    queued: [ownerId],
    audited: [ownerId],
  });
});

test("the legacy GitHub binding ingests in the binding's tenant, and a binding naming nobody is unknown", async () => {
  const repository = "openbot/frames";
  const secret = "fixture-only-github-binding-secret";
  const created = await asOwner(() =>
    bindings.create(ownerId, { repository, secret }),
  );
  const github = createGithubResponsibilityRoutes({
    bindingFor: bindings.githubBindingFor,
    ingest: (event) => store.ingestEvent(event),
  });
  const send = (body: string) =>
    github.fetch(
      new Request(`https://openbot.test/${created.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": randomUUID(),
          "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      }),
    );
  const stampBinding = (tenantId: string) =>
    asPlatform(() =>
      database
        .update(responsibilitySourceBindings)
        .set({ tenantId })
        .where(eq(responsibilitySourceBindings.id, created.id)),
    );
  try {
    const accepted = await send(
      JSON.stringify({
        action: "opened",
        ownerUserId: strangerId,
        tenantId: strangerId,
        repository: { full_name: repository },
      }),
    );
    expect(accepted.status).toBe(202);
    const result = (await accepted.json()) as {
      eventId: string;
      runIds: string[];
    };
    runIds.push(...result.runIds);
    expect((await stampsOf(result.eventId, result.runIds)).event).toEqual({
      tenantId: ownerId,
      ownerUserId: ownerId,
    });
    for (const [index, stamp] of [
      "system",
      "platform",
      "",
      strangerId,
    ].entries()) {
      await stampBinding(stamp);
      const refused = await send(
        JSON.stringify({
          action: `refused${index}`,
          repository: { full_name: repository },
        }),
      );
      expect(refused.status).toBe(404);
    }
  } finally {
    await stampBinding(ownerId);
    await asOwner(() => bindings.remove(ownerId, created.id));
  }
});

/*
 * Migration 0121 (G01-C): the legacy GitHub webhook now refuses a binding whose stamp is not its
 * owner, and 0115 did not restamp `responsibility_source_bindings`, so bindings registered before the
 * routes ran in the owner's frame would stop delivering. Their signing secrets (and those of triggers
 * 0115 restamped) stayed `system`, which the owner's frame cannot revoke or rotate. The file runs as this NOBYPASSRLS role from
 * the empty frame a migrator arrives with, inside a transaction that is rolled back.
 */
test("migration 0121 restamps GitHub source bindings of nobody's, and the secrets of bindings and triggers, to their owner, and only those", async () => {
  const migration = readFileSync(
    join(
      import.meta.dir,
      "..",
      "recovery",
      "recovery-20261018-v1",
      "sql",
      "0121_source_binding_owner_tenant.sql",
    ),
    "utf8",
  );
  const stamps = ["system", "platform", "", strangerId];
  const created = [];
  for (const [index] of stamps.entries())
    created.push(
      await asOwner(() =>
        bindings.create(ownerId, {
          repository: `openbot/restamp-${index}`,
          secret: "fixture-only-restamp-secret",
        }),
      ),
    );
  const ids = created.map((binding) => binding.id);
  // A legacy trigger whose row 0115 already gave its owner, but whose signing secret it left behind.
  const responsibility = await goal();
  const trigger = await asOwner(() =>
    triggers.create(ownerId, responsibility.id, {
      config: { kind: "webhook" },
    }),
  );
  const rollback = new Error("rollback the migration fixture");
  let seen:
    | {
        frame: unknown;
        rows: unknown[];
        secrets: unknown[];
        triggerSecret: unknown;
      }
    | undefined;
  try {
    await expect(
      database.$client.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', 'platform', true)`;
        for (const [index, stamp] of stamps.entries())
          await tx`update responsibility_source_bindings set tenant_id = ${stamp} where id = ${ids[index] ?? ""}`;
        // Every secret written unframed, as the legacy routes wrote them.
        for (const id of ids)
          await tx`update credentials set tenant_id = 'system' where id = (select credential_id from responsibility_source_bindings where id = ${id})`;
        await tx`update credentials set tenant_id = 'system' where id = (select credential_id from responsibility_triggers where id = ${trigger.trigger.id})`;
        await tx`select set_config('app.tenant_id', '', true)`;
        await tx.unsafe(migration);
        const [frame] =
          await tx`select current_setting('app.tenant_id', true) as tenant`;
        await tx`select set_config('app.tenant_id', 'platform', true)`;
        const rows =
          await tx`select id, tenant_id from responsibility_source_bindings where owner_user_id = ${ownerId}`;
        const byId = new Map(
          Array.from(rows as ArrayLike<{ id: string; tenant_id: string }>).map(
            (row) => [row.id, row.tenant_id],
          ),
        );
        const secretById = new Map<string, unknown>();
        for (const id of ids) {
          const [secret] =
            await tx`select credential.tenant_id from responsibility_source_bindings binding join credentials credential on credential.id = binding.credential_id where binding.id = ${id}`;
          secretById.set(
            id,
            (secret as { tenant_id: unknown } | undefined)?.tenant_id,
          );
        }
        const [triggerSecret] =
          await tx`select credential.tenant_id from responsibility_triggers t join credentials credential on credential.id = t.credential_id where t.id = ${trigger.trigger.id}`;
        seen = {
          frame: (frame as { tenant: unknown }).tenant,
          rows: ids.map((id) => byId.get(id)),
          secrets: ids.map((id) => secretById.get(id)),
          triggerSecret: (triggerSecret as { tenant_id: unknown } | undefined)
            ?.tenant_id,
        };
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(seen?.frame).toBe("");
    // Nobody's three ways go to their owner; a stamp naming another person is a conflict and stays.
    expect(seen?.rows).toEqual([ownerId, ownerId, ownerId, strangerId]);
    // Each secret follows its row to the owner, so the owner can revoke and rotate it; the
    // conflicting binding's secret is not moved.
    expect(seen?.secrets).toEqual([ownerId, ownerId, ownerId, "system"]);
    expect(seen?.triggerSecret).toBe(ownerId);
  } finally {
    for (const id of ids) await asOwner(() => bindings.remove(ownerId, id));
  }
});
