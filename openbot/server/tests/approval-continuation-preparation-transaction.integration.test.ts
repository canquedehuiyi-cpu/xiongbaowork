import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  type ContinuationProvision,
  type ContinuationStoreOptions,
  createContinuationStore,
} from "../src/approvals/continuation-store";
import { approvalAction } from "../src/approvals/types";
import { createDatabase, type Database } from "../src/db/client";
import { approvalContinuations as ledger, approvalRequests } from "../src/db/schema/approvals";
import { users } from "../src/db/schema/core";
import { runAsTenant } from "../src/tenant/context";

// SOURCE_ONLY: real PG17 definitions, zero executions. Import opens the existing
// DB module; this file is never a CPU-only import or an authorization artifact.
// No DDL, automatic migration, grants, fallback URL, provider or production DB.
const raw = process.env.TEST_DATABASE_URL;
if (!raw) throw new Error("BLOCKED_TEST_DATABASE_URL");
const url = new URL(raw);
const databaseName = decodeURIComponent(url.pathname.slice(1));
if (!/^postgres(?:ql)?:$/.test(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
    !/^openbot_continuation_test_[0-9a-f]{16}$/.test(databaseName) ||
    process.env.TEST_DATABASE_DISPOSABLE !== databaseName)
  throw new Error("BLOCKED_NOT_DISPOSABLE");
const database = createDatabase(raw, { max: 1 });
const tenant = `preparation-${randomUUID()}`;
const owner = `preparation-owner-${randomUUID()}`;
const originalName = "preparation transaction fixture";
const ids: string[] = [];
let initialized = false;
const scoped = <T>(body: () => T) => runAsTenant(tenant, body);
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const baseOptions: ContinuationStoreOptions = {
  leaseMs: 60_000,
  // Explicit test-only attestation, not native authority or permission to write P.
  authorizeCurrentProvisioning: async () => true,
  verifyNeverAdmittedProof: async () => false,
  verifyReceipt: async () => false,
};

beforeAll(async () => {
  const [identity] = await database.select({
    name: sql<string>`current_database()`,
    version: sql<number>`current_setting('server_version_num')::int`,
    parent: sql<string | null>`to_regclass('public.approval_requests')::text`,
    ledger: sql<string | null>`to_regclass('public.approval_continuations')::text`,
    fixturePrivilege: sql<boolean>`exists(select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls))`,
  }).from(sql`(select 1) as fixture_identity`);
  if (!identity || identity.name !== databaseName || identity.version < 170_000 ||
      identity.version >= 180_000 || !identity.parent || !identity.ledger ||
      !identity.fixturePrivilege)
    throw new Error("BLOCKED_PG17_CLOSED_SCHEMA_FIXTURE");
  // Closed ENABLE+FORCE/zero-policy ledger needs a separately provisioned test
  // role. This guard neither grants that role nor certifies production access.
  await scoped(() => database.insert(users).values({
    id: owner, email: `${owner}@fixture.invalid`, name: originalName,
  }));
  initialized = true;
});
afterAll(async () => {
  try {
    if (initialized) {
      if (ids.length) await scoped(() => database.delete(approvalRequests).where(inArray(approvalRequests.id, ids)));
      await scoped(() => database.delete(users).where(eq(users.id, owner)));
    }
  } finally {
    await database.$client.close();
  }
});

async function fixture(origin: ContinuationProvision["origin"] = "current") {
  const id = randomUUID();
  ids.push(id);
  const action = approvalAction({
    actorId: owner, botId: "fixture-bot", toolRef: "fixture/write", effect: "write",
    scope: "preparation-fixture", args: {}, target: {},
    continuation: {
      runId: `run-${id}`, threadId: `thread-${id}`, toolCallId: `call-${id}`,
      toolName: "fixture_write", args: {}, messages: [], state: {}, context: [], forwardedProps: {},
    },
  });
  await scoped(() => database.insert(approvalRequests).values({
    id, tenantId: tenant, ownerUserId: owner, runId: action.runId,
    toolCallId: action.toolCallId, actionDigest: action.actionDigest, action,
    status: "consumed", decision: "allow_once", result: { content: "saved result" },
  }));
  return {
    approvalId: id, ownerId: owner, tenantId: tenant, inputDigest: `digest-${id}`,
    admissionId: `admission-${id}`, branchKind: "thread", branchTargetId: `thread-${id}`, origin,
  } satisfies ContinuationProvision;
}

// Wrap a REAL transaction, never substitute fake query results or connections.
// before_resolve throws while the physical transaction callback is still active;
// after_ack throws only after the actual transaction has successfully resolved.
function instrument(phase: "normal" | "before_resolve" | "after_ack" = "normal") {
  const observation: { count: number; active?: Transaction; events: string[] } = {
    count: 0, events: [],
  };
  const wrapped = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return async <T>(fn: (tx: Transaction) => Promise<T>) => {
        observation.count++;
        observation.events.push("transaction");
        const value = await target.transaction(async (tx) => {
          observation.active = tx;
          const answer = await fn(tx);
          observation.events.push("callback_resolved");
          if (phase === "before_resolve") throw new Error("PREP_BEFORE_RESOLVE");
          return answer;
        });
        observation.events.push("commit_ack");
        if (phase === "after_ack") throw new Error("PREP_ACK_UNKNOWN");
        return value;
      };
    },
  });
  return { wrapped, observation };
}
async function rows(input: ContinuationProvision) {
  return scoped(() => database.select().from(ledger).where(eq(ledger.approvalId, input.approvalId)));
}
async function personName() {
  const [row] = await scoped(() => database.select({ name: users.name }).from(users).where(eq(users.id, owner)));
  return row?.name;
}
async function mark(tx: Transaction, name: string) {
  await tx.update(users).set({ name }).where(eq(users.id, owner));
}

