import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  appAccessRequests,
  mcpServers,
  mcpTools,
  pluginGrants,
  teamBotPublications,
  users,
} from "../src/db/schema";
import type { ComposioBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  type AppAccessRequestRecord,
  appAccessScopeNote,
  createPluginStore,
} from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 申请访问在 Team Bot 上的批准范围（X2 评审 M3，在 X3 处理）。
 *
 * 队友为一位已发布的 Team Bot 申请授予，管理员批准后授予写在员工身上，整个 Team Bot 都拿到它——这是上游的
 * 设计，行为不改。这里断言的是管理员看得到这一点：收件箱的条目与批准的响应都说明批准对整个 Team Bot 生效
 * （`appliesTo`、`scopeNote`），并标明申请人是员工的主人还是 Team Bot 的队友（`requesterRole`）。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `tbs-${suite}-${name}`;
const OWNER = id("owner");
const TEAMMATE = id("teammate");
const ADMIN = id("admin");
const people = [OWNER, TEAMMATE, ADMIN];
const BOT = id("bot");
const TEAM_BOT = id("team-bot");
const bots = [BOT, TEAM_BOT];
const APP = `tbs_mail_${suite.replace(/-/g, "_")}`;
let releaseRoleWriter: (() => Promise<void>) | undefined;

const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null } as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});
const adminScope = createAdminScope({
  roleRepository: createRoleRepository(database),
});

function as(actorId: string) {
  const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actorId,
      email: `${actorId}@example.test`,
      role: actorId === ADMIN ? "admin" : "user",
    } as never);
    await runAsTenant(actorId, () => next());
  };
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      plugins,
      session,
      async () => true,
      {
        publicUrl: "https://openbot.example",
        appUrl: "https://app.example",
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      },
      { broker: { listApps: async () => [] } as unknown as ComposioBroker },
      adminScope,
    ),
  );
}

const ask = async (actor: string, agentId: string) => {
  const response = await as(actor).request("/api/plugins/access-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId, app: APP }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { request: AppAccessRequestRecord })
    .request;
};

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database
      .insert(users)
      .values(
        people.map((person) => ({ id: person, email: `${person}@x.test` })),
      );
    await setRole(database, ADMIN, "admin");
    await database.insert(mcpServers).values({
      id: APP,
      tenantId: "team",
      title: "Mail",
      vendor: "Composio",
      url: `composio://${APP}`,
      provenance: "composio",
      authScheme: "OAUTH2",
    });
    await database.insert(mcpTools).values({
      serverId: APP,
      tenantId: "team",
      name: "LIST",
      description: "Lists.",
      effect: "read",
      version: "20260903_00",
    });
    for (const [bot, tenant] of [
      [BOT, OWNER],
      [TEAM_BOT, "team"],
    ] as const) {
      await database.insert(agents).values({
        id: bot,
        tenantId: tenant,
        name: bot,
        type: "built_in",
        configuration: {},
      });
      await database.insert(agentProfiles).values({
        agentId: bot,
        tenantId: tenant,
        ownerUserId: OWNER,
        title: bot,
        roleDescription: "测试员工",
        avatarSeed: bot,
        visibility: "private",
      });
    }
    await database.insert(teamBotPublications).values({
      agentId: TEAM_BOT,
      tenantId: "team",
      publishedBy: OWNER,
      audience: "team",
    });
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(appAccessRequests)
      .where(inArray(appAccessRequests.botId, bots));
    await database.delete(agents).where(inArray(agents.id, bots));
    await database.delete(mcpServers).where(eq(mcpServers.id, APP));
    await database.delete(users).where(inArray(users.id, people));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

describe("who an approval reaches, as the administrator reads it", () => {
  test("a teammate's request on a Team Bot says the approval reaches the whole Team Bot", async () => {
    const filed = await ask(TEAMMATE, TEAM_BOT);
    expect(filed).toMatchObject({
      appliesTo: "team_bot",
      requesterRole: "teammate",
    });
    expect(filed.scopeNote).toContain("批准将对整个 Team Bot 生效");
    expect(filed.scopeNote).toContain("队友");

    const inbox = (await (
      await as(ADMIN).request("/api/plugins/access-requests")
    ).json()) as { requests: AppAccessRequestRecord[] };
    const listed = inbox.requests.find((request) => request.id === filed.id);
    expect(listed).toMatchObject({
      appliesTo: "team_bot",
      requesterRole: "teammate",
      scopeNote: filed.scopeNote,
    });

    const approved = await as(ADMIN).request(
      `/api/plugins/access-requests/${filed.id}/approve`,
      { method: "POST" },
    );
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as {
      request: AppAccessRequestRecord;
      granted: string[];
    };
    expect(body.request).toMatchObject({
      status: "approved",
      appliesTo: "team_bot",
      requesterRole: "teammate",
    });
    expect(body.request.scopeNote).toContain("整个 Team Bot");
    // 行为不变：授予写在 Team Bot 身上。
    expect(body.granted).toEqual([`${APP}/LIST`]);
    expect(
      await asPlatform(() =>
        database
          .select({ ref: pluginGrants.ref })
          .from(pluginGrants)
          .where(
            and(
              eq(pluginGrants.agentId, TEAM_BOT),
              eq(pluginGrants.ref, `${APP}/LIST`),
            ),
          ),
      ),
    ).toHaveLength(1);
  });

  test("the owner's own request on their Team Bot is marked as the owner's, and still reaches everybody", async () => {
    await asPlatform(() =>
      database.delete(pluginGrants).where(eq(pluginGrants.agentId, TEAM_BOT)),
    );
    const filed = await ask(OWNER, TEAM_BOT);
    expect(filed).toMatchObject({
      appliesTo: "team_bot",
      requesterRole: "owner",
    });
    expect(filed.scopeNote).toContain("员工的主人");
  });

  test("a request on a private Bot carries no Team Bot note", async () => {
    const filed = await ask(OWNER, BOT);
    expect(filed).toMatchObject({
      appliesTo: "bot",
      requesterRole: "owner",
      scopeNote: null,
    });
  });

  test("the note is said only for a Team Bot", () => {
    expect(appAccessScopeNote("bot", "teammate")).toBeNull();
    expect(appAccessScopeNote("team_bot", "other")).toContain(
      "批准将对整个 Team Bot 生效",
    );
  });
});
