import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { type AuthService, createRequireUser } from "../src/auth/guards";
import { createAutonomousRoutes } from "../src/autonomous/routes";
import { createAutonomousStore } from "../src/autonomous/store";
import { loadConfig } from "../src/config";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, tasks, users } from "../src/db/schema";
import { createDeviceQueue } from "../src/devices/queue";
import { createDeviceRoutes } from "../src/devices/routes";
import { createDeviceStore } from "../src/devices/store";
import { createModelRoutes } from "../src/models/routes";
import { createPersonaRoutes } from "../src/personas/routes";
import { createPersonaTemplateStore } from "../src/personas/store";
import { createPipelineRoutes } from "../src/pipeline/routes";
import { createPipelineStore } from "../src/pipeline/store";
import { createQuotaService } from "../src/quota/limits";
import { createQuotaRoutes } from "../src/quota/routes";
import { createTaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { createWakerGroupRoutes } from "../src/waker-groups/routes";
import { createWakerGroupStore } from "../src/waker-groups/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `spa-${randomUUID()}`;
const tenantA = `${prefix}-a`;
const tenantB = `${prefix}-b`;
const agentId = `${prefix}-agent`;
const dist = mkdtempSync(join(tmpdir(), "openbot-spa-"));
const html = "<!doctype html><title>Delivery SPA fixture</title>";
writeFileSync(join(dist, "index.html"), html);
// A static file at a real API path must never shadow its authenticated JSON route.
mkdirSync(join(dist, "api"));
writeFileSync(join(dist, "api/tasks"), "STATIC API SHADOW");

const auth: AuthService = {
  handler: () => new Response(null, { status: 404 }),
  api: {
    async getSession({ headers }) {
      const id = headers.get("x-test-session");
      return id === tenantA || id === tenantB
        ? { user: { id, email: `${id}@example.test` } }
        : null;
    },
  },
};
const roles = { rolesForUser: async () => ["user" as const] };
const guard = createRequireUser(auth, roles);
const config = loadConfig(testEnvironment({ APP_DIST_DIR: dist }));
const app = createApp(config, auth, roles);
const board = createTaskProjector(database);
const quota = createQuotaService(database);
// Append the actual eight business routers in the production order AFTER createApp returns.
app.route("/api/tasks", createTaskRoutes(database, guard, board));
app.route(
  "/api/models",
  createModelRoutes(
    database,
    guard,
    createCredentialStore(database),
    config.keyEncryptionKey,
    quota,
  ),
);
app.route("/api/quota", createQuotaRoutes(database, quota, guard));
app.route(
  "/api/devices",
  createDeviceRoutes(
    createDeviceStore(database),
    guard,
    createDeviceQueue(database),
  ),
);
app.route(
  "/api/agents",
  createAutonomousRoutes(createAutonomousStore(database), guard),
);
app.route(
  "/api/waker-groups",
  createWakerGroupRoutes(createWakerGroupStore(database), guard),
);
app.route(
  "/api/group-pipelines",
  createPipelineRoutes(
    createPipelineStore({
      database,
      board,
      canUse: async () => true,
      executeStep: async () => {
        throw new Error("Read-only SPA probes must never execute a pipeline.");
      },
    }),
    guard,
  ),
);
app.route(
  "/api/personas",
  createPersonaRoutes(createPersonaTemplateStore(database), guard),
);

await database
  .insert(users)
  .values(
    [tenantA, tenantB].map((id) => ({ id, email: `${id}@example.test` })),
  );
const [card] = await runAsTenant(tenantA, async () => {
  await database.insert(agents).values({
    id: agentId,
    tenantId: tenantA,
    name: "SPA agent",
    type: "built_in",
    configuration: {},
  });
  return await database
    .insert(tasks)
    .values({
      tenantId: tenantA,
      title: "SPA private task",
      executorAgentId: agentId,
      source: "chat",
      status: "done",
    })
    .returning({ id: tasks.id });
});
const paths = [
  "/api/tasks",
  "/api/models",
  "/api/quota",
  "/api/devices",
  "/api/waker-groups",
  "/api/group-pipelines/templates",
  "/api/personas",
  `/api/agents/${agentId}/autonomous`,
];
const request = (path: string, tenant?: string) =>
  app.request(`http://openbot.test${path}`, {
    headers: tenant ? { "x-test-session": tenant } : {},
  });

for (const path of paths) {
  test(`built SPA passes ${path.replace(agentId, ":agentId")} to the appended business route`, async () => {
    const response = await request(path, tenantA);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).not.toContain("STATIC API SHADOW");
  });
  test(`built SPA preserves authentication for ${path.replace(agentId, ":agentId")}`, async () => {
    const response = await request(path);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Authentication required.",
    });
  });
}

test("cross-tenant task resources remain 404 while each tenant's list is 200", async () => {
  const list = await request("/api/tasks", tenantB);
  expect(list.status).toBe(200);
  expect(
    (await list.json()).tasks.map((task: { id: string }) => task.id),
  ).not.toContain(card.id);
  expect(
    (await request(`/api/tasks/${card.id}/open-target`, tenantB)).status,
  ).toBe(404);
});

test("foreign or unknown autonomous coworkers return 404", async () => {
  expect(
    (await request(`/api/agents/${agentId}/autonomous`, tenantB)).status,
  ).toBe(404);
  expect(
    (await request(`/api/agents/${prefix}-missing/autonomous`, tenantA)).status,
  ).toBe(404);
});

test("unknown APIs keep 404 and frontend deep links receive the SPA", async () => {
  for (const path of ["/api", "/api/missing-business-route"]) {
    const response = await request(path, tenantA);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Delivery SPA fixture");
  }
  const response = await request("/tasks", tenantA);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(html);
});

afterAll(async () => {
  try {
    await runAsTenant("platform", async () => {
      await database
        .delete(tasks)
        .where(inArray(tasks.tenantId, [tenantA, tenantB]));
      await database.delete(agents).where(eq(agents.id, agentId));
      await database.delete(users).where(inArray(users.id, [tenantA, tenantB]));
    });
  } finally {
    await database.$client.close();
    rmSync(dist, { recursive: true, force: true });
  }
});