// Old ensure must keep its original callback parameter identity and pre-tx order.
test("old ensure authorizes every current call, including matching existing, before the transaction", async () => {
  const input = await fixture();
  const { wrapped, observation } = instrument();
  let authorizations = 0;
  const store = createContinuationStore(wrapped, {
    ...baseOptions, authorizeCurrentProvisioning: async (received) => {
      expect(received).toBe(input);
      expect(observation.count).toBe(authorizations);
      observation.events.push("authorize");
      authorizations++;
      return true;
    },
  });
  const first = await store.ensure(input);
  expect(await store.ensure(input)).toEqual(first);
  expect(authorizations).toBe(2);
  expect(observation.count).toBe(2);
  expect(observation.events).toEqual([
    "authorize", "transaction", "callback_resolved", "commit_ack",
    "authorize", "transaction", "callback_resolved", "commit_ack",
  ]);
});

test("missing, false and throwing authorizers prevent both old and preparation transactions", async () => {
  const input = await fixture();
  const failure = new Error("AUTHORIZATION_FAILURE");
  const cases = [
    { authorization: undefined, error: "current_provenance_unverified" },
    { authorization: async () => false, error: "current_provenance_unverified" },
    { authorization: async () => { throw failure; }, error: failure },
  ];
  for (const item of cases) {
    const { wrapped, observation } = instrument();
    const store = createContinuationStore(wrapped, { ...baseOptions, authorizeCurrentProvisioning: item.authorization });
    let preparations = 0;
    for (const attempt of [() => store.ensure(input), () => store.ensureWithPreparation(input, async () => { preparations++; })]) {
      if (item.error === failure) await expect(attempt()).rejects.toBe(failure);
      else await expect(attempt()).rejects.toThrow("current_provenance_unverified");
    }
    expect(observation.count).toBe(0);
    expect(preparations).toBe(0);
  }
  expect(await rows(input)).toHaveLength(0);
});

