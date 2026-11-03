import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  mintCallbackToken,
  mintRunAssertion,
} from "../src/agents/callback-token";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  users,
} from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { createPluginStore } from "../src/plugins/store";
import { asPlatform, currentTenant, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
import { underThrowGuard } from "./support/frame-guard";

/**
 * THE CALLBACK ROUTE FINDS ITS BOT UNDER ROW SECURITY, AND RUNS THE CALL IN THE RIGHT FRAME (G01-E PCB).
 *
 * `/api/agent-tools/call` has a credential instead of a session, so nothing frames it when it asks
 * which Bot holds the presented token. Asked outside every frame, that question is the legacy
 * `system` answer, and `system` sees neither a person's private Bot nor a `team` Bot: every external
 * agent's tool call was refused as an unknown token, for every Bot that is not in the catalogue. And
 * under `OPENBOT_TENANT_FRAME_GUARD=throw` (what P15 makes the default) the question threw.
 *
 * The route, the token lookup, the profile store, the plugin store (grants, policy, audit) and the
 * audit store are the real ones, against PostgreSQL; only the vendor is a stub.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const auditStore = createAuditStore(database);
/** Which frame each vendor call went out from. */
const vendorFrames: string[] = [];
const plugins = createPluginStore({
  database,
  auditStore,
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async () => {
    vendorFrames.push(currentTenant());
    return { text: "ledger line 42", isError: false };
  },
});

const suite = `pcb-${randomUUID().slice(0, 8)}`;
const owner: AgentActor = { id: `${suite}-owner`, role: "user" };
const teammate: AgentActor = { id: `${suite}-teammate`, role: "user" };
const stranger: AgentActor = { id: `${suite}-stranger`, role: "user" };
const people = [owner, teammate, stranger];
const server = `${suite}-server`;
const toolRef = `${server}/lookup`;
const toolName = `mcp__${server}__lookup`;
const createdAgentIds: string[] = [];

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const config = loadConfig(testEnvironment({ KEY_ENCRYPTION_KEY: KEY }));

/** The real route, with the real stores in the positions `createApp` takes them. */
const app = createApp(
  config,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  profiles,
  undefined,
  undefined,
  auditStore,
  undefined,
  plugins,
);

const as = <T>(actor: AgentActor, fn: () => T): T => runAsTenant(actor.id, fn);

/** A Bot made by the owner in their own frame; `public` is `team` from its first commit (P8b). */
async function createBot(visibility: "public" | "private") {
  const profile = await as(owner, () =>
    profiles.create(owner, {
      name: "Ledger Desk",
      title: "Finance",
      roleDescription: "Answers ledger questions.",
      visibility,
    }),
  );
  createdAgentIds.push(profile.id);
  await as(owner, () => plugins.grant("mcp", toolRef, profile.id, owner.id));
  const token = await as(owner, () =>
    profiles.issueCallbackToken(owner, profile.id),
  );
  return { botId: profile.id, token };
}

/** One callback, exactly as an external agent sends it: token header, signed run, no session. */
async function callBack(token: string, botId: string, actorId: string) {
  const response = await app.request(
    "http://openbot.local/api/agent-tools/call",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": token,
      },
      body: JSON.stringify({
        name: toolName,
        args: {},
        run: mintRunAssertion(
          { botId, actorId, runId: `${suite}-${randomUUID()}` },
          KEY,
        ),
      }),
    },
  );
  const body = (await response.json()) as {
    text?: string;
    isError?: boolean;
    error?: string;
  };
  return { status: response.status, body };
}

/**
 * The tool-call rows (`mcp.call_*`) this suite's tool left for one Bot, with each row's stamp. The
 * fixture's own grant row (`configuration.changed`, in the owner's frame) is not a call.
 */
function callRows(botId: string) {
  return asPlatform(() =>
    database
      .select({
        eventType: auditEvents.eventType,
        tenantId: auditEvents.tenantId,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetId, toolRef),
          sql`${auditEvents.eventType} like 'mcp.call_%'`,
          sql`${auditEvents.payload}->>'bot' = ${botId}`,
        ),
      ),
  );
}

/** The refusal rows the route writes for a caller that proved no Bot, for this suite's tool. */
function refusalRows() {
  return asPlatform(() =>
    database
      .select({
        tenantId: auditEvents.tenantId,
        refusal: sql<string>`${auditEvents.payload}->>'refusal'`,
        status: sql<number>`(${auditEvents.payload}->>'status')::int`,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "mcp.callback_refused"),
          eq(auditEvents.targetId, toolName),
        ),
      ),
  );
}

