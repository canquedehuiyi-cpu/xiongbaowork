import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { WakerFlowPlan } from "../../shared/wakerflows";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agents,
  flowRunEvents,
  flowShareImports,
  flowShareLinks,
  groupTaskRuns,
  groupTaskTemplates,
  tasks,
  users,
  wakerFlowRequests,
  wakerFlows,
  wakerGroups,
} from "../src/db/schema";
import { createPipelineStore } from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import {
  createWakerFlowRoutes,
  createWakerFlowShareRoutes,
} from "../src/wakerflows/routes";
import {
  FlowShareError,
  flowPackage,
  packageDigest,
  SHARE_DIGEST_MESSAGE,
  SHARE_EXHAUSTED_MESSAGE,
  SHARE_EXPIRED_MESSAGE,
  SHARE_FORMAT,
  SHARE_NESTED_MESSAGE,
  SHARE_REVOKED_MESSAGE,
} from "../src/wakerflows/sharing";
import { createWakerFlowStore } from "../src/wakerflows/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Story WF9, phase 3 (spec 2026-11-04-wf9-flow-sessions-sharing §5 WF9-3, §6.2): share links with an
 * expiry and a use limit, and importing a shared Flow into another workspace, against the real
 * database with row security forced and the share guard of migration 0141.
 *
 * Four registered people, each their own tenant, each with their own coworkers. A shares; B, C and D
 * import. Every statement under test runs in the acting person's own frame (`runAsTenant`): an
 * importer reaches A's link only through its token, never through `platform`. No model is called.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const [A, B, C, D] = ["a", "b", "c", "d"].map(
  (p) => `wf9share-${suite}-${p}`,
) as [string, string, string, string];
const people = [A, B, C, D];
const writerOf = (person: string) => `${person}-writer`;
const reviewerOf = (person: string) => `${person}-reviewer`;
const SOURCE_MODEL = randomUUID();
const SECRET_OUTPUT = `只在 A 的运行里出现的输出 ${suite}`;

const board = createTaskProjector(database);
const canUse = async (actor: string, agentId: string) =>
  agentId === writerOf(actor) || agentId === reviewerOf(actor);
const drives: Promise<unknown>[] = [];
const pipeline = createPipelineStore({
  database,
  board,
  canUse,
  executeStep: async () => ({ status: "done", output: SECRET_OUTPUT }),
});
const store = createWakerFlowStore({
  database,
  pipeline,
  board,
  canUse,
  drive: (run) => {
    drives.push(pipeline.advance(run));
  },
});

beforeAll(async () => {
  await runAsTenant("platform", () =>
    database
      .insert(users)
      .values(people.map((id) => ({ id, email: `${id}@wf9.test`, name: id }))),
  );
  for (const person of people)
    await runAsTenant(person, () =>
      database.insert(agents).values(
        [writerOf(person), reviewerOf(person)].map((id) => ({
          id,
          tenantId: person,
          name: id,
          type: "built_in" as const,
          configuration: {},
        })),
      ),
    );
});

afterAll(async () => {
  await Promise.allSettled(drives);
  for (const person of people)
    await runAsTenant(person, async () => {
      await database
        .delete(flowShareImports)
        .where(eq(flowShareImports.tenantId, person));
      await database
        .delete(flowShareLinks)
        .where(eq(flowShareLinks.tenantId, person));
      await database
        .delete(flowRunEvents)
        .where(eq(flowRunEvents.tenantId, person));
      await database.delete(tasks).where(eq(tasks.tenantId, person));
      await database
        .delete(groupTaskRuns)
        .where(eq(groupTaskRuns.tenantId, person));
      await database
        .delete(groupTaskTemplates)
        .where(eq(groupTaskTemplates.tenantId, person));
      await database
        .delete(wakerFlowRequests)
        .where(eq(wakerFlowRequests.tenantId, person));
      await database.delete(wakerFlows).where(eq(wakerFlows.tenantId, person));
      await database
        .delete(wakerGroups)
        .where(eq(wakerGroups.tenantId, person));
      await database.delete(agents).where(eq(agents.tenantId, person));
    });
  await runAsTenant("platform", () =>
    database.delete(users).where(inArray(users.id, people)),
  );
  await database.$client.close();
});

const actor =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", { id, email: `${id}@wf9.test`, role: "user" });
    await runAsTenant(id, () => next());
  };

