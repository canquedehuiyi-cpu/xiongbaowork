import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAuditStore } from "../src/audit";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  agents,
  composioConnections,
  mcpServers,
  mcpTools,
  users,
} from "../src/db/schema";
import type { ComposioBroker } from "../src/plugins/broker";
import { DEPLOYMENT_CLIENT_SCHEME } from "../src/plugins/deployment-clients";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * An account on the deployment's own client is only ever an administrator's, on every call
 * (review I-1).
 *
 * The connect route and the store let only an administrator connect a server-to-server app, but a
 * connection is a row, and the row outlives the role. An administrator made an ordinary member kept
 * the organization's access through it: their own Bots' calls, and a teammate's through their Team
 * Bot, which reaches the owner's account. So the call path asks again, of the person whose account
 * the call goes out on, and refuses once they are no longer an administrator.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = `dcx-${randomUUID().slice(0, 8)}`;
const toolkit = `shop_${suite.replace(/-/g, "_")}`;
const serverId = `composio-${toolkit}`;
const toolName = "SHOP_LIST_ORDERS";
const ref = `${serverId}/${toolName}`;

const admin: AgentActor = { id: `${suite}-admin`, role: "admin" };
const teammate: AgentActor = { id: `${suite}-teammate`, role: "user" };
let agentId = "";

/** Every call that got past every gate and reached the vendor. */
const reached: { actorId?: string }[] = [];

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null } as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker: {} as ComposioBroker,
  callVendor: async (connection) => {
    reached.push({ actorId: connection.actorId });
    return { text: "two orders", isError: false };
  },
});
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);

let releaseRoleWriter: (() => Promise<void>) | undefined;
const as = <T>(actor: AgentActor, fn: () => T): T => runAsTenant(actor.id, fn);

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database.insert(users).values(
      [admin, teammate].map((person) => ({
        id: person.id,
        email: `${person.id}@example.test`,
      })),
    );
    await setRole(database, admin.id, "admin");
    await database.insert(mcpServers).values({
      id: serverId,
      tenantId: "team",
      title: "Shop",
      vendor: "Composio",
      url: `composio://${toolkit}`,
      provenance: "composio",
      authScheme: DEPLOYMENT_CLIENT_SCHEME,
    });
    await database.insert(mcpTools).values({
      serverId,
      tenantId: "team",
      name: toolName,
      description: "Lists the store's orders.",
      effect: "read",
    });
  });
  // A Team Bot the administrator owns, granted the app's read action.
  const profile = await as(admin, () =>
    profiles.create(admin, {
      name: "Shop Desk",
      title: "Commerce",
      roleDescription: "Answers order questions.",
      visibility: "public",
    }),
  );
  agentId = profile.id;
  await as(admin, () => store.grant("mcp", ref, agentId, admin.id));
  // The administrator's own account on the deployment's client, made while they were one.
  await as(admin, () =>
    database.insert(composioConnections).values({
      toolkit,
      userId: admin.id,
    }),
  );
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(composioConnections)
      .where(eq(composioConnections.toolkit, toolkit));
    if (agentId) await database.delete(agents).where(eq(agents.id, agentId));
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
    await database
      .delete(users)
      .where(inArray(users.id, [admin.id, teammate.id]));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

const ownCall = () =>
  as(admin, () =>
    store.callTool({ ref, args: {}, botId: agentId, actorId: admin.id }),
  );
/**
 * A teammate's call through the Team Bot, on the owner's account (`credentialActorFor`).
 *
 * In the teammate's own frame, row security already keeps the owner's connection row out of reach,
 * so that call never goes out. A frame that reads every row (`platform`, where the deployment's own
 * background work runs) does reach it, and that is where the check this suite is about is the only
 * thing standing between a demoted owner's account and the call.
 */
const teammateCall = (frame: "teammate" | "platform") => {
  const work = () =>
    store.callTool({
      ref,
      args: {},
      botId: agentId,
      actorId: teammate.id,
      credentialActorId: admin.id,
    });
  return frame === "platform" ? asPlatform(work) : as(teammate, work);
};

describe("an account on the deployment's own client, once its maker is no longer an admin", () => {
  test("while they are an administrator, their calls go out on their account", async () => {
    reached.length = 0;
    expect((await ownCall()).text).toBe("two orders");
    expect((await teammateCall("platform")).text).toBe("two orders");
    expect(reached).toEqual([{ actorId: admin.id }, { actorId: admin.id }]);
    // And a teammate's own frame never reached the owner's account at all.
    await expect(teammateCall("teammate")).rejects.toBeInstanceOf(
      PluginRefusedError,
    );
    expect(reached).toHaveLength(2);
  });

  test("demoted, their own call is refused before it reaches the vendor, in Chinese", async () => {
    await asPlatform(() => setRole(database, admin.id, "user"));
    reached.length = 0;
    const refused = ownCall();
    await expect(refused).rejects.toBeInstanceOf(PluginRefusedError);
    await expect(refused).rejects.toThrow("已经不是管理员");
    expect(reached).toEqual([]);
  });

  test("and a teammate's call through the Team Bot is refused too", async () => {
    reached.length = 0;
    const refused = teammateCall("platform");
    await expect(refused).rejects.toBeInstanceOf(PluginRefusedError);
    await expect(refused).rejects.toThrow("请管理员重新连接");
    await expect(teammateCall("teammate")).rejects.toBeInstanceOf(
      PluginRefusedError,
    );
    expect(reached).toEqual([]);
  });

  test("made an administrator again, the account works again", async () => {
    await asPlatform(() => setRole(database, admin.id, "admin"));
    reached.length = 0;
    expect((await ownCall()).text).toBe("two orders");
    expect(reached).toEqual([{ actorId: admin.id }]);
  });
});