test("old legacy creates unknown without authorization; new legacy rejects before every callback", async () => {
  const input = await fixture("legacy_unknown");
  const { wrapped, observation } = instrument();
  let authorization = 0, preparation = 0;
  const store = createContinuationStore(wrapped, { ...baseOptions, authorizeCurrentProvisioning: async () => { authorization++; return true; } });
  await expect(store.ensureWithPreparation(input, async () => { preparation++; })).rejects.toThrow("legacy_preparation_forbidden");
  expect(observation.count).toBe(0);
  expect(authorization).toBe(0);
  expect(preparation).toBe(0);
  expect((await store.ensure(input)).state).toBe("unknown");
  expect(observation.count).toBe(1);
  expect(authorization).toBe(0);
});

test("nonfunction preparation is rejected before authorization or transaction", async () => {
  const input = await fixture();
  const { wrapped, observation } = instrument();
  let authorization = 0;
  const store = createContinuationStore(wrapped, { ...baseOptions, authorizeCurrentProvisioning: async () => { authorization++; return true; } });
  // Reflect.apply exercises a malformed runtime invocation without weakening
  // the production type or inventing an any/unknown-cast callback.
  await expect(Reflect.apply(store.ensureWithPreparation, store, [input, null])).rejects.toThrow("invalid_preparation_callback");
  expect(observation.count).toBe(0);
  expect(authorization).toBe(0);
});

test("pool one: prepare runs once on the exact store-owned transaction before ledger insertion", async () => {
  const input = await fixture();
  const { wrapped, observation } = instrument();
  const store = createContinuationStore(wrapped, baseOptions);
  let preparation = 0;
  let preparedSession: { pid: number; xid: string } | undefined;
  const result = await store.ensureWithPreparation(input, async (tx) => {
    preparation++;
    expect(tx).toBe(observation.active);
    expect(observation.count).toBe(1);
    const absent = await tx.select().from(ledger).where(eq(ledger.approvalId, input.approvalId));
    expect(absent).toHaveLength(0);
    const [session] = await tx.select({
      pid: sql<number>`pg_backend_pid()`, xid: sql<string>`pg_current_xact_id()::text`,
      tenant: sql<string>`current_setting('app.tenant_id', true)`,
    }).from(users).where(eq(users.id, owner));
    expect(session?.tenant).toBe(tenant);
    if (!session || !Number.isInteger(session.pid) || !/^[0-9]+$/.test(session.xid)) throw new Error("missing real PG session");
    preparedSession = session;
    await mark(tx, `prepared-${input.approvalId}`);
    const [again] = await tx.select({ pid: sql<number>`pg_backend_pid()`, xid: sql<string>`pg_current_xact_id()::text` }).from(users).where(eq(users.id, owner));
    expect(again).toEqual(preparedSession && { pid: preparedSession.pid, xid: preparedSession.xid });
  });
  expect(result.state).toBe("ready");
  expect(preparation).toBe(1);
  expect(observation.count).toBe(1);
  expect(observation.events).toEqual(["transaction", "callback_resolved", "commit_ack"]);
  expect(await rows(input)).toHaveLength(1);
  expect(await personName()).toBe(`prepared-${input.approvalId}`);
});

test("matching existing returns without prepare, including an already completed parent", async () => {
  const input = await fixture();
  const store = createContinuationStore(database, baseOptions);
  const first = await store.ensure(input);
  await scoped(() => database.update(approvalRequests).set({ status: "completed" }).where(eq(approvalRequests.id, input.approvalId)));
  let preparation = 0;
  expect(await store.ensureWithPreparation(input, async () => { preparation++; })).toEqual(first);
  expect(preparation).toBe(0);
});

test("all immutable mismatches reject before preparation, without changing the existing ledger", async () => {
  const input = await fixture();
  const store = createContinuationStore(database, baseOptions);
  const first = await store.ensure(input);
  let preparation = 0;
  for (const key of ["admissionId", "branchKind", "branchTargetId", "inputDigest", "ownerId", "tenantId"] as const) {
    await expect(store.ensureWithPreparation({ ...input, [key]: "changed" }, async () => { preparation++; })).rejects.toThrow();
  }
  // Origin is the remaining immutable discriminator; the new path rejects
  // legacy earlier, and old ensure retains its immutable row comparison.
  await expect(store.ensure({ ...input, origin: "legacy_unknown" })).rejects.toThrow("immutable_provision_conflict");
  expect(preparation).toBe(0);
  expect(await store.read(input)).toEqual(first);
});