async function call<T>(
  person: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const shares = path.startsWith("/api/wakerflow-shares/");
  const routes = shares
    ? createWakerFlowShareRoutes({ store, requireUser: actor(person) })
    : createWakerFlowRoutes({ store, requireUser: actor(person) });
  const local = shares
    ? path.slice("/api/wakerflow-shares".length)
    : path.slice("/api/wakerflows".length);
  const response = await routes.request(
    new Request(`http://openbot.test${local}`, {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as T,
  };
}

function planOf(person: string, name = "会议纪要"): WakerFlowPlan {
  return {
    name,
    description: "整理与复核",
    members: [
      { agentId: writerOf(person), role: "记录员", prompt: "你负责记录。" },
      { agentId: reviewerOf(person), role: "复核员" },
    ],
    inputs: [
      { key: "notes", label: "会议内容", required: true, type: "textarea" },
    ],
    steps: [
      {
        id: "draft",
        agentId: writerOf(person),
        instruction: "整理纪要",
        inputKeys: ["notes"],
        outputKey: "summary",
      },
      {
        id: "check",
        kind: "decision",
        inputKeys: ["summary"],
        branches: [
          { label: "太短", when: "size(summary) < 5", next: "review" },
        ],
        otherwise: "review",
      },
      {
        id: "review",
        agentId: reviewerOf(person),
        instruction: "复核纪要",
        inputKeys: ["summary"],
        outputKey: "result",
      },
    ],
  };
}

/** A's saved Flow, with a model and one finished run whose output must not travel. */
async function savedFlow(name = "会议纪要") {
  const created = await store.create(A, {
    idea: "整理会议",
    modelRef: SOURCE_MODEL,
  });
  const saved = await store.save(A, A, created.id, {
    revision: created.revision,
    plan: planOf(A, name),
  });
  return saved;
}

type Created = {
  share: { id: string; uses: number; maxUses: number; status: string };
  token: string | null;
};

async function share(flowId: string, body: Record<string, unknown> = {}) {
  const made = await call<Created>(
    A,
    "POST",
    `/api/wakerflows/${flowId}/shares`,
    {
      id: randomUUID(),
      ...body,
    },
  );
  expect(made.status).toBe(201);
  expect(made.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return made.body as Created & { token: string };
}

const slotsFor = (person: string) => ({
  s1: writerOf(person),
  s2: reviewerOf(person),
});

const importAs = (
  person: string,
  token: string,
  requestId = randomUUID(),
  members: Record<string, string> = slotsFor(person),
) =>
  call<{ imported?: { flowId: string; name: string }; error?: string }>(
    person,
    "POST",
    `/api/wakerflow-shares/${token}/import`,
    { requestId, members },
  );

const linkRow = (id: string) =>
  runAsTenant(A, async () => {
    const [row] = await database
      .select({
        uses: flowShareLinks.uses,
        maxUses: flowShareLinks.maxUses,
        expiresAt: flowShareLinks.expiresAt,
        packageSnapshot: flowShareLinks.packageSnapshot,
        tokenHash: flowShareLinks.tokenHash,
      })
      .from(flowShareLinks)
      .where(eq(flowShareLinks.id, id));
    return row;
  });

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );
const reason = (error: unknown) =>
  String((error as { cause?: unknown } | null)?.cause ?? error);

describe("the database (migration 0141)", () => {
  test("both tables are FORCE row security with the platform scope and the own-Flow checks", async () => {
    const rows = await runAsTenant("platform", () =>
      database.execute<{
        relname: string;
        forced: boolean;
        platform: number;
        restrictive: number;
      }>(sql`
        select c.relname,
               c.relforcerowsecurity as forced,
               (select count(*)::int from pg_policies p
                 where p.tablename = c.relname and p.policyname like 'platform_scope_%') as platform,
               (select count(*)::int from pg_policies p
                 where p.tablename = c.relname and p.policyname like 'own_flow_%'
                   and p.permissive = 'RESTRICTIVE') as restrictive
          from pg_class c
         where c.relname in ('flow_share_links', 'flow_share_imports')
         order by c.relname`),
    );
    expect([...rows]).toEqual([
      {
        relname: "flow_share_imports",
        forced: true,
        platform: 4,
        restrictive: 2,
      },
      {
        relname: "flow_share_links",
        forced: true,
        platform: 4,
        restrictive: 1,
      },
    ]);
  });

  test("a link always has a use limit of at most 100 and an expiry at most 30 days out", async () => {
    const flow = await savedFlow();
    const insert = (extra: Record<string, unknown>) =>
      failure(
        runAsTenant(A, () =>
          database.insert(flowShareLinks).values({
            id: randomUUID(),
            tenantId: A,
            flowId: flow.id,
            tokenHash: packageDigest(randomUUID()),
            creationFingerprint: "x",
            packageSnapshot: { format: SHARE_FORMAT },
            digest: packageDigest({}),
            expiresAt: new Date(Date.now() + 86_400_000),
            maxUses: 10,
            ...extra,
          }),
        ),
      );
    expect(reason(await insert({ maxUses: null }))).toContain(
      "flow_share_limits_check",
    );
    expect(reason(await insert({ maxUses: 101 }))).toContain(
      "flow_share_limits_check",
    );
    expect(
      reason(
        await insert({ expiresAt: new Date(Date.now() + 31 * 86_400_000) }),
      ),
    ).toContain("flow_share_limits_check");
    expect(reason(await insert({ digest: "not-hex" }))).toContain(
      "flow_share_shape_check",
    );
    // Another person cannot make a link for A's Flow, even naming themselves as its owner.
    const stranger = await failure(
      runAsTenant(B, () =>
        database.insert(flowShareLinks).values({
          id: randomUUID(),
          tenantId: B,
          flowId: flow.id,
          tokenHash: packageDigest(randomUUID()),
          creationFingerprint: "x",
          packageSnapshot: { format: SHARE_FORMAT },
          digest: packageDigest({}),
          expiresAt: new Date(Date.now() + 86_400_000),
          maxUses: 10,
        }),
      ),
    );
    expect(reason(stranger)).toContain("row-level security");
  });

  test("with the token set, another person may only add one use: every other change is refused by the guard", async () => {
    const flow = await savedFlow();
    const link = await share(flow.id, { maxUses: 5 });
    const hash = (await linkRow(link.share.id))?.tokenHash as string;
    const asB = (statement: ReturnType<typeof sql>) =>
      failure(
        runAsTenant(B, () =>
          database.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('app.flow_share_token', ${hash}, true)`,
            );
            return tx.execute(statement);
          }),
        ),
      );
    const id = link.share.id;
    for (const statement of [
      sql`update flow_share_links set expires_at = now() + interval '20 days' where id = ${id}`,
      sql`update flow_share_links set uses = 0 where id = ${id}`,
      sql`update flow_share_links set uses = uses + 2 where id = ${id}`,
      sql`update flow_share_links set max_uses = 100 where id = ${id}`,
      sql`update flow_share_links set revoked_at = now() where id = ${id}`,
      sql`update flow_share_links set uses = uses + 1, package_snapshot = '{"format":"x"}'::jsonb where id = ${id}`,
    ])
      expect(reason(await asB(statement))).toContain(
        "a shared WakerFlow link only records one more use",
      );
    expect((await linkRow(id))?.uses).toBe(0);
    // The one change that is allowed.
    expect(
      await asB(
        sql`update flow_share_links set uses = uses + 1 where id = ${id}`,
      ),
    ).toBeNull();
    expect((await linkRow(id))?.uses).toBe(1);
    // Without the token B sees nothing and changes nothing.
    const blind = await runAsTenant(B, () =>
      database.execute(
        sql`update flow_share_links set uses = uses + 1 where id = ${id} returning id`,
      ),
    );
    expect([...blind]).toEqual([]);
    expect((await linkRow(id))?.uses).toBe(1);
    // The token's setting ends with its transaction.
    const after = await runAsTenant(B, () =>
      database.execute<{ token: string | null }>(
        sql`select current_setting('app.flow_share_token', true) as token`,
      ),
    );
    expect([...after][0]?.token ?? "").toBe("");
  });
});

describe("sharing and importing across workspaces", () => {
  test("a link with two uses imports into B and C, and D is told it is used up; A sees two uses", async () => {
    const flow = await savedFlow();
    const link = await share(flow.id, { maxUses: 2, expiresInDays: 3 });
    expect(link.share).toMatchObject({ uses: 0, maxUses: 2, status: "active" });

    const b = await importAs(B, link.token);
    const c = await importAs(C, link.token);
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
    expect(b.body.imported?.flowId).not.toBe(c.body.imported?.flowId);
    const d = await importAs(D, link.token);
    expect(d).toEqual({
      status: 409,
      body: { error: SHARE_EXHAUSTED_MESSAGE },
    });
    // D's refused import left nothing behind.
    expect(await store.list(D)).toEqual([]);

    const list = await call<{
      shares: {
        id: string;
        uses: number;
        remainingUses: number;
        status: string;
      }[];
    }>(A, "GET", `/api/wakerflows/${flow.id}/shares`);
    expect(list.body.shares).toEqual([
      expect.objectContaining({
        id: link.share.id,
        uses: 2,
        remainingUses: 0,
        status: "exhausted",
      }),
    ]);
    // The list never carries a token or its hash.
    const text = JSON.stringify(list.body);
    expect(text).not.toContain(link.token);
    expect(text).not.toContain(
      (await linkRow(link.share.id))?.tokenHash as string,
    );
    // B's and C's drafts are their own: A cannot see them.
    expect(
      await store.inspect(A, b.body.imported?.flowId as string),
    ).toBeNull();
  });

  test("the same import request answers with the same draft and spends nothing; another import under it is a 409", async () => {
    const flow = await savedFlow();
    const link = await share(flow.id, { maxUses: 3 });
    const requestId = randomUUID();
    const first = await importAs(B, link.token, requestId);
    const again = await importAs(B, link.token, requestId);
    expect(again).toEqual(first);
    expect((await linkRow(link.share.id))?.uses).toBe(1);
    expect(
      (await store.list(B)).filter((f) => f.id === first.body.imported?.flowId),
    ).toHaveLength(1);
    const other = await importAs(B, link.token, requestId, {
      s1: reviewerOf(B),
      s2: writerOf(B),
    });
    expect(other.status).toBe(409);
    expect((await linkRow(link.share.id))?.uses).toBe(1);
  });

  test("an expired or revoked link is refused for preview and import, and so are a deleted Flow's links", async () => {
    const flow = await savedFlow();
    const expiring = await share(flow.id);
    // Time passes for this link: as its owner, move it back so its expiry is behind the database clock.
    await runAsTenant(A, () =>
      database.execute(
        sql`update flow_share_links set created_at = now() - interval '8 days', expires_at = now() - interval '1 second' where id = ${expiring.share.id}`,
      ),
    );
    for (const answer of [
      await call(B, "GET", `/api/wakerflow-shares/${expiring.token}`),
      await importAs(B, expiring.token),
    ])
      expect(answer).toEqual({
        status: 410,
        body: { error: SHARE_EXPIRED_MESSAGE },
      });

    const revoked = await share(flow.id);
    const revoke = await call<{ share: { status: string } }>(
      A,
      "POST",
      `/api/wakerflows/${flow.id}/shares/${revoked.share.id}/revoke`,
    );
    expect(revoke.body.share.status).toBe("revoked");
    for (const answer of [
      await call(B, "GET", `/api/wakerflow-shares/${revoked.token}`),
      await importAs(B, revoked.token),
    ])
      expect(answer).toEqual({
        status: 410,
        body: { error: SHARE_REVOKED_MESSAGE },
      });
    expect((await linkRow(revoked.share.id))?.uses).toBe(0);

    const other = await savedFlow("另一个流程");
    const live = await share(other.id);
    expect(await store.remove(A, other.id)).toBe(true);
    expect((await importAs(C, live.token)).body).toEqual({
      error: SHARE_REVOKED_MESSAGE,
    });
  });

  test("the imported Flow is a draft of the importer's own coworkers, and the package holds none of A's ids, models or outputs", async () => {
    const flow = await savedFlow();
    // A runs the Flow once, so there is an output that must not travel.
    const started = await store.start(A, A, flow.id, {
      requestId: randomUUID(),
      revision: flow.revision,
      inputs: { notes: "周一例会" },
    });
    await Promise.all(drives);
    expect(started.runId).not.toBeNull();
    const finished = await store.run(A, flow.id, started.runId as string);
    expect(JSON.stringify(finished)).toContain(SECRET_OUTPUT);

    const link = await share(flow.id);
    const snapshot = (await linkRow(link.share.id))?.packageSnapshot as Record<
      string,
      unknown
    >;
    // Field by field: exactly the package's keys, slots without coworkers, steps naming slots.
    expect(Object.keys(snapshot).sort()).toEqual(
      ["description", "format", "inputs", "name", "slots", "steps"].sort(),
    );
    expect(snapshot.format).toBe(SHARE_FORMAT);
    expect(snapshot.slots).toEqual([
      { slot: "s1", role: "记录员", prompt: "你负责记录。" },
      { slot: "s2", role: "复核员" },
    ]);
    expect(snapshot.inputs).toEqual(planOf(A).inputs);
    for (const step of snapshot.steps as Record<string, unknown>[]) {
      expect(step).not.toHaveProperty("agentId");
      if (step.kind !== "decision")
        expect(["s1", "s2"]).toContain(step.slot as string);
    }
    expect(snapshot.steps).toEqual(
      flowPackage(planOf(A)).steps as unknown as Record<string, unknown>[],
    );
    const text = JSON.stringify(snapshot);
    for (const leaked of [
      writerOf(A),
      reviewerOf(A),
      A,
      SOURCE_MODEL,
      SECRET_OUTPUT,
      flow.id,
      flow.templateId as string,
      flow.groupId as string,
      started.runId as string,
    ])
      expect(text).not.toContain(leaked);
    expect(text).not.toContain("modelRef");

    // The preview is the package's own content and the link's limits, nothing of A's.
    const preview = await call<{ share: Record<string, unknown> }>(
      B,
      "GET",
      `/api/wakerflow-shares/${link.token}`,
    );
    expect(preview.status).toBe(200);
    expect(preview.body.share).toEqual({
      name: "会议纪要",
      description: "整理与复核",
      slots: snapshot.slots,
      inputCount: 1,
      stepCount: 3,
      expiresAt: expect.any(String),
      remainingUses: 10,
    });
    expect(JSON.stringify(preview.body)).not.toContain(A);

    // B may only fill a slot with B's own coworker.
    const borrowed = await importAs(B, link.token, randomUUID(), {
      s1: writerOf(A),
      s2: reviewerOf(B),
    });
    expect(borrowed.status).toBe(400);
    const missing = await importAs(B, link.token, randomUUID(), {
      s1: writerOf(B),
    });
    expect(missing).toEqual({
      status: 400,
      body: { error: "请为每个角色选择一位员工。" },
    });
    expect((await linkRow(link.share.id))?.uses).toBe(0);

    const imported = await importAs(B, link.token);
    const draft = await store.inspect(
      B,
      imported.body.imported?.flowId as string,
    );
    expect(draft).toMatchObject({
      status: "draft",
      templateId: null,
      groupId: null,
      modelRef: null,
      name: "会议纪要",
    });
    expect(draft?.plan?.members).toEqual([
      { agentId: writerOf(B), role: "记录员", prompt: "你负责记录。" },
      { agentId: reviewerOf(B), role: "复核员" },
    ]);
    expect(
      draft?.plan?.steps.map((step) =>
        "agentId" in step ? step.agentId : step.kind,
      ),
    ).toEqual([writerOf(B), "decision", reviewerOf(B)]);
    expect(JSON.stringify(draft)).not.toContain(writerOf(A));
    // A person checks it and saves it: the plan is valid for B, and only then runnable.
    const saved = await store.save(B, B, draft?.id as string, {
      revision: draft?.revision as number,
      plan: draft?.plan as WakerFlowPlan,
    });
    expect(saved.status).toBe("ready");
  });

  test("a Flow with a nested Flow step cannot be shared, and a package whose digest no longer matches cannot be imported", async () => {
    const child = await savedFlow("子流程");
    const parentDraft = await store.create(A, { idea: "嵌套" });
    const parent = await store.save(A, A, parentDraft.id, {
      revision: parentDraft.revision,
      plan: {
        name: "父流程",
        description: "",
        members: [{ agentId: writerOf(A), role: "记录员" }],
        inputs: [{ key: "notes", label: "会议内容", required: true }],
        steps: [
          {
            id: "nest",
            kind: "flow",
            targetFlowId: child.id,
            targetRevision: child.revision,
            inputMap: { notes: "notes" },
            outputKey: "child_result",
          },
          {
            id: "finish",
            agentId: writerOf(A),
            instruction: "收尾",
            inputKeys: ["child_result"],
            outputKey: "done",
          },
        ],
      },
    });
    const nested = await call<{ error: string }>(
      A,
      "POST",
      `/api/wakerflows/${parent.id}/shares`,
      { id: randomUUID() },
    );
    expect(nested).toEqual({
      status: 400,
      body: { error: SHARE_NESTED_MESSAGE },
    });
    expect(await store.sharing.list(A, parent.id)).toEqual([]);

    const link = await share(child.id);
    // The package is changed after the link was made (as only its owner's frame could).
    await runAsTenant(A, () =>
      database.execute(
        sql`update flow_share_links set package_snapshot = jsonb_set(package_snapshot, '{name}', '"被改过的名称"') where id = ${link.share.id}`,
      ),
    );
    expect(await importAs(B, link.token)).toEqual({
      status: 409,
      body: { error: SHARE_DIGEST_MESSAGE },
    });
    expect(
      (await call(B, "GET", `/api/wakerflow-shares/${link.token}`)).status,
    ).toBe(409);
    expect((await linkRow(link.share.id))?.uses).toBe(0);
  });

  test("a preview spends nothing, an unknown token is a 404, and a draft cannot be shared", async () => {
    const flow = await savedFlow();
    const link = await share(flow.id);
    for (let index = 0; index < 3; index += 1)
      expect(
        (await call(C, "GET", `/api/wakerflow-shares/${link.token}`)).status,
      ).toBe(200);
    expect((await linkRow(link.share.id))?.uses).toBe(0);
    for (const token of [
      `${link.token.slice(0, -1)}${link.token.endsWith("A") ? "B" : "A"}`,
      "not-a-token",
      encodeURIComponent("'; drop table flow_share_links; --"),
    ]) {
      expect(await call(C, "GET", `/api/wakerflow-shares/${token}`)).toEqual({
        status: 404,
        body: { error: "这个分享链接不存在。" },
      });
      expect((await importAs(C, token)).status).toBe(404);
    }
    const draft = await store.create(A, { idea: "草稿" });
    const refused = await call<{ error: string }>(
      A,
      "POST",
      `/api/wakerflows/${draft.id}/shares`,
      { id: randomUUID() },
    );
    expect(refused).toEqual({
      status: 400,
      body: { error: "请先保存这个 WakerFlow，再分享。" },
    });
  });

  test("creating is idempotent on its id and the token is shown once; limits are bounded; another person reads A's links as not here", async () => {
    const flow = await savedFlow();
    const id = randomUUID();
    const first = await call<Created>(
      A,
      "POST",
      `/api/wakerflows/${flow.id}/shares`,
      { id },
    );
    const again = await call<Created>(
      A,
      "POST",
      `/api/wakerflows/${flow.id}/shares`,
      { id },
    );
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.token).toBeNull();
    expect(again.body.share).toEqual(first.body.share);
    // D4/D5 defaults: 7 days and 10 uses.
    const row = await linkRow(id);
    expect(row?.maxUses).toBe(10);
    if (!row) throw new Error("The link was not stored.");
    const days = (row.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    expect(
      (
        await call(A, "POST", `/api/wakerflows/${flow.id}/shares`, {
          id,
          maxUses: 3,
        })
      ).status,
    ).toBe(409);
    for (const body of [
      { expiresInDays: 31 },
      { expiresInDays: 0 },
      { maxUses: 101 },
      { maxUses: 0 },
      { maxUses: 1.5 },
    ])
      expect(
        (
          await call(A, "POST", `/api/wakerflows/${flow.id}/shares`, {
            id: randomUUID(),
            ...body,
          })
        ).status,
      ).toBe(400);
    // A link id another person already used is not this person's to read back.
    expect(
      (await call(B, "POST", `/api/wakerflows/${flow.id}/shares`, { id }))
        .status,
    ).toBe(404);
    for (const [method, path] of [
      ["GET", `/api/wakerflows/${flow.id}/shares`],
      ["POST", `/api/wakerflows/${flow.id}/shares/${id}/revoke`],
    ] as const)
      expect((await call(B, method, path)).status).toBe(404);
    expect((await store.sharing.list(A, flow.id))[0]?.status).toBe("active");
    const thrown = await failure(
      store.sharing.revoke(A, flow.id, randomUUID()),
    );
    expect(thrown).toBeInstanceOf(FlowShareError);
    expect((thrown as FlowShareError).status).toBe(404);
  });

  test("two importers racing for the last use: exactly one gets it", async () => {
    const flow = await savedFlow();
    const link = await share(flow.id, { maxUses: 1 });
    const answers = await Promise.all([
      importAs(B, link.token),
      importAs(C, link.token),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect((await linkRow(link.share.id))?.uses).toBe(1);
    // The loser's import record went with its transaction, so its request id is still free.
    const loser = answers.findIndex((answer) => answer.status === 409);
    const person = loser === 0 ? B : C;
    const records = await runAsTenant(person, () =>
      database
        .select({ flowId: flowShareImports.flowId })
        .from(flowShareImports)
        .where(eq(flowShareImports.tenantId, person)),
    );
    expect(records.every((record) => record.flowId !== null)).toBe(true);
  });
});
