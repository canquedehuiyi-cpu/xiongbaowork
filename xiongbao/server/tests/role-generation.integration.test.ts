import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { LLMock } from "@copilotkit/aimock";
import { eq, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { PLATFORM_FLOW_MODEL_ID } from "../../shared/wakerflows";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import { createCredentialStore, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  credentials,
  modelRegistry,
  roleGenerationRequests,
  roleTemplates,
  users,
} from "../src/db/schema";
import { QuotaExceeded } from "../src/quota/limits";
import { createRoleGenerator } from "../src/roles/generator";
import { createRoleTemplateRoutes } from "../src/roles/routes";
import { createRoleTemplateStore } from "../src/roles/store";
import { runAsTenant } from "../src/tenant/context";
import { createFlowModelResolver } from "../src/wakerflows/model";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Story ROLE1, stage 3 (spec §3.5, §5 ROLE1-3): smart generation of a role profile, on the real
 * database under row-level security, through the real AI SDK, against a local mock provider only.
 *
 * What the provider received is `LLMock.getRequests()`. Every model row points at 127.0.0.1 and
 * OPENAI_BASE_URL is pointed at the mock while a test runs, so nothing can reach a real provider.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const encryptionKey = Buffer.alloc(32, 23).toString("base64");
const credentialStore = createCredentialStore(database);
const run = randomUUID().slice(0, 8);
const people: string[] = [];

afterAll(async () => {
  for (const id of people) {
    await runAsTenant(id, async () => {
      await database
        .delete(roleGenerationRequests)
        .where(eq(roleGenerationRequests.ownerUserId, id));
      await database
        .delete(modelRegistry)
        .where(eq(modelRegistry.tenantId, id));
      await database.delete(credentials).where(eq(credentials.tenantId, id));
    });
    await runAsTenant("platform", () =>
      database.delete(users).where(eq(users.id, id)),
    );
  }
  await database.$client.close();
});

const generated = {
  identity: { title: "后端工程师", roleDescription: "按需求写实现、跑测试。" },
  persona: {
    tone: "直接、简短。",
    principles: "先读现有代码再动手。",
    habits: "完成后说明跑过哪些检查。",
  },
  bible: "# 发布流程\n\n1. 打标签\n2. 等 CI",
};

async function person(label: string): Promise<AgentActor> {
  const id = `role1-gen-${run}-${label}-${randomUUID().slice(0, 6)}`;
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@role1.test`, name: label }),
  );
  people.push(id);
  return { id, role: "user" };
}

/** A model row in the person's library, keyed with a synthetic secret, served from `baseUrl`. */
async function connectModel(tenantId: string, baseUrl: string) {
  return runAsTenant(tenantId, async () => {
    const modelName = `role-${randomUUID().slice(0, 6)}`;
    const credential = await credentialStore.create({
      kind: "model",
      provider: "custom",
      keyId: `${tenantId}-${modelName}`,
      encryptedValue: await encryptSecret(encryptionKey, "synthetic-role-key"),
      metadata: {},
    });
    const [row] = await database
      .insert(modelRegistry)
      .values({
        tenantId,
        provider: "custom",
        baseUrl,
        modelName,
        credentialId: credential.id,
      })
      .returning({ id: modelRegistry.id });
    if (!row) throw new Error("Fixture model not inserted.");
    return row.id;
  });
}

function signedInAs(
  actor: AgentActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { ...actor, email: `${actor.id}@role1.test` });
    await runAsTenant(actor.id, () => next());
  };
}

function client(
  actor: AgentActor,
  options: { quotaFull?: boolean; quotaAsked?: string[] } = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/role-templates",
    createRoleTemplateRoutes(
      createRoleTemplateStore({
        database,
        profiles: createAgentProfileStore(database, undefined),
        models: createFlowModelResolver({
          database,
          encryptionKey,
          // The mock listens on 127.0.0.1 over plain http: the development private-host opt-in.
          outbound: { allowPrivateHosts: true },
        }),
        generator: createRoleGenerator(),
        quota: {
          assertCapacity: async (tenant: string) => {
            options.quotaAsked?.push(tenant);
            if (options.quotaFull)
              throw new QuotaExceeded("tasksPerMonth", 100, 100, "free");
          },
        },
      }),
      signedInAs(actor),
    ),
  );
  return async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`http://test${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    });
    return {
      status: response.status,
      // biome-ignore lint/suspicious/noExplicitAny: loosely shaped JSON bodies.
      body: (await response.json()) as any,
    };
  };
}

