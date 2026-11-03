import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { buildAgents } from "../src/copilot";
import {
  type AgentModelResolver,
  DEPLOYMENT_MODEL_REF,
  languageModelFor,
  modelOf,
} from "../src/models/runtime-resolver";
import type { ModelTokenCallRow } from "../src/models/token-metering";
import { runAsTenant } from "../src/tenant/context";

/**
 * Audit defect #11, the remainder: a coworker with no binding speaks the deployment's own model, and
 * that call was never metered. Bound models were wrapped by the resolver; the deployment model was
 * handed to the runtime as a `provider/model` string and built inside it, out of the meter's reach.
 *
 * Now the runtime is handed the deployment model already built, metered under the person whose run
 * it is: one `model_token_calls` row per call, `model_ref` and `credential_id` naming no library row
 * (`DEPLOYMENT_MODEL_REF`), the credential digest moving with the key and never carrying it.
 */

const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const reviewer = {
  id: "reviewer",
  name: "Reviewer",
  type: "built_in" as const,
  systemPrompt: "Review the code.",
};
const developer = {
  id: "developer",
  name: "Developer",
  type: "built_in" as const,
  systemPrompt: "Write the code.",
};
const model = { provider: "openai" as const, defaultModel: "gpt-5.6-terra" };
const DEPLOYMENT_KEY = "synthetic-deployment-key";

const build = (resolveAgentModel?: AgentModelResolver) =>
  buildAgents(
    [developer, reviewer],
    model,
    DEPLOYMENT_KEY,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    resolveAgentModel,
  );

function prepared(
  agents: Record<string, AbstractAgent>,
  id: string,
): AbstractAgent {
  const built = agents[id]?.clone();
  if (!built) throw new Error(`buildAgents returned no "${id}"`);
  built.addMessage({
    id: `${id}-metering-request`,
    role: "user",
    content: "Complete the fixture request.",
  });
  return built;
}

function capture() {
  const rows: ModelTokenCallRow[] = [];
  return { rows, sink: async (row: ModelTokenCallRow) => void rows.push(row) };
}

/** Runs `work` against a local recorder standing in for the provider; nothing leaves the process. */
async function withRecorder<T>(
  work: (recorder: LLMock, base: string) => Promise<T>,
): Promise<T> {
  const recorder = new LLMock();
  const originalBase = process.env.OPENAI_BASE_URL;
  try {
    const base = await recorder.start();
    process.env.OPENAI_BASE_URL = base;
    recorder.onMessage(/.*/, {
      type: "text",
      content: "METER001 fixture completed.",
    });
    return await work(recorder, base);
  } finally {
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBase;
    await recorder.stop();
  }
}

const requestedModels = (recorder: LLMock) =>
  recorder
    .getRequests()
    .map((entry) => (entry.body as { model?: string }).model);

/** The sink is fire-and-forget; give it a moment to be called. */
async function settled(rows: unknown[], count: number) {
  for (let i = 0; i < 50 && rows.length < count; i++) await Bun.sleep(10);
}

