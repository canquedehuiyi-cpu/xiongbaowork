import { afterAll, describe, expect, test } from "bun:test";
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

test("a model still in use is refused with 409 and kept, then removed once unbound", async () => {
  const library = await call<Library>("GET", "/");
  const row = library.body.models.find((entry) => entry.modelName === "gpt-6");
  if (!row) throw new Error("The connected model disappeared.");
  const [entry] = await runAsTenant(tenant, () =>
    database
      .select({ credentialId: modelRegistry.credentialId })
      .from(modelRegistry)
      .where(eq(modelRegistry.id, row.id)),
  );

  // Audit #13: bypassing the screen must not silently unbind a coworker (`on delete set null`).
  const refused = await call<{
    error: string;
    code: string;
    references: number;
  }>("DELETE", `/${row.id}`);
  expect(refused.status).toBe(409);
  expect(refused.body.code).toBe("model_in_use");
  expect(refused.body.references).toBe(1);
  expect(typeof refused.body.error).toBe("string");

  const [kept] = await runAsTenant(tenant, () =>
    database
      .select({ id: modelRegistry.id })
      .from(modelRegistry)
      .where(eq(modelRegistry.id, row.id)),
  );
  expect(kept?.id).toBe(row.id);
  const [stillBound] = await runAsTenant(tenant, () =>
    database
      .select({ modelRef: agentProfiles.modelRef })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, `${suite}-dev`)),
  );
  expect(stillBound?.modelRef).toBe(row.id);
  const [vaultKept] = await runAsTenant(tenant, () =>
    database
      .select({ revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(eq(credentials.id, entry!.credentialId!)),
  );
  expect(vaultKept?.revokedAt).toBeNull();

  // Unbound, the same delete goes through and the key goes with the model.
  await runAsTenant(tenant, () =>
    database
      .update(agentProfiles)
      .set({ modelRef: null })
      .where(eq(agentProfiles.agentId, `${suite}-dev`)),
  );
  const removed = await call("DELETE", `/${row.id}`);
  expect(removed.status).toBe(200);

  const [gone] = await runAsTenant(tenant, () =>
    database
      .select({ id: modelRegistry.id })
      .from(modelRegistry)
      .where(eq(modelRegistry.id, row.id)),
  );
  expect(gone).toBeUndefined();
  const [vault] = await runAsTenant(tenant, () =>
    database
      .select({ revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(eq(credentials.id, entry!.credentialId!)),
  );
  expect(vault?.revokedAt).not.toBeNull();

  const missing = await call("DELETE", `/${row.id}`);
  expect(missing.status).toBe(404);
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

/**
 * Audit defect #6: the probe POSTs the tenant's key to the tenant's base URL, so the address is
 * checked when it is stored and again, with DNS, before every probe — and a refused probe sends
 * nothing at all. The resolver and the network are stand-ins that record what they were asked.
 */
describe("a model endpoint inside the deployment is never sent the key", () => {
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input instanceof Request ? input.url : input), init });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const lookup = async (hostname: string) =>
    hostname === "rebind.example.test"
      ? [{ address: "127.0.0.1", family: 4 }]
      : [{ address: "93.184.216.34", family: 4 }];
  const guarded = createModelRoutes(
    database,
    requireUser,
    credentialStore,
    encryptionKey,
    undefined,
    { lookup, fetchImpl },
  );
  const callGuarded = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> => {
    const response = await runAsTenant(tenant, () =>
      guarded.request(
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
  };

  test("an internal or metadata base URL is refused before it is stored", async () => {
    for (const baseUrl of [
      "http://169.254.169.254/latest/meta-data/",
      "https://127.0.0.1/v1",
      "https://[::ffff:127.0.0.1]/v1",
      "http://api.example.com/v1",
    ]) {
      const created = await callGuarded<{ error: string }>("POST", "/", {
        provider: `tpl-${suite}`,
        modelName: "ssrf-refused",
        apiKey: "sk-ssrf-refused-0001",
        baseUrl,
      });
      expect(created.status).toBe(400);
    }
    const library = await callGuarded<Library>("GET", "/");
    expect(
      library.body.models.some((entry) => entry.modelName === "ssrf-refused"),
    ).toBeFalse();
    expect(sent).toHaveLength(0);
  });

  test("a name that resolves to loopback is refused at probe time, with nothing sent", async () => {
    const created = await callGuarded<Written>("POST", "/", {
      provider: `tpl-${suite}`,
      modelName: "ssrf-rebind",
      apiKey: "sk-ssrf-rebind-0002",
      baseUrl: "https://rebind.example.test/v1",
    });
    expect(created.status).toBe(201);

    const probed = await callGuarded<{ ok: boolean; error?: string }>(
      "POST",
      `/${created.body.model.id}/test`,
    );
    expect(probed.status).toBe(400);
    expect(probed.body.ok).toBeFalse();
    expect(JSON.stringify(probed.body)).not.toContain("sk-ssrf-rebind-0002");
    expect(sent).toHaveLength(0);

    await callGuarded("DELETE", `/${created.body.model.id}`);
  });

  test("a stored metadata URL from before the check is refused at probe time", async () => {
    const created = await callGuarded<Written>("POST", "/", {
      provider: `tpl-${suite}`,
      modelName: "ssrf-legacy",
      apiKey: "sk-ssrf-legacy-0003",
      baseUrl: "https://legacy.example.test/v1",
    });
    expect(created.status).toBe(201);
    // As a row written before this check existed would hold it.
    await runAsTenant(tenant, () =>
      database
        .update(modelRegistry)
        .set({ baseUrl: "http://169.254.169.254/latest" })
        .where(eq(modelRegistry.id, created.body.model.id)),
    );

    const probed = await callGuarded<{ ok: boolean }>(
      "POST",
      `/${created.body.model.id}/test`,
    );
    expect(probed.status).toBe(400);
    expect(probed.body.ok).toBeFalse();
    expect(sent).toHaveLength(0);

    await callGuarded("DELETE", `/${created.body.model.id}`);
  });
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