async function withMock(
  content: string,
  body: (mock: LLMock, baseUrl: string) => Promise<void>,
) {
  const mock = new LLMock();
  const originalBase = process.env.OPENAI_BASE_URL;
  try {
    const base = await mock.start();
    process.env.OPENAI_BASE_URL = base;
    if (content) mock.onMessage(/.*/, { content });
    await body(mock, `${base}/v1`);
  } finally {
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBase;
    await mock.stop();
  }
}

async function rowsOf(actor: AgentActor) {
  return runAsTenant(actor.id, async () => ({
    requests: await database
      .select()
      .from(roleGenerationRequests)
      .where(eq(roleGenerationRequests.ownerUserId, actor.id)),
    templates: await database
      .select({ id: roleTemplates.id })
      .from(roleTemplates)
      .where(eq(roleTemplates.ownerUserId, actor.id)),
    profiles: await database
      .select({ id: agentProfiles.agentId })
      .from(agentProfiles)
      .where(eq(agentProfiles.ownerUserId, actor.id)),
  }));
}

describe("ROLE1-3: smart generation", () => {
  test("one request id reaches the model once and answers the same profile twice", async () => {
    await withMock(
      `好的，这是角色档案：${JSON.stringify(generated)}`,
      async (mock, baseUrl) => {
        const actor = await person("once");
        const quotaAsked: string[] = [];
        const call = client(actor, { quotaAsked });
        const modelRef = await connectModel(actor.id, baseUrl);
        const input = {
          requestId: randomUUID(),
          modelRef,
          description: "一个谨慎的后端工程师",
        };
        const first = await call("POST", "/api/role-templates/generate", input);
        expect(first.status).toBe(200);
        expect(first.body).toEqual({
          requestId: input.requestId,
          state: "completed",
          profile: generated,
          error: null,
        });
        const second = await call(
          "POST",
          "/api/role-templates/generate",
          input,
        );
        expect(second.body).toEqual(first.body);
        const read = await call(
          "GET",
          `/api/role-templates/generate/${input.requestId}`,
        );
        expect(read.body).toEqual(first.body);
        expect(mock.getRequests()).toHaveLength(1);
        // The model was given the description; the quota was asked once, for this person.
        expect(JSON.stringify(mock.getRequests()[0]?.body)).toContain(
          "一个谨慎的后端工程师",
        );
        expect(quotaAsked).toEqual([actor.id]);

        // The same id for a different description is a conflict, and no call.
        const reused = await call("POST", "/api/role-templates/generate", {
          ...input,
          description: "别的角色",
        });
        expect(reused.status).toBe(409);
        expect(mock.getRequests()).toHaveLength(1);

        // The result only fills the editor: nothing was saved as a template or a coworker.
        const rows = await rowsOf(actor);
        expect(rows.templates).toEqual([]);
        expect(rows.profiles).toEqual([]);
      },
    );
  });

  test("two racing requests with one id still reach the model once", async () => {
    await withMock(JSON.stringify(generated), async (mock, baseUrl) => {
      const actor = await person("race");
      const modelRef = await connectModel(actor.id, baseUrl);
      const input = {
        requestId: randomUUID(),
        modelRef,
        description: "测试工程师",
      };
      const answers = await Promise.all([
        client(actor)("POST", "/api/role-templates/generate", input),
        client(actor)("POST", "/api/role-templates/generate", input),
      ]);
      expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
      expect(
        answers.some((answer) => answer.body.state === "completed"),
      ).toBeTrue();
      for (const answer of answers)
        expect(["pending", "completed"]).toContain(answer.body.state);
      expect(mock.getRequests()).toHaveLength(1);
      expect((await rowsOf(actor)).requests).toHaveLength(1);
    });
  });

  test("an answer that is not a profile is failed, says to retry, and writes nothing else", async () => {
    for (const content of [
      "抱歉，我不能输出 JSON。",
      '{"identity": {"title": 42}}',
      '{"identity": {"title": ""}, "persona": {}, "bible": ""}',
    ]) {
      await withMock(content, async (mock, baseUrl) => {
        const actor = await person("bad");
        const call = client(actor);
        const modelRef = await connectModel(actor.id, baseUrl);
        const answer = await call("POST", "/api/role-templates/generate", {
          requestId: randomUUID(),
          modelRef,
          description: "运营助手",
        });
        expect(answer.body).toMatchObject({
          state: "failed",
          profile: null,
          error: "生成的格式无效，请重试。",
        });
        expect(mock.getRequests()).toHaveLength(1);
        const rows = await rowsOf(actor);
        expect(rows.templates).toEqual([]);
        expect(rows.profiles).toEqual([]);
        expect(rows.requests[0]?.state).toBe("failed");
      });
    }
  });

  test("a model that is not the person's own, switched off, or the platform's is 400 with no call", async () => {
    await withMock(JSON.stringify(generated), async (mock, baseUrl) => {
      const actor = await person("model");
      const other = await person("model-other");
      const call = client(actor);
      const theirs = await connectModel(other.id, baseUrl);
      const disabled = await connectModel(actor.id, baseUrl);
      await runAsTenant(actor.id, () =>
        database
          .update(modelRegistry)
          .set({ enabled: false })
          .where(eq(modelRegistry.id, disabled)),
      );
      for (const modelRef of [
        theirs,
        disabled,
        PLATFORM_FLOW_MODEL_ID,
        randomUUID(),
        "not-a-model",
      ]) {
        const answer = await call("POST", "/api/role-templates/generate", {
          requestId: randomUUID(),
          modelRef,
          description: "代码审核员",
        });
        expect(answer.status).toBe(400);
        // D7: the platform's model is not on offer here; anything else is simply not usable.
        expect(answer.body.error).toBe(
          modelRef === PLATFORM_FLOW_MODEL_ID
            ? "平台模型未配置，请选择模型库中的模型。"
            : "所选模型不可用，请重新选择。",
        );
      }
      expect(mock.getRequests()).toHaveLength(0);
      expect((await rowsOf(actor)).requests).toEqual([]);
      // And the choices offered are the person's enabled library models only (D7).
      const choices = await call("GET", "/api/role-templates/models");
      expect(choices.body.models).toEqual([]);
    });
  });

  test("a request still pending after its lease ran out reads as unknown and is never replayed", async () => {
    await withMock(JSON.stringify(generated), async (mock, baseUrl) => {
      const actor = await person("lease");
      const call = client(actor);
      const modelRef = await connectModel(actor.id, baseUrl);
      const input = {
        requestId: randomUUID(),
        modelRef,
        description: "后端工程师",
      };
      // A call that died with its process: the row it claimed, its lease already over.
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ modelRef, description: input.description }))
        .digest("hex");
      await runAsTenant(actor.id, () =>
        database.insert(roleGenerationRequests).values({
          ownerUserId: actor.id,
          requestId: input.requestId,
          fingerprint,
          modelRef,
          state: "pending",
          leaseExpiresAt: sql`now() - interval '1 second'`,
        }),
      );
      const read = await call(
        "GET",
        `/api/role-templates/generate/${input.requestId}`,
      );
      expect(read.body).toMatchObject({ state: "unknown", profile: null });
      const again = await call("POST", "/api/role-templates/generate", input);
      expect(again.body.state).toBe("unknown");
      expect(mock.getRequests()).toHaveLength(0);

      // One whose lease is still running is pending, not unknown.
      const live = randomUUID();
      await runAsTenant(actor.id, () =>
        database.insert(roleGenerationRequests).values({
          ownerUserId: actor.id,
          requestId: live,
          fingerprint,
          modelRef,
          state: "pending",
        }),
      );
      expect(
        (await call("GET", `/api/role-templates/generate/${live}`)).body.state,
      ).toBe("pending");
    });
  });

  test("a full monthly quota refuses before any row or call", async () => {
    await withMock(JSON.stringify(generated), async (mock, baseUrl) => {
      const actor = await person("quota");
      const call = client(actor, { quotaFull: true });
      const modelRef = await connectModel(actor.id, baseUrl);
      const answer = await call("POST", "/api/role-templates/generate", {
        requestId: randomUUID(),
        modelRef,
        description: "后端工程师",
      });
      expect(answer.status).toBe(402);
      expect(answer.body.code).toBe("quota_exceeded");
      expect(mock.getRequests()).toHaveLength(0);
      expect((await rowsOf(actor)).requests).toEqual([]);
    });
  });

  test("another person cannot read a request, and bad input is refused before anything", async () => {
    await withMock(JSON.stringify(generated), async (_mock, baseUrl) => {
      const actor = await person("own");
      const other = await person("peek");
      const modelRef = await connectModel(actor.id, baseUrl);
      const requestId = randomUUID();
      await client(actor)("POST", "/api/role-templates/generate", {
        requestId,
        modelRef,
        description: "后端工程师",
      });
      expect(
        (
          await client(other)(
            "GET",
            `/api/role-templates/generate/${requestId}`,
          )
        ).status,
      ).toBe(404);
      const call = client(actor);
      for (const bad of [
        { requestId: "x", modelRef, description: "a" },
        { requestId: randomUUID(), modelRef, description: "  " },
        { requestId: randomUUID(), modelRef, description: "长".repeat(501) },
        { requestId: randomUUID(), description: "a" },
      ]) {
        expect(
          (await call("POST", "/api/role-templates/generate", bad)).status,
        ).toBe(400);
      }
      const choices = await call("GET", "/api/role-templates/models");
      expect(choices.body.models.map((m: { id: string }) => m.id)).toEqual([
        modelRef,
      ]);
    });
  });
});
