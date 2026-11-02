import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { mcpServers } from "../src/db/schema";
import type { BrokerApp } from "../src/plugins/broker";
import { backfillComposioLogos } from "../src/plugins/logos";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0))
    await runAsTenant("platform", () =>
      database.delete(mcpServers).where(eq(mcpServers.id, id)),
    );
});
afterAll(async () => {
  await database.$client.close();
});

async function server(logo: string | null, provenance = "composio") {
  const id = `logo-${randomUUID()}`;
  // A deployment's brokered app, the kind the boot backfill walks: the platform's own row.
  await runAsTenant("platform", () =>
    database.insert(mcpServers).values({
      id,
      title: "Example",
      vendor: "Composio",
      url: `composio://${id}`,
      provenance,
      logo,
      authScheme: "API_KEY",
    }),
  );
  ids.push(id);
  return id;
}
function app(slug: string): BrokerApp {
  return {
    slug,
    name: "Example",
    description: "",
    logo: "https://example.com/logo.svg",
    categories: [],
    actionCount: 0,
    connection: { kind: "fields", authScheme: "API_KEY" },
  };
}
async function row(id: string) {
  const [result] = await runAsTenant("platform", () =>
    database.select().from(mcpServers).where(eq(mcpServers.id, id)),
  );
  return result;
}

test("fills existing brokered apps by their URL, preserving existing logos and schemes", async () => {
  const missing = await server(null);
  const existing = await server("https://example.com/existing.svg");
  const custom = await server(null, "custom");
  await backfillComposioLogos(database, {
    listApps: async () => [app(missing), app(existing), app(custom)],
  });
  expect((await row(missing))?.logo).toBe("https://example.com/logo.svg");
  expect((await row(missing))?.authScheme).toBe("API_KEY");
  expect((await row(existing))?.logo).toBe("https://example.com/existing.svg");
  expect((await row(custom))?.logo).toBeNull();
});

test("catalogue errors preserve the saved app and propagate to the startup warning", async () => {
  const id = await server(null);
  await expect(
    backfillComposioLogos(database, {
      listApps: async () => {
        throw new Error("Catalogue unavailable");
      },
    }),
  ).rejects.toThrow("Catalogue unavailable");
  expect((await row(id))?.logo).toBeNull();
  expect((await row(id))?.authScheme).toBe("API_KEY");
});

/*
 * G01-D: the backfill is boot maintenance across every tenant, so it runs as `platform`. Unframed it
 * read as `system` and never saw an app a person enabled in their own workspace.
 */
test("fills an app a person enabled in their own workspace, and leaves it theirs", async () => {
  const tenant = `logo-tenant-${randomUUID()}`;
  const id = `logo-${randomUUID()}`;
  await runAsTenant(tenant, () =>
    database.insert(mcpServers).values({
      id,
      title: "Example",
      vendor: "Composio",
      url: `composio://${id}`,
      provenance: "composio",
      logo: null,
      authScheme: "API_KEY",
    }),
  );
  ids.push(id);

  const saved = process.env.OPENBOT_TENANT_FRAME_GUARD;
  process.env.OPENBOT_TENANT_FRAME_GUARD = "throw";
  try {
    await backfillComposioLogos(database, {
      listApps: async () => [app(id)],
    });
  } finally {
    if (saved === undefined) delete process.env.OPENBOT_TENANT_FRAME_GUARD;
    else process.env.OPENBOT_TENANT_FRAME_GUARD = saved;
  }
  const filled = await row(id);
  expect(filled?.logo).toBe("https://example.com/logo.svg");
  expect(filled?.tenantId).toBe(tenant);
});