beforeAll(async () => {
  await asPlatform(async () => {
    await database.insert(users).values(
      people.map((person) => ({
        id: person.id,
        email: `${person.id}@example.test`,
      })),
    );
    // A server every person reads (`team`, as P10 stamps them), with one tool and no credential.
    await database.insert(mcpServers).values({
      id: server,
      tenantId: TEAM_TENANT,
      title: "Ledger server",
      vendor: "Test",
      url: "https://mcp.example.invalid/ledger",
      provenance: "custom",
    });
    await database.insert(mcpTools).values({
      serverId: server,
      tenantId: TEAM_TENANT,
      name: "lookup",
      description: "Looks up a ledger line.",
      effect: "read",
    });
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    if (createdAgentIds.length > 0) {
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, createdAgentIds));
      await database.delete(agents).where(inArray(agents.id, createdAgentIds));
    }
    await database.delete(mcpServers).where(eq(mcpServers.id, server));
    await database.delete(users).where(
      inArray(
        users.id,
        people.map((person) => person.id),
      ),
    );
  });
  await database.$client.close();
});

describe("a callback with a Bot's own token", () => {
  test("for a person's private Bot, succeeds and is recorded in that person's tenant", async () => {
    const { botId, token } = await createBot("private");
    vendorFrames.length = 0;

    const { status, body } = await callBack(token, botId, owner.id);

    expect(status).toBe(200);
    expect(body.isError).toBe(false);
    expect(body.text).toContain("ledger line 42");
    expect(vendorFrames).toEqual([owner.id]);
    expect(await callRows(botId)).toEqual([
      { eventType: "mcp.call_succeeded", tenantId: owner.id },
    ]);
  });

  test("for a `team` Bot, a teammate's run succeeds and is recorded in the teammate's tenant", async () => {
    const { botId, token } = await createBot("public");
    // The Bot and its grant are `team`: neither is anybody's frame.
    const [stamp] = await asPlatform(() =>
      database
        .select({ tenantId: agentProfiles.tenantId })
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, botId)),
    );
    expect(stamp?.tenantId).toBe(TEAM_TENANT);
    vendorFrames.length = 0;

    const { status, body } = await callBack(token, botId, teammate.id);

    expect(status).toBe(200);
    expect(body.isError).toBe(false);
    expect(body.text).toContain("ledger line 42");
    // The asker's frame, which is where an in-process turn for this teammate runs its tools too.
    expect(vendorFrames).toEqual([teammate.id]);
    expect(await callRows(botId)).toEqual([
      { eventType: "mcp.call_succeeded", tenantId: teammate.id },
    ]);
  });

  test("for a person's private Bot, a run naming somebody else is refused before any grant is read", async () => {
    const { botId, token } = await createBot("private");
    vendorFrames.length = 0;

    const { status, body } = await callBack(token, botId, stranger.id);

    expect(status).toBe(403);
    expect(body.error).toBe("Not authorised.");
    expect(vendorFrames).toEqual([]);
    expect(await callRows(botId)).toEqual([]);
  });

  test("runs with no unframed fallback: OPENBOT_TENANT_FRAME_GUARD=throw", async () => {
    const privateBot = await createBot("private");
    const teamBot = await createBot("public");
    vendorFrames.length = 0;

    const answers = await underThrowGuard(async () => [
      await callBack(privateBot.token, privateBot.botId, owner.id),
      await callBack(teamBot.token, teamBot.botId, teammate.id),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(answers.map((answer) => answer.body.isError)).toEqual([
      false,
      false,
    ]);
    expect(vendorFrames).toEqual([owner.id, teammate.id]);
    expect(await callRows(privateBot.botId)).toEqual([
      { eventType: "mcp.call_succeeded", tenantId: owner.id },
    ]);
    expect(await callRows(teamBot.botId)).toEqual([
      { eventType: "mcp.call_succeeded", tenantId: teammate.id },
    ]);
  });
});

describe("a callback whose token proves no Bot", () => {
  test("a wrong token and a revoked one are refused, each with the route's refusal record", async () => {
    const { botId, token } = await createBot("private");
    await as(owner, () => profiles.revokeCallbackToken(owner, botId));
    vendorFrames.length = 0;

    const answers = await underThrowGuard(async () => [
      await callBack(mintCallbackToken(), botId, owner.id),
      await callBack(token, botId, owner.id),
    ]);

    expect(answers).toEqual([
      { status: 401, body: { error: "Not authorised." } },
      { status: 401, body: { error: "Not authorised." } },
    ]);
    expect(vendorFrames).toEqual([]);
    expect(await callRows(botId)).toEqual([]);
    // Nobody's: the caller proved no person, so the row is the platform's. This tool's name is
    // this suite's own, and these are the only two callers here that prove no Bot.
    expect(await refusalRows()).toEqual([
      { tenantId: "platform", refusal: "Not authorised.", status: 401 },
      { tenantId: "platform", refusal: "Not authorised.", status: 401 },
    ]);
  });
});
