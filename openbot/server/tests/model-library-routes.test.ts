import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  type CredentialSecretReader,
  createCredentialStore,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  credentials,
  modelRegistry,
  modelUsage,
  providerTemplates,
  tasks,
  users,
} from "../src/db/schema";
import { createModelRoutes } from "../src/models/routes";
import { createAgentModelResolver } from "../src/models/runtime-resolver";
import type { TaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 013 acceptance: what the "能力与资源" screen asks of the server.
 *
 * The routes are the real ones, mounted the way `index.ts` mounts them, behind a guard that stands
 * in for a signed-in person and a database that enforces row-level security — so a zone that would
 * show the wrong thing on screen fails here rather than on a screen.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const encryptionKey = Buffer.alloc(32, 11).toString("base64");
const credentialStore = createCredentialStore(database);
const suite = randomUUID().slice(0, 8);
const tenant = `lib-${suite}`;
const actor = { id: tenant, role: "user" as const };

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

const routes = createModelRoutes(
  database,
  requireUser,
  credentialStore,
  encryptionKey,
);

const projector = {
  reviewed: async () => true,
  archived: async () => true,
} as unknown as TaskProjector;
const taskRoutes = createTaskRoutes(database, requireUser, projector);

/** Every request the screen makes, under the person's own tenant scope. */
async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await runAsTenant(tenant, () =>
    routes.request(
      new Request(`http://openbot.test${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      }),
    ),
  );
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as T,
  };
}

type Library = {
  models: {
    id: string;
    provider: string;
    modelName: string;
    enabled: boolean;
    coworkers: number;
  }[];
  templates: { id: string; allowsBaseUrl: boolean }[];
};

type Written = { model: { id: string; apiKey: string; credentialId: string } };

/** The seed: a provider template to connect through, and a person to connect it as. */
await runAsTenant("platform", async () => {
  await database
    .insert(providerTemplates)
    .values({ id: `tpl-${suite}`, label: "Test provider", allowsBaseUrl: true })
    .onConflictDoNothing();
});
await runAsTenant(tenant, async () => {
  await database
    .insert(users)
    .values({ id: tenant, email: `${tenant}@example.test`, name: tenant });
});

test("connecting a model masks the key and the row starts unused", async () => {
  const created = await call<Written>("POST", "/", {
    provider: `tpl-${suite}`,
    modelName: "gpt-6",
    apiKey: "sk-secret-abcdef34",
    baseUrl: "https://llm.internal/v1",
  });
  expect(created.status).toBe(201);
  expect(created.body.model.apiKey).toBe("****ef34");
  expect(
    JSON.stringify(created.body).includes("sk-secret-abcdef34"),
  ).toBeFalse();

  const library = await call<Library>("GET", "/");
  const row = library.body.models.find((entry) => entry.modelName === "gpt-6");
  expect(row?.coworkers).toBe(0);
  expect(row?.enabled).toBeTrue();
  expect(
    library.body.templates.some((entry) => entry.id === `tpl-${suite}`),
  ).toBeTrue();
});

test("switching a model off is a write the library shows", async () => {
  const library = await call<Library>("GET", "/");
  const row = library.body.models.find((entry) => entry.modelName === "gpt-6");
  if (!row) throw new Error("The connected model disappeared.");

  const patched = await call<{ model: { enabled: boolean } }>(
    "PATCH",
    `/${row.id}`,
    { enabled: false },
  );
  expect(patched.status).toBe(200);
  expect(patched.body.model.enabled).toBeFalse();

  const again = await call<Library>("GET", "/");
  expect(
    again.body.models.find((entry) => entry.id === row.id)?.enabled,
  ).toBeFalse();

  const nothing = await call("PATCH", `/${row.id}`, {});
  expect(nothing.status).toBe(400);

  // Back on, so the rest of the suite describes a usable library.
  await call("PATCH", `/${row.id}`, { enabled: true });
});

test("a bound coworker is counted, named, and answered with the model it chose", async () => {
  const library = await call<Library>("GET", "/");
  const row = library.body.models.find((entry) => entry.modelName === "gpt-6");
  if (!row) throw new Error("The connected model disappeared.");

  const agentId = `${suite}-dev`;
  await runAsTenant(tenant, async () => {
    await database.insert(agents).values({
      id: agentId,
      name: "开发者",
      type: "built_in",
      configuration: { systemPrompt: "Write the code." },
    });
    await database.insert(agentProfiles).values({
      agentId,
      ownerUserId: tenant,
      title: "Developer",
      roleDescription: "Writes the code.",
      avatarSeed: suite,
      visibility: "private",
      modelRef: row.id,
    });
  });

  const listed = await call<Library>("GET", "/");
  expect(
    listed.body.models.find((entry) => entry.id === row.id)?.coworkers,
  ).toBe(1);

  const references = await call<{
    references: number;
    coworkers: { id: string; name: string }[];
  }>("GET", `/${row.id}/references`);
  expect(references.body.references).toBe(1);
  // Named, because "which ones" is the question a count cannot answer.
  expect(references.body.coworkers[0]?.name).toBe("开发者");

  // The run itself: the binding the screen shows is the binding the resolver hands over.
  const resolve = createAgentModelResolver(
    database,
    credentialStore as unknown as CredentialSecretReader,
    encryptionKey,
  );
  const model = await runAsTenant(tenant, () => resolve(agentId));
  expect((model as unknown as { modelId: string }).modelId).toBe("gpt-6");
});

test("removing a model unbinds the coworker and retires the key", async () => {
  const library = await call<Library>("GET", "/");
  const row = library.body.models.find((entry) => entry.modelName === "gpt-6");
  if (!row) throw new Error("The connected model disappeared.");
  const [entry] = await runAsTenant(tenant, () =>
    database
      .select({ credentialId: modelRegistry.credentialId })
      .from(modelRegistry)
      .where(eq(modelRegistry.id, row.id)),
  );

  const removed = await call("DELETE", `/${row.id}`);
  expect(removed.status).toBe(200);

  const [profile] = await runAsTenant(tenant, () =>
    database
      .select({ modelRef: agentProfiles.modelRef })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, `${suite}-dev`)),
  );
  // Set null rather than left dangling: the coworker answers on the deployment's model next turn.
  expect(profile?.modelRef).toBeNull();

  const [vault] = await runAsTenant(tenant, () =>
    database
      .select({ revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(eq(credentials.id, entry!.credentialId!)),
  );
  expect(vault?.revokedAt).not.toBeNull();
});

test("the board says which model answered each task", async () => {
  const runId = `${suite}-run`;
  await runAsTenant(tenant, async () => {
    const [task] = await database
      .insert(tasks)
      .values({
        title: "Write the parser",
        executorAgentId: `${suite}-dev`,
        source: "chat",
        runRef: runId,
      })
      .returning({ id: tasks.id });
    await database.insert(modelUsage).values({
      agentId: `${suite}-dev`,
      runId,
      model: "zhipu/glm-5.3",
      source: "bound",
      allowed: true,
    });
    return task.id;
  });

  const response = await runAsTenant(tenant, () =>
    taskRoutes.request(new Request("http://openbot.test/")),
  );
  const body = (await response.json()) as {
    tasks: { runRef: string; model: string | null }[];
  };
  const listed = body.tasks.find((entry) => entry.runRef === runId);
  expect(listed?.model).toBe("zhipu/glm-5.3");

  const [other] = await runAsTenant(tenant, () =>
    database
      .insert(tasks)
      .values({
        title: "Not run yet",
        executorAgentId: `${suite}-dev`,
        source: "chat",
      })
      .returning({ id: tasks.id }),
  );
  const second = await runAsTenant(tenant, () =>
    taskRoutes.request(new Request("http://openbot.test/")),
  );
  const secondBody = (await second.json()) as {
    tasks: { id: string; model: string | null }[];
  };
  expect(
    secondBody.tasks.find((entry) => entry.id === other.id)?.model,
  ).toBeNull();
});

afterAll(async () => {
  for (const scope of [tenant, "platform"]) {
    await runAsTenant(scope, async () => {
      if (scope === tenant) {
        await database.delete(agentProfiles);
        await database.delete(tasks);
        await database.delete(modelUsage);
        await database.delete(agents);
        await database.delete(modelRegistry);
        await database.delete(credentials);
        await database.delete(users);
      }
      await database
        .delete(providerTemplates)
        .where(eq(providerTemplates.id, `tpl-${suite}`));
    });
  }
  await runAsTenant("platform", () =>
    database
      .delete(modelRegistry)
      .where(inArray(modelRegistry.tenantId, [tenant])),
  );
});