test("missing parent and each new-row status/result gate call prepare zero times", async () => {
  for (const gate of ["missing", "pending", "completed", "no_result"] as const) {
    const input = await fixture();
    if (gate === "missing") await scoped(() => database.delete(approvalRequests).where(eq(approvalRequests.id, input.approvalId)));
    else if (gate === "no_result") await scoped(() => database.update(approvalRequests).set({ result: null }).where(eq(approvalRequests.id, input.approvalId)));
    else await scoped(() => database.update(approvalRequests).set({ status: gate }).where(eq(approvalRequests.id, input.approvalId)));
    const store = createContinuationStore(database, baseOptions);
    let preparation = 0;
    await expect(store.ensureWithPreparation(input, async () => { preparation++; })).rejects.toThrow(gate === "missing" ? "approval_not_in_scope" : "action_result_not_ready");
    expect(preparation).toBe(0);
    expect(await rows(input)).toHaveLength(0);
  }
});

test("prepare rejection rolls back its real DB writes and never inserts ledger or retries", async () => {
  const input = await fixture();
  const before = await personName();
  const { wrapped, observation } = instrument();
  const store = createContinuationStore(wrapped, baseOptions);
  const failure = new Error("PREPARATION_REJECTED");
  let preparation = 0;
  await expect(store.ensureWithPreparation(input, async (tx) => {
    preparation++;
    await mark(tx, "must roll back prepare");
    throw failure;
  })).rejects.toBe(failure);
  expect(observation.count).toBe(1);
  expect(preparation).toBe(1);
  expect(await rows(input)).toHaveLength(0);
  expect(await personName()).toBe(before);
});

test("error inside the store transaction before resolve rolls back prepare and inserted ledger", async () => {
  const input = await fixture();
  const before = await personName();
  const { wrapped, observation } = instrument("before_resolve");
  let preparation = 0;
  await expect(createContinuationStore(wrapped, baseOptions).ensureWithPreparation(input, async (tx) => {
    preparation++;
    await mark(tx, "must roll back transaction");
  })).rejects.toThrow("PREP_BEFORE_RESOLVE");
  expect(observation.events).toEqual(["transaction", "callback_resolved"]);
  expect(preparation).toBe(1);
  expect(observation.count).toBe(1);
  expect(await rows(input)).toHaveLength(0);
  expect(await personName()).toBe(before);
});

test("commit acknowledgment loss propagates, same-identity reread finds writes, no automatic prepare replay", async () => {
  const input = await fixture();
  const { wrapped, observation } = instrument("after_ack");
  let preparation = 0;
  await expect(createContinuationStore(wrapped, baseOptions).ensureWithPreparation(input, async (tx) => {
    preparation++;
    await mark(tx, `committed-${input.approvalId}`);
  })).rejects.toThrow("PREP_ACK_UNKNOWN");
  expect(observation.count).toBe(1);
  expect(preparation).toBe(1);
  expect(await rows(input)).toHaveLength(1);
  expect(await personName()).toBe(`committed-${input.approvalId}`);
  const authoritative = createContinuationStore(database, baseOptions);
  expect((await authoritative.read(input))?.state).toBe("ready");
  await authoritative.ensureWithPreparation(input, async () => { preparation++; });
  expect(preparation).toBe(1);
});

test("caller throw after successful ensure resolve is after COMMIT ACK and cannot roll back", async () => {
  const input = await fixture();
  const { wrapped, observation } = instrument();
  let preparation = 0;
  await expect((async () => {
    await createContinuationStore(wrapped, baseOptions).ensureWithPreparation(input, async (tx) => {
      preparation++;
      await mark(tx, `after-ack-${input.approvalId}`);
    });
    throw new Error("CALLER_AFTER_COMMIT_ACK");
  })()).rejects.toThrow("CALLER_AFTER_COMMIT_ACK");
  expect(observation.events.at(-1)).toBe("commit_ack");
  expect(preparation).toBe(1);
  expect(observation.count).toBe(1);
  expect(await rows(input)).toHaveLength(1);
  expect(await personName()).toBe(`after-ack-${input.approvalId}`);
});

