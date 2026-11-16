import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { setEdition } from "../src/edition";
import { EVERY_BOT_REFUSAL } from "../src/plugins/personal-defaults";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { seedAdministrator } from "./support/admin-request";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 一次保存员工在一个应用上的几个动作（M5a 的 `/for/:agentId/apps/:app/grants`，上游 #1396）里关掉的那几个，
 * 照 `DELETE /grants` 先问个人版能不能收回（X4 的 `personalRevokeRefusal`，上游 `revokeRefusal` 的前三行）：
 * 个人版里个人默认管着的员工持有每个已连接应用的每个动作，从一位身上关掉会被拒绝，而不是答「已关掉」又在
 * 下一次运行时被加回来。远端员工和团队版照常关掉。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const OWNER = `pbr-owner-${suite}`;
const BOT = `pbr-bot-${suite}`;
const REMOTE = `pbr-remote-${suite}`;
const BOTS = [BOT, REMOTE];
const APP = `pbr-app-${suite}`;
const READ = `${APP}/read_notes`;
const WRITE = `${APP}/update_notes`;

const audit = createAuditStore(database);
const store = createPluginStore({
  database,
  auditStore: audit,
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});
let releaseAdmin: (() => Promise<void>) | undefined;

function routes() {
  const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: OWNER,
      email: `${OWNER}@example.test`,
      role: "admin",
    } as never);
    await runAsTenant(OWNER, () => next());
  };
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      session,
      async () => true,
      undefined,
      undefined,
      createAdminScope({ roleRepository: createRoleRepository(database) }),
    ),
  );
}

const save = (bot: string, body: { add: string[]; remove: string[] }) =>
  routes().request(`/api/plugins/for/${bot}/apps/${APP}/grants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function holds(bot: string) {
  const rows = await asPlatform(() =>
    database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.agentId, bot), like(pluginGrants.ref, `${APP}/%`)),
      ),
  );
  return rows.map((row) => row.ref).sort();
}

beforeAll(async () => {
  releaseAdmin = await seedAdministrator(database, OWNER);
  await asPlatform(async () => {
    for (const [id, type] of [
      [BOT, "built_in"],
      [REMOTE, "remote_ag_ui"],
    ] as const) {
      await database.insert(agents).values({
        id,
        tenantId: OWNER,
        name: id,
        type,
        configuration: {},
      });
      await database.insert(agentProfiles).values({
        agentId: id,
        tenantId: OWNER,
        ownerUserId: OWNER,
        title: id,
        roleDescription: "测试员工",
        avatarSeed: id,
        visibility: "private",
      });
    }
    await database.insert(mcpServers).values({
      id: APP,
      tenantId: "team",
      title: "Notes",
      vendor: "Test",
      url: "https://notes.example.test/mcp",
      addedBy: OWNER,
    });
    await database.insert(mcpTools).values(
      ["read_notes", "update_notes"].map((name) => ({
        serverId: APP,
        tenantId: "team",
        name,
        description: name,
        effect: name.startsWith("read") ? "read" : "write",
        version: "1",
      })),
    );
  });
});

beforeEach(async () => {
  await asPlatform(() =>
    database.delete(pluginGrants).where(inArray(pluginGrants.agentId, BOTS)),
  );
  for (const bot of BOTS)
    for (const ref of [READ, WRITE])
      await runAsTenant(OWNER, () =>
        store.grant("mcp", ref, bot, `${OWNER}@example.test`),
      );
});

afterEach(() => setEdition("team"));

afterAll(async () => {
  await asPlatform(async () => {
    await database.delete(mcpServers).where(eq(mcpServers.id, APP));
    await database.delete(agents).where(inArray(agents.id, BOTS));
  });
  await releaseAdmin?.();
  await database.$client.close();
});

describe("turning actions off in one save, in the personal edition", () => {
  test("is refused for a Bot the personal defaults keep whole, and nothing is taken away", async () => {
    setEdition("personal");
    const response = await save(BOT, { add: [], remove: [WRITE] });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: EVERY_BOT_REFUSAL,
      problems: [{ ref: WRITE, error: EVERY_BOT_REFUSAL }],
    });
    expect(await holds(BOT)).toEqual([READ, WRITE].sort());
  });

  test("still turns them off for a remote Bot, which the personal defaults do not fill", async () => {
    setEdition("personal");
    const response = await save(REMOTE, { add: [], remove: [WRITE] });
    expect(response.status).toBe(200);
    expect(await holds(REMOTE)).toEqual([READ]);
  });

  test("turns them off as before on the team edition", async () => {
    setEdition("team");
    const response = await save(BOT, { add: [], remove: [WRITE] });
    expect(response.status).toBe(200);
    expect(await holds(BOT)).toEqual([READ]);
  });
});
