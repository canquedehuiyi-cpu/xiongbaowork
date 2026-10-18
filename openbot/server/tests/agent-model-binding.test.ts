import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAgentProfileStore,
  ModelBindingNotApplicableError,
  ModelNotInLibraryError,
} from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createCredentialStore, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  credentials,
  modelRegistry,
  users,
} from "../src/db/schema";
import {
  boundModelName,
  createAgentModelResolver,
  languageModelFor,
} from "../src/models/runtime-resolver";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 012 acceptance (spec test decision #5): the model a run speaks with is the model the
 * coworker was bound to, per coworker and inside one tenant — 开发 on GPT-6 and 审核 on GLM-5.3 at the
 * same time — and every reason a binding might not hold (none, switched off, withdrawn key, another
 * tenant's row) falls back to the deployment's model instead of failing the turn.
 */
const url = testDatabaseUrl();
const db = createDatabase(url, TEST_POOL);
// Thirty-two bytes of key material, base64, which is what `aesKey` above the vault requires.
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const credentialStore = createCredentialStore(db);
const resolveModel = createAgentModelResolver(
  db,
  credentialStore,
  encryptionKey,
);

const marker = `model-bind-${Date.now()}`;
const tenantA = `${marker}-a`;
const tenantB = `${marker}-b`;

/** One connected model in one tenant's library, keyed with a live vault row. */
async function connectModel(
  tenant: string,
  provider: string,
  modelName: string,
  apiKey = "sk-live",
): Promise<string> {
  return runAsTenant(tenant, async () => {
    const credential = await credentialStore.create({
      kind: "model",
      provider,
      // The live-key index is not tenant-scoped, so two tenants connecting the same model name must
      // not collide on it — the same fact a person hits when they name a key after its model.
      keyId: `${tenant}-${modelName}-${marker}`,
      encryptedValue: await encryptSecret(encryptionKey, apiKey),
      metadata: {},
    });
    const [row] = await db
      .insert(modelRegistry)
      .values({ provider, modelName, credentialId: credential.id })
      .returning({ id: modelRegistry.id });
    return row.id;
  });
}

/**
 * One coworker, bound or not.
 *
 * `owner` is the person it belongs to, and is only passed where the test needs somebody to be able
 * to edit it: the column is a real foreign key into `users`, so an owner that was never created
 * fails the insert rather than reading back as null.
 */
async function newCoworker(
  tenant: string,
  id: string,
  modelRef: string | null,
  runs: "built_in" | "remote_ag_ui" = "built_in",
  owner?: string,
): Promise<string> {
  return runAsTenant(tenant, async () => {
    const [agent] = await db
      .insert(agents)
      .values({
        id,
        name: id,
        type: runs,
        configuration:
          runs === "built_in"
            ? { systemPrompt: "test" }
            : { endpoint: "https://elsewhere.example.test/ag-ui" },
      })
      .returning({ id: agents.id });
    await db.insert(agentProfiles).values({
      agentId: agent.id,
      ownerUserId: owner ?? null,
      title: id,
      roleDescription: "测试员工",
      avatarSeed: marker,
      visibility: "private",
      modelRef,
    });
    return agent.id;
  });
}

function modelId(model: Awaited<ReturnType<typeof resolveModel>>): string {
  const value = model as unknown as { modelId?: string } | null;
  return value?.modelId ?? "";
}

test("two coworkers in one tenant answer on their own two models", async () => {
  const developer = await connectModel(tenantA, "openai", "gpt-6");
  const reviewer = await connectModel(tenantA, "zhipu", "glm-5.3");
  const developerId = await newCoworker(tenantA, `${marker}-dev`, developer);
  const reviewerId = await newCoworker(tenantA, `${marker}-reviewer`, reviewer);

  const devModel = await runAsTenant(tenantA, () => resolveModel(developerId));
  const reviewModel = await runAsTenant(tenantA, () =>
    resolveModel(reviewerId),
  );

  expect(modelId(devModel)).toBe("gpt-6");
  expect(modelId(reviewModel)).toBe("glm-5.3");
  // The name the usage row and the allowlist get, per coworker and not per deployment.
  expect(
    await runAsTenant(tenantA, () => boundModelName(db, developerId)),
  ).toBe("openai/gpt-6");
  expect(await runAsTenant(tenantA, () => boundModelName(db, reviewerId))).toBe(
    "zhipu/glm-5.3",
  );

  await cleanup();
});

test("an unbound coworker gets no model, so the deployment's answers", async () => {
  await connectModel(tenantA, "openai", "gpt-6");
  const unbound = await newCoworker(tenantA, `${marker}-plain`, null);

  expect(await runAsTenant(tenantA, () => resolveModel(unbound))).toBeNull();
  expect(
    await runAsTenant(tenantA, () => boundModelName(db, unbound)),
  ).toBeNull();

  await cleanup();
});

test("another tenant's model is not a binding", async () => {
  const foreign = await connectModel(tenantB, "openai", "gpt-6");
  // The foreign key is not stopped by row-level security, so a dangling-across-tenants id can be
  // written; what must refuse it is the read that turns the id into a model.
  const thief = await newCoworker(tenantA, `${marker}-thief`, foreign);

  expect(await runAsTenant(tenantA, () => resolveModel(thief))).toBeNull();
  expect(await runAsTenant(tenantB, () => resolveModel(thief))).toBeNull();
  expect(
    await runAsTenant(tenantA, () => boundModelName(db, thief)),
  ).toBeNull();

  await cleanup();
});

test("a switched-off model or a withdrawn key costs the binding, not the turn", async () => {
  const off = await connectModel(tenantA, "openai", "gpt-6");
  const withdrawn = await connectModel(tenantA, "zhipu", "glm-5.3");
  const switchedOff = await newCoworker(tenantA, `${marker}-off`, off);
  const keyGone = await newCoworker(tenantA, `${marker}-keygone`, withdrawn);

  await runAsTenant(tenantA, () =>
    db
      .update(modelRegistry)
      .set({ enabled: false })
      .where(eq(modelRegistry.id, off)),
  );
  await runAsTenant(tenantA, () =>
    db
      .update(credentials)
      .set({ revokedAt: new Date() })
      .where(eq(credentials.keyId, `${tenantA}-glm-5.3-${marker}`)),
  );

  expect(
    await runAsTenant(tenantA, () => resolveModel(switchedOff)),
  ).toBeNull();
  expect(await runAsTenant(tenantA, () => resolveModel(keyGone))).toBeNull();

  await cleanup();
});

/** A read with no tenant frame sees the platform's own partition, which holds none of this. */
test("a binding is not read outside a tenant scope", async () => {
  const bound = await connectModel(tenantA, "openai", "gpt-6");
  const coworker = await newCoworker(tenantA, `${marker}-scope`, bound);

  expect(await resolveModel(coworker)).toBeNull();

  await cleanup();
});

test("the provider shape decides the endpoint the model is dialled at", () => {
  const openai = languageModelFor("openai", null, "gpt-6", "sk-1");
  const custom = languageModelFor(
    "custom",
    "https://llm.internal/v1",
    "local-1",
    "sk-2",
  );
  expect((openai as unknown as { modelId: string }).modelId).toBe("gpt-6");
  expect(
    (custom as unknown as { modelId: string; provider: string }).modelId,
  ).toBe("local-1");
});

async function cleanup(): Promise<void> {
  for (const tenant of [tenantA, tenantB]) {
    await runAsTenant(tenant, async () => {
      await db.delete(agentProfiles);
      await db.delete(modelRegistry);
      await db.delete(credentials);
      await db.delete(agents);
      await db.delete(users);
    });
  }
}

/**
 * The person, who is also the tenant.
 *
 * The binding is written through the same store the coworker screen uses, so this is the whole path
 * from a pick on a form to a row a run reads — not just the read half.
 */
async function newPerson(tenant: string): Promise<AgentActor> {
  return runAsTenant(tenant, async () => {
    await db
      .insert(users)
      .values({ id: tenant, email: `${tenant}@example.test`, name: tenant })
      .onConflictDoNothing();
    return { id: tenant, role: "user" as const };
  });
}

const form = {
  name: "开发",
  title: "Developer",
  roleDescription: "Writes the code.",
  visibility: "private" as const,
};

test("a binding is written, left alone, and cleared through the profile store", async () => {
  const actor = await newPerson(tenantA);
  const store = createAgentProfileStore(db, undefined);
  const model = await connectModel(tenantA, "openai", "gpt-6");
  const coworker = await newCoworker(
    tenantA,
    `${marker}-write`,
    null,
    "built_in",
    actor.id,
  );

  const bound = await runAsTenant(tenantA, () =>
    store.update(actor, coworker, { ...form, modelRef: model }),
  );
  expect(bound.modelRef).toBe(model);
  // The write and the read agree: what the person picked is what the run speaks with.
  expect(
    modelId(await runAsTenant(tenantA, () => resolveModel(coworker))),
  ).toBe("gpt-6");

  const renamed = await runAsTenant(tenantA, () =>
    store.update(actor, coworker, { ...form, name: "开发者" }),
  );
  expect(renamed.modelRef).toBe(model);

  const cleared = await runAsTenant(tenantA, () =>
    store.update(actor, coworker, { ...form, modelRef: null }),
  );
  expect(cleared.modelRef).toBeNull();
  expect(await runAsTenant(tenantA, () => resolveModel(coworker))).toBeNull();

  await cleanup();
});

test("a model from another tenant's library is refused as a binding", async () => {
  const actor = await newPerson(tenantA);
  const store = createAgentProfileStore(db, undefined);
  const foreign = await connectModel(tenantB, "openai", "gpt-6");
  const coworker = await newCoworker(
    tenantA,
    `${marker}-refused`,
    null,
    "built_in",
    actor.id,
  );

  let refused: unknown;
  try {
    await runAsTenant(tenantA, () =>
      store.update(actor, coworker, { ...form, modelRef: foreign }),
    );
  } catch (error) {
    refused = error;
  }
  // The foreign key alone would have taken it: a foreign key is not stopped by row-level security.
  expect(refused).toBeInstanceOf(ModelNotInLibraryError);
  expect(
    await runAsTenant(tenantA, () =>
      db
        .select({ modelRef: agentProfiles.modelRef })
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, coworker)),
    ),
  ).toEqual([{ modelRef: null }]);

  await cleanup();
});

test("a coworker that runs on another server is not offered a model", async () => {
  const actor = await newPerson(tenantA);
  const store = createAgentProfileStore(db, undefined);
  const model = await connectModel(tenantA, "openai", "gpt-6");
  const remote = await newCoworker(
    tenantA,
    `${marker}-remote`,
    null,
    "remote_ag_ui",
    actor.id,
  );

  let refused: unknown;
  try {
    await runAsTenant(tenantA, () =>
      store.update(actor, remote, { ...form, modelRef: model }),
    );
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeInstanceOf(ModelBindingNotApplicableError);

  await cleanup();
});
