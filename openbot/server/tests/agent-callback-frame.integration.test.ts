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
import { REFUSAL_MARKER } from "../src/plugins/tools";
import {
  createTeamBots,
  TEAM_BOT_CONSENT_MARKER,
} from "../src/team-bots/team-bots";
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
/** Whose account each vendor call went out on: the store's credential actor for the call. */
const vendorAccounts: string[] = [];
const plugins = createPluginStore({
  database,
  auditStore,
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async (target) => {
    vendorFrames.push(currentTenant());
    vendorAccounts.push(target.actorId ?? "");
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

/** Which servers each person has their own account on, for the Team Bot consent rule. */
const connected = new Map<string, Set<string>>();
/** The real Team Bots service: publication, consent, and whose account a Team Bot's call uses. */
const teamBots = createTeamBots({
  database,
  connectedServers: async (userId) => connected.get(userId) ?? new Set(),
});

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const LEGACY_TOKEN = `legacy-${randomUUID()}`;

/** The real route, with the real stores in the positions `createApp` takes them. */
function appWith(environment: Record<string, string>) {
  return createApp(
    loadConfig(testEnvironment({ KEY_ENCRYPTION_KEY: KEY, ...environment })),
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { teamBots },
  );
}
const app = appWith({});
/** The same route on a deployment that also accepts the deployment-wide token. */
const legacyApp = appWith({ AGENT_TOOL_TOKEN: LEGACY_TOKEN });

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

/** A private Bot its owner then publishes to the whole team, as the Team Bots page does. */
async function createTeamBot() {
  const bot = await createBot("private");
  await as(owner, () =>
    teamBots.publish(owner, bot.botId, {
      audience: "team",
      emails: [],
      groups: [],
    }),
  );
  return bot;
}

/** Whose account the in-process door's call to this suite's tool goes out on, for `actor`. */
function inProcessAccount(actor: AgentActor, botId: string) {
  return as(actor, () => teamBots.credentialActorFor(actor.id, botId)(toolRef));
}

/** One callback, exactly as an external agent sends it: token header, signed run, no session. */
async function callBack(
  token: string,
  botId: string,
  actorId: string,
  via = app,
) {
  const response = await via.request(
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

describe("a `team` Bot's callback reaches the account its in-process turn would (G01-E PCB2)", () => {
  test("a teammate's call goes out on the owner's account where the owner connected it", async () => {
    const { botId, token } = await createTeamBot();
    connected.set(owner.id, new Set([server]));
    connected.set(teammate.id, new Set([server]));
    // What the in-process door decides for this Bot, this person and this tool.
    expect(await inProcessAccount(teammate, botId)).toBe(owner.id);
    vendorFrames.length = 0;
    vendorAccounts.length = 0;

    const { status, body } = await underThrowGuard(() =>
      callBack(token, botId, teammate.id),
    );

    expect(status).toBe(200);
    expect(body.isError).toBe(false);
    expect(body.text).toContain("ledger line 42");
    // The owner's account, in the teammate's frame, with the teammate's name on the row.
    expect(vendorAccounts).toEqual([owner.id]);
    expect(vendorFrames).toEqual([teammate.id]);
    expect(await callRows(botId)).toEqual([
      { eventType: "mcp.call_succeeded", tenantId: teammate.id },
    ]);
  });

  test("a teammate's call is refused for consent where only their own account is connected, and spends a one-time consent once", async () => {
    const { botId, token } = await createTeamBot();
    connected.set(owner.id, new Set());
    connected.set(teammate.id, new Set([server]));
    vendorAccounts.length = 0;

    const refused = await callBack(token, botId, teammate.id);

    expect(refused.status).toBe(200);
    expect(refused.body.isError).toBe(true);
    expect(refused.body.text).toStartWith(
      `${REFUSAL_MARKER} ${TEAM_BOT_CONSENT_MARKER}`,
    );
    // Nothing was sent, and nothing was called: the refusal comes before the store's call.
    expect(vendorAccounts).toEqual([]);
    expect(await callRows(botId)).toEqual([]);

    await as(teammate, () =>
      teamBots.consent(teammate, botId, server, "allow_once"),
    );
    const allowed = await callBack(token, botId, teammate.id);
    const again = await callBack(token, botId, teammate.id);

    expect(allowed.body.isError).toBe(false);
    expect(vendorAccounts).toEqual([teammate.id]);
    expect(again.body.isError).toBe(true);
    expect(again.body.text).toStartWith(
      `${REFUSAL_MARKER} ${TEAM_BOT_CONSENT_MARKER}`,
    );
    expect(vendorAccounts).toEqual([teammate.id]);
  });

  test("a server nobody has their own account on, and the owner's own call, go out as the asker", async () => {
    const { botId, token } = await createTeamBot();
    connected.set(owner.id, new Set());
    connected.set(teammate.id, new Set());
    vendorAccounts.length = 0;

    const shared = await callBack(token, botId, teammate.id);
    connected.set(owner.id, new Set([server]));
    const own = await callBack(token, botId, owner.id);

    expect([shared.body.isError, own.body.isError]).toEqual([false, false]);
    expect(vendorAccounts).toEqual([teammate.id, owner.id]);
  });

  test("a tool the Bot was never given is still refused and recorded by the store, spending no consent", async () => {
    const { botId, token } = await createTeamBot();
    connected.set(owner.id, new Set());
    connected.set(teammate.id, new Set([server]));
    await as(teammate, () =>
      teamBots.consent(teammate, botId, server, "allow_once"),
    );
    vendorAccounts.length = 0;

    const response = await app.request(
      "http://openbot.local/api/agent-tools/call",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": token,
        },
        body: JSON.stringify({
          name: `mcp__${server}__erase`,
          args: {},
          run: mintRunAssertion(
            { botId, actorId: teammate.id, runId: `${suite}-${randomUUID()}` },
            KEY,
          ),
        }),
      },
    );
    const body = (await response.json()) as { text?: string };

    expect(body.text).toBe(
      `${REFUSAL_MARKER} This Bot has not been given the tool ${server}/erase.`,
    );
    const [rejected] = await asPlatform(() =>
      database
        .select({ tenantId: auditEvents.tenantId })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "mcp.call_rejected"),
            eq(auditEvents.targetId, `${server}/erase`),
            sql`${auditEvents.payload}->>'bot' = ${botId}`,
          ),
        ),
    );
    expect(rejected?.tenantId).toBe(teammate.id);
    // The one-time consent is still there for the granted tool's call.
    const granted = await callBack(token, botId, teammate.id);
    expect(granted.body.isError).toBe(false);
    expect(vendorAccounts).toEqual([teammate.id]);
  });

  test("a private Bot and the deployment-wide token are unchanged: the asker's account", async () => {
    const privateBot = await createBot("private");
    const teamBot = await createTeamBot();
    connected.set(owner.id, new Set([server]));
    connected.set(teammate.id, new Set([server]));
    vendorAccounts.length = 0;

    const answers = await underThrowGuard(async () => [
      await callBack(privateBot.token, privateBot.botId, owner.id),
      // The deployment-wide token proves no Bot of its own, so it never borrows an owner's account.
      await callBack(LEGACY_TOKEN, teamBot.botId, teammate.id, legacyApp),
    ]);

    expect(answers.map((answer) => answer.body.isError)).toEqual([
      false,
      false,
    ]);
    expect(vendorAccounts).toEqual([owner.id, teammate.id]);
  });
});