test("own frozen eight-field snapshot survives caller mutation while authorizer awaits", async () => {
  const input = await fixture();
  const original = { ...input };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { wrapped, observation } = instrument();
  let received: ContinuationProvision | undefined;
  let preparation = 0;
  const store = createContinuationStore(wrapped, {
    ...baseOptions,
    authorizeCurrentProvisioning: async (snapshot) => {
      received = snapshot;
      expect(snapshot).not.toBe(input);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.keys(snapshot).sort()).toEqual([
        "approvalId", "ownerId", "tenantId", "inputDigest", "admissionId", "branchKind", "branchTargetId", "origin",
      ].sort());
      entered.resolve();
      await release.promise;
      expect(snapshot).toEqual(original);
      return true;
    },
  });
  const pending = store.ensureWithPreparation(input, async (tx) => {
    preparation++;
    expect(tx).toBe(observation.active);
  }).then(
    (value) => ({ kind: "resolved" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  // Bound callback entry without increasing the test timeout; always release.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([entered.promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("authorizer entry deadline")), 1000);
    })]);
    expect(observation.count).toBe(0);
    input.approvalId = randomUUID();
    input.ownerId = "changed-owner";
    input.tenantId = "changed-tenant";
    input.inputDigest = "changed-digest";
    input.admissionId = "changed-admission";
    input.branchKind = "changed-kind";
    input.branchTargetId = "changed-target";
    input.origin = "legacy_unknown";
  } finally {
    clearTimeout(timer);
    release.resolve();
    await pending;
  }
  const outcome = await pending;
  if (outcome.kind === "rejected") throw outcome.error;
  const result = outcome.value;
  expect(received).toEqual(original);
  expect(result.approvalId).toBe(original.approvalId);
  expect(result.admissionId).toBe(original.admissionId);
  expect(preparation).toBe(1);
  expect(observation.count).toBe(1);
  expect(await rows(original)).toHaveLength(1);
  expect(await rows(input)).toHaveLength(0);
});


test("old seven-field preflight remains before authorizer and transaction", async () => {
  const input = await fixture();
  const { wrapped, observation } = instrument();
  let authorization = 0, preparation = 0;
  const store = createContinuationStore(wrapped, {
    ...baseOptions, authorizeCurrentProvisioning: async () => { authorization++; return true; },
  });
  for (const key of ["approvalId", "ownerId", "tenantId", "inputDigest", "admissionId", "branchKind", "branchTargetId"] as const) {
    const invalid = { ...input, [key]: " " };
    await expect(store.ensure(invalid)).rejects.toThrow("invalid_identity");
    await expect(store.ensureWithPreparation(invalid, async () => { preparation++; })).rejects.toThrow("invalid_identity");
  }
  expect(authorization).toBe(0);
  expect(preparation).toBe(0);
  expect(observation.count).toBe(0);
});

test("post-prepare insert conflict rereads the full immutable identity and rolls back without replay", async () => {
  const input = await fixture();
  const before = await personName();
  const { wrapped, observation } = instrument();
  let preparation = 0;
  await expect(createContinuationStore(wrapped, baseOptions).ensureWithPreparation(input, async (tx) => {
    preparation++;
    await mark(tx, "conflicting preparation must roll back");
    // Deliberate same-transaction DB fault injection, not a permitted producer.
    await tx.insert(ledger).values({
      approvalId: input.approvalId, tenantId: input.tenantId, ownerId: input.ownerId,
      inputDigest: input.inputDigest, admissionId: `conflicting-${input.admissionId}`,
      branchKind: input.branchKind, branchTargetId: input.branchTargetId,
      origin: "current", state: "ready",
    });
  })).rejects.toThrow("immutable_provision_conflict");
  expect(preparation).toBe(1);
  expect(observation.count).toBe(1);
  expect(await rows(input)).toHaveLength(0);
  expect(await personName()).toBe(before);
});