describe("the deployment default model is metered", () => {
  test("an unbound coworker's call on the deployment model leaves one row, for the person whose run it is", async () => {
    const { rows, sink } = capture();
    const person = "meter-default-person";
    await withRecorder(async (recorder) => {
      const agents = await runAsTenant(person, () =>
        build(modelOf(async () => null, sink)),
      );
      await runAsTenant(person, () => prepared(agents, reviewer.id).runAgent());
      // Still the deployment's model, dialled the way the runtime always dialled it.
      expect(requestedModels(recorder)).toEqual(["gpt-5.6-terra"]);
    });
    await settled(rows, 1);

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      tenantId: person,
      agentId: reviewer.id,
      modelRef: DEPLOYMENT_MODEL_REF,
      credentialId: DEPLOYMENT_MODEL_REF,
      provider: "openai",
      modelName: "gpt-5.6-terra",
      originalText: "openai/gpt-5.6-terra",
      outcome: "completed",
    });
    expect(row?.originalDigest).toBe(sha("openai/gpt-5.6-terra"));
    expect(row?.credentialDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.originalModelFingerprint).toMatch(/^[a-f0-9]{64}$/);
    // The key is never on the row, in any column.
    expect(JSON.stringify(row)).not.toContain(DEPLOYMENT_KEY);
  });

  test("the credential digest moves when the deployment key is rotated", async () => {
    const digests: string[] = [];
    for (const key of ["synthetic-key-one", "synthetic-key-two"]) {
      const { rows, sink } = capture();
      await withRecorder(async () => {
        const agents = await runAsTenant("meter-default-rotate", () =>
          buildAgents(
            [reviewer],
            model,
            key,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            modelOf(async () => null, sink),
          ),
        );
        await runAsTenant("meter-default-rotate", () =>
          prepared(agents, reviewer.id).runAgent(),
        );
      });
      await settled(rows, 1);
      expect(rows).toHaveLength(1);
      digests.push(String(rows[0]?.credentialDigest));
    }
    expect(digests[0]).not.toBe(digests[1]);
  });

  test("a bound coworker is metered by its binding alone, never a second time as the default", async () => {
    const { rows, sink } = capture();
    await withRecorder(async (recorder, base) => {
      // Unmetered on purpose: any row the sink sees could only come from the deployment wrapper.
      const bound = languageModelFor(
        "openai",
        base,
        "gpt-6",
        "synthetic-binding-key",
        // The recorder listens on loopback over http, which a tenant endpoint may only use where the
        // deployment opted into private hosts (audit defect #6).
        { allowPrivateHosts: true },
      );
      const agents = await runAsTenant("meter-default-bound", () =>
        build(
          modelOf(
            async (agentId) =>
              agentId === developer.id
                ? { model: bound, name: "openai/gpt-6" }
                : null,
            sink,
          ),
        ),
      );
      await runAsTenant("meter-default-bound", () =>
        prepared(agents, developer.id).runAgent(),
      );
      expect(requestedModels(recorder)).toEqual(["gpt-6"]);
    });
    await settled(rows, 1);
    expect(rows).toEqual([]);
  });

  test("the production sink writes the default-model row, and only its own person reads it", async () => {
    const { createDatabase } = await import("../src/db/client");
    const { modelTokenCalls } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const { databaseTokenCallSink } = await import(
      "../src/models/token-metering"
    );
    const { TEST_POOL, testDatabaseUrl } = await import("./support/database");
    const db = createDatabase(testDatabaseUrl(), TEST_POOL);
    const person = `meter-default-${crypto.randomUUID()}`;
    try {
      await withRecorder(async () => {
        const agents = await runAsTenant(person, () =>
          build(modelOf(async () => null, databaseTokenCallSink(db))),
        );
        await runAsTenant(person, () =>
          prepared(agents, reviewer.id).runAgent(),
        );
      });
      const read = (tenant: string) =>
        runAsTenant(tenant, () =>
          db
            .select()
            .from(modelTokenCalls)
            .where(eq(modelTokenCalls.agentId, reviewer.id)),
        ).then((rows) => rows.filter((row) => row.tenantId === person));
      let rows = await read(person);
      for (let i = 0; i < 50 && rows.length === 0; i++) {
        await Bun.sleep(20);
        rows = await read(person);
      }
      // Accepted by every CHECK on the table, under the person's own row security.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        modelRef: DEPLOYMENT_MODEL_REF,
        credentialId: DEPLOYMENT_MODEL_REF,
        originalText: "openai/gpt-5.6-terra",
        outcome: "completed",
      });
      expect(await read(`meter-default-${crypto.randomUUID()}`)).toEqual([]);
      await runAsTenant(person, () =>
        db.delete(modelTokenCalls).where(eq(modelTokenCalls.tenantId, person)),
      );
    } finally {
      await db.$client.close();
    }
  });

  test("outside a person's frame the run still answers, and nothing is written for nobody", async () => {
    const { rows, sink } = capture();
    await withRecorder(async (recorder) => {
      const agents = await runAsTenant("platform", () =>
        build(modelOf(async () => null, sink)),
      );
      await runAsTenant("platform", () =>
        prepared(agents, reviewer.id).runAgent(),
      );
      expect(requestedModels(recorder)).toEqual(["gpt-5.6-terra"]);
    });
    await settled(rows, 1);
    expect(rows).toEqual([]);
  });
});
