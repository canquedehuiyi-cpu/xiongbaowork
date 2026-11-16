import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { decryptOAuthToken, setTokenUtil } from "better-auth/oauth2";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  exportJWK,
  generateKeyPair,
  type JWK,
  jwtVerify,
  type KeyObject,
  SignJWT,
} from "jose";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { createAuth } from "../src/auth";
import { createEntra, withEntraBearer } from "../src/auth/entra";
import { createRoleRepository } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import { createCredentialStore, sealCredential } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  agents,
  auditEvents,
  credentials,
  mcpServers,
  mcpTools,
  revokedAccess,
  users,
} from "../src/db/schema";
import { createPeopleStore } from "../src/people/store";
import { openBotResources } from "../src/plugins/entra-access";
import {
  CustomServerRefusedError,
  createPluginStore,
  PluginRefusedError,
} from "../src/plugins/store";
import { grantedTools, REFUSAL_MARKER } from "../src/plugins/tools";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
import { afterAll, beforeAll, test } from "./support/platform-frame";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * A company system behind Microsoft Entra, reached as the signed-in person: the plugin-store half
 * (上游 #931 的后半部分，X6 并入). The sign-in half, an app calling OpenBot with a person's token, is
 * `entra-obo.integration.test.ts`; this file stands up the same stand-in Entra and HR system on its
 * own ports and asks what a server an admin marked with an Entra scope does.
 *
 * Two doors in and one way out. A person's app calls OpenBot with their Entra token, and a routine
 * runs with nobody in the browser at all; either way a server an admin marked with an Entra scope is
 * called with a token Entra issued for that person through the on-behalf-of exchange.
 *
 * Entra is a stand-in that answers as Entra does: the published keys, the refresh grant with a
 * rotated refresh token, the on-behalf-of grant checked for its grant type, `requested_token_use`
 * and an assertion addressed to OpenBot, and the three refusals a person can meet (an expired
 * sign-in, missing consent, an API OpenBot's registration does not expose), in Entra's own error
 * shape. The system is a real MCP server built with the official SDK that checks the bearer it is
 * sent. Both are reached at their real addresses through `fetch`, which forwards them to 127.0.0.1.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const tag = randomUUID().slice(0, 8);

const TENANT = randomUUID();
const CLIENT_ID = randomUUID();
const CLIENT_SECRET = `secret-${tag}`;
/** The company's own app, the one MICROSOFT_OAUTH_ALLOWED_CLIENTS lists. */
const APP_CLIENT = randomUUID();
const DOWNSTREAM_APP = randomUUID();
const HR_SCOPE = `api://${DOWNSTREAM_APP}/.default`;
const PAYROLL_SCOPE = "api://payroll/.default";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const ENTRA_PORT = 7485;
const MCP_PORT = 7486;
const HR_HOST = `hr-${tag}.obo.test`;

const email = (name: string) => `${name}-${tag}@obo.test`;
const ADMIN = email("ada");

let signingKey: KeyObject | CryptoKey;
let publicJwk: JWK;
const KID = `kid-${tag}`;

/* ---------------------------------------------------------------- Entra, as it answers */

type Directory = {
  /** Live refresh tokens, by token: whose they are and whether Entra still honours them. */
  refreshTokens: Map<string, { oid: string; upn: string; expired?: boolean }>;
  /** Whether OpenBot's app registration exposes an API, so a token to it can be issued at all. */
  apiExposed: boolean;
  /** Whether an admin consented to OpenBot's own API, so its refresh grant may ask for it. */
  apiConsented: boolean;
  /** The systems an admin has granted OpenBot access to. */
  consented: Set<string>;
  /** Every grant the token endpoint was asked for, in order. */
  requests: { grantType: string; scope: string; assertion?: string }[];
};

const entra: Directory = {
  refreshTokens: new Map(),
  apiExposed: true,
  apiConsented: true,
  consented: new Set([HR_SCOPE]),
  requests: [],
};

async function sign(
  claims: Record<string, unknown>,
  options: { expiresIn?: number; key?: KeyObject | CryptoKey } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ ver: "2.0", tid: TENANT, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(now + (options.expiresIn ?? 3600))
    .sign(options.key ?? signingKey);
}

/**
 * A person's token to OpenBot's own API, as Entra issues one to their app: `azp` names the app it
 * was issued to, and `azpacr` how that app proved itself (`0`, a public client such as a SPA).
 */
const tokenToOpenBot = (
  person: { oid: string; upn: string },
  overrides: Record<string, unknown> = {},
  expiresIn?: number,
) =>
  sign(
    {
      iss: ISSUER,
      aud: CLIENT_ID,
      oid: person.oid,
      sub: `sub-${person.oid}`,
      azp: APP_CLIENT,
      azpacr: "0",
      scp: "access_as_user",
      name: person.upn.split("@")[0],
      preferred_username: person.upn,
      ...overrides,
    },
    { expiresIn },
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Entra's error body: the code, the AADSTS sentence, and the numeric codes beside it. */
const refusal = (
  status: number,
  error: string,
  code: number,
  description: string,
  extra: Record<string, unknown> = {},
) =>
  json(
    {
      error,
      error_description: `AADSTS${code}: ${description}\r\nTrace ID: ${randomUUID()}\r\nCorrelation ID: ${randomUUID()}\r\nTimestamp: 2026-10-31 12:00:00Z`,
      error_codes: [code],
      timestamp: "2026-10-31 12:00:00Z",
      trace_id: randomUUID(),
      correlation_id: randomUUID(),
      ...extra,
    },
    status,
  );

async function tokenEndpoint(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type") ?? "";
  const scope = form.get("scope") ?? "";
  entra.requests.push({
    grantType,
    scope,
    ...(form.get("assertion")
      ? { assertion: form.get("assertion") as string }
      : {}),
  });

  if (
    form.get("client_id") !== CLIENT_ID ||
    form.get("client_secret") !== CLIENT_SECRET
  ) {
    return refusal(
      401,
      "invalid_client",
      7000215,
      "Invalid client secret provided.",
    );
  }

  if (grantType === "refresh_token") {
    const held = entra.refreshTokens.get(form.get("refresh_token") ?? "");
    if (!held) {
      return refusal(
        400,
        "invalid_grant",
        9002313,
        "Invalid request. Request is malformed or invalid.",
      );
    }
    if (held.expired) {
      return refusal(
        400,
        "invalid_grant",
        700082,
        "The refresh token has expired due to inactivity.",
      );
    }
    if (scope === `api://${CLIENT_ID}/.default` && !entra.apiExposed) {
      return refusal(
        400,
        "invalid_resource",
        500011,
        `The resource principal named api://${CLIENT_ID} was not found in the tenant named ${TENANT}.`,
      );
    }
    // As Entra answers a refresh grant for a resource nobody consented to.
    if (scope === `api://${CLIENT_ID}/.default` && !entra.apiConsented) {
      return refusal(
        400,
        "invalid_grant",
        65001,
        `The user or administrator has not consented to use the application with ID '${CLIENT_ID}' named 'OpenBot'. Send an interactive authorization request for this user and resource.`,
        { suberror: "consent_required" },
      );
    }
    // Entra rotates: the new refresh token replaces the one it was shown.
    const rotated = `rt-${randomUUID()}`;
    entra.refreshTokens.delete(form.get("refresh_token") ?? "");
    entra.refreshTokens.set(rotated, { oid: held.oid, upn: held.upn });
    return json({
      token_type: "Bearer",
      scope: `api://${CLIENT_ID}/access_as_user`,
      expires_in: 3599,
      ext_expires_in: 3599,
      // Issued to OpenBot itself, which proved itself with its secret.
      access_token: await tokenToOpenBot(held, {
        azp: CLIENT_ID,
        azpacr: "1",
      }),
      refresh_token: rotated,
    });
  }

  if (grantType === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
    if (form.get("requested_token_use") !== "on_behalf_of") {
      return refusal(
        400,
        "invalid_request",
        900144,
        "The request body must contain the following parameter: 'requested_token_use'.",
      );
    }
    let person: { oid: string; upn: string };
    try {
      // The assertion must be addressed to the app making this request, and signed by Entra.
      const { payload } = await jwtVerify(
        form.get("assertion") ?? "",
        async () => publicJwk,
        { issuer: ISSUER, audience: CLIENT_ID },
      );
      person = {
        oid: payload.oid as string,
        upn: payload.preferred_username as string,
      };
    } catch {
      return refusal(
        400,
        "invalid_grant",
        500131,
        "Assertion audience does not match the Client app presenting the assertion.",
      );
    }
    if (!entra.consented.has(scope)) {
      return refusal(
        400,
        "invalid_grant",
        65001,
        `The user or administrator has not consented to use the application with ID '${CLIENT_ID}' named 'OpenBot'. Send an interactive authorization request for this user and resource.`,
        { suberror: "consent_required" },
      );
    }
    return json({
      token_type: "Bearer",
      scope: `api://${DOWNSTREAM_APP}/read`,
      expires_in: 3599,
      ext_expires_in: 3599,
      access_token: await sign({
        iss: ISSUER,
        aud: DOWNSTREAM_APP,
        oid: person.oid,
        azp: CLIENT_ID,
        scp: "read",
        preferred_username: person.upn,
      }),
    });
  }

  return refusal(
    400,
    "unsupported_grant_type",
    70003,
    "The app requested an unsupported grant type.",
  );
}

/* ------------------------------------------------- the company's system, as MCP */

/** Every bearer the system accepted, as the person it named. */
const reached: string[] = [];

async function hrSystem(request: Request): Promise<Response> {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
  let who: string;
  try {
    // What a system behind Entra checks: Entra's signature, the directory, and itself as audience.
    const { payload } = await jwtVerify(bearer ?? "", async () => publicJwk, {
      issuer: ISSUER,
      audience: DOWNSTREAM_APP,
    });
    who = payload.preferred_username as string;
  } catch {
    // The deployment's own token, for the server added without a scope.
    if (bearer === `deployment-token-${tag}`) who = "the deployment";
    else return new Response("Unauthorized", { status: 401 });
  }
  const server = new McpServer({ name: "hr", version: "1.0.0" });
  server.registerTool(
    "whoami",
    { description: "Who this HR system sees calling it." },
    async () => {
      reached.push(who);
      return { content: [{ type: "text", text: `You are ${who}.` }] };
    },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return await transport.handleRequest(request);
}

let entraServer: ReturnType<typeof Bun.serve>;
let mcpServer: ReturnType<typeof Bun.serve>;
const realFetch = globalThis.fetch;

/* ---------------------------------------------------------------- OpenBot */

const config = loadConfig(
  testEnvironment({
    MICROSOFT_OAUTH_CLIENT_ID: CLIENT_ID,
    MICROSOFT_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    MICROSOFT_OAUTH_TENANT_ID: TENANT,
    MICROSOFT_OAUTH_ALLOWED_CLIENTS: APP_CLIENT,
    // The two systems a server may be marked for, each bound to the host its tokens go to (I-2).
    MICROSOFT_OAUTH_OBO_RESOURCES: `api://${DOWNSTREAM_APP}=${HR_HOST},api://payroll=${HR_HOST}`,
    BETTER_AUTH_URL: "http://127.0.0.1:7480",
    INITIAL_ADMIN_EMAILS: ADMIN,
  }),
);
const authConfig = config.auth;
const microsoft = authConfig?.microsoft;
if (!authConfig || !microsoft) throw new Error("Microsoft sign-in is set up");

const auditStore = createAuditStore(database);
/** Every instance below, so Better Auth's sign-in can ask whichever one started it, as index.ts wires it. */
const instances: ReturnType<typeof createEntra>[] = [];
const betterAuth = createAuth(config, database, undefined, auditStore, {
  vouchesForMicrosoftToken: (token) =>
    instances.some((instance) => instance.vouches(token)),
});
/** The admin's Users page, as index.ts wires it: who is removed is read from here. */
const people = createPeopleStore(database, authConfig.initialAdminEmails);
const newEntra = (settings = microsoft) => {
  const instance = createEntra({
    microsoft: settings,
    authConfig,
    auth: betterAuth,
    database,
    isRevoked: (address) => people.isRevoked(address),
  });
  instances.push(instance);
  return instance;
};
const signIn = newEntra();

const credentialReader = createCredentialStore(database);

const storeWith = (tokens?: ReturnType<typeof createEntra>) =>
  createPluginStore({
    database,
    auditStore,
    credentials: credentialReader,
    encryptionKey: config.keyEncryptionKey,
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    /*
     * The HR system's made-up name resolves nowhere, and a server added by URL is dialled through
     * the outbound guard, which asks where a name points before it sends (fork's SSRF/DNS check).
     * A public address keeps the guard in the path; `fetch` above then answers it on 127.0.0.1.
     */
    outboundLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    ...(tokens ? { entra: framed(tokens) } : {}),
  });

const store = storeWith(signIn);

function build() {
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = config;
  args[1] = withEntraBearer(betterAuth, signIn);
  args[2] = createRoleRepository(database);
  args[12] = auditStore;
  args[14] = store;
  return createApp(...args);
}

const app = build();
const api = (path: string, token: string | null, body?: unknown) =>
  app.request(`http://127.0.0.1:7480/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const person = (name: string) => ({ oid: randomUUID(), upn: email(name) });
const ada = person("ada");
const alice = person("alice");
const bob = person("bob");
const cara = person("cara");

const SERVER = `obo-hr-${tag}`;
const PAYROLL = `obo-payroll-${tag}`;
const PLAIN = `obo-plain-${tag}`;
const BOT = `obo-bot-${tag}`;
const DEPLOYMENT_CREDENTIAL = randomUUID();

async function userId(address: string) {
  // Who an address is belongs to nobody's tenant: asked as `platform` (G01).
  const [row] = await asPlatform(() =>
    database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, address)),
  );
  return row?.id ?? null;
}

/**
 * The plugin store's door to Entra, as index.ts hands it over: who a token belongs to and the
 * tokens minted for them are identity rows, read and written as `platform` (G01), while the call
 * that asks for one runs in the person's own frame.
 */
function framed(instance: ReturnType<typeof createEntra>) {
  return {
    tokenFor: (id: string, scope: string) =>
      asPlatform(() => instance.tokenFor(id, scope)),
    resources: microsoft?.oboResources ?? [],
    own: openBotResources(CLIENT_ID, `api://${CLIENT_ID}/.default`),
  };
}

/**
 * How a person who signed in with Microsoft in their browser is left: a user and a Microsoft account
 * from that sign-in, holding their refresh token encrypted the way Better Auth writes it.
 *
 * The user and account come from the real first sign-in (a separate instance, so the token it saw is
 * not remembered by the one under test); the refresh token is what a browser's sign-in adds.
 */
async function signedInWithMicrosoft(who: { oid: string; upn: string }) {
  await newEntra().sessionFrom(
    new Headers({ authorization: `Bearer ${await tokenToOpenBot(who)}` }),
  );
  const id = await userId(who.upn);
  if (!id) throw new Error(`${who.upn} was signed in`);
  const [account] = await asPlatform(() =>
    database
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(eq(accounts.userId, id), eq(accounts.providerId, "microsoft")),
      ),
  );
  if (!account) throw new Error(`${who.upn} has a Microsoft account`);
  const ctx = (await betterAuth.$context) as unknown as Parameters<
    typeof setTokenUtil
  >[1];
  const refreshToken = `rt-${randomUUID()}`;
  entra.refreshTokens.set(refreshToken, who);
  await asPlatform(async () =>
    ctx.internalAdapter.updateAccount(account.id, {
      refreshToken: (await setTokenUtil(refreshToken, ctx)) as string,
    }),
  );
  return id;
}

async function storedRefreshToken(id: string) {
  const ctx = (await betterAuth.$context) as unknown as Parameters<
    typeof decryptOAuthToken
  >[1];
  const [row] = await asPlatform(() =>
    database
      .select({ refreshToken: accounts.refreshToken })
      .from(accounts)
      .where(
        and(eq(accounts.userId, id), eq(accounts.providerId, "microsoft")),
      ),
  );
  return {
    raw: row?.refreshToken ?? null,
    plain: row?.refreshToken
      ? await decryptOAuthToken(row.refreshToken, ctx)
      : null,
  };
}

/**
 * One tool call from a routine: the in-process door a background run takes, with nobody watching,
 * in the person's own frame as a claimed routine runs (`runAsClaimedTenant`).
 */
async function backgroundCall(
  tokens: ReturnType<typeof createEntra>,
  actorId: string,
  serverId = SERVER,
) {
  const work = async () => {
    const [tool] = (
      await grantedTools({
        store: storeWith(tokens),
        botId: BOT,
        actorId,
        initiator: { kind: "routine", id: `routine-${tag}` },
      })
    ).filter((granted) => granted.ref === `${serverId}/whoami`);
    if (!tool) throw new Error(`the Bot holds ${serverId}/whoami`);
    return String(await tool.execute({}));
  };
  // A run attributed to nobody has no frame of its own to open, so it stays in the harness's.
  return actorId ? await runAsTenant(actorId, work) : await work();
}

/** A first sign-in writes the person's role through the restricted role writer, as index.ts binds it. */
let releaseRoleWriter: (() => Promise<void>) | undefined;

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  // As Entra publishes its keys: a kid and a use, and no `alg`.
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, use: "sig" };

  entraServer = Bun.serve({
    hostname: "127.0.0.1",
    port: ENTRA_PORT,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith("/discovery/v2.0/keys"))
        return json({ keys: [publicJwk] });
      if (pathname.endsWith("/oauth2/v2.0/token"))
        return await tokenEndpoint(request);
      return new Response("Not found", { status: 404 });
    },
  });
  mcpServer = Bun.serve({
    hostname: "127.0.0.1",
    port: MCP_PORT,
    fetch: hrSystem,
  });

  // Entra and the HR system at their real addresses, answered on 127.0.0.1.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(input as string, init);
    const url = new URL(request.url);
    const port =
      url.hostname === "login.microsoftonline.com"
        ? ENTRA_PORT
        : url.hostname === HR_HOST
          ? MCP_PORT
          : null;
    if (port === null) return realFetch(request);
    const local = new URL(
      `${url.pathname}${url.search}`,
      `http://127.0.0.1:${port}`,
    );
    return realFetch(new Request(local, request));
  }) as typeof fetch;

  // The deployment's Bot is a catalogue row every person reads (`system`).
  await runAsTenant("system", async () => {
    await database
      .insert(agents)
      .values({ id: BOT, name: BOT, type: "remote_ag_ui", configuration: {} });
  });
  // A server added by URL is the team's, and so is its token (G01-E P10): sealed to `team`.
  await database.insert(credentials).values({
    id: DEPLOYMENT_CREDENTIAL,
    tenantId: "team",
    kind: "mcp",
    provider: PLAIN,
    keyId: `mcp-${PLAIN}`,
    // Sealed to the row it is written as, the way the vault writes one (v2 envelope).
    encryptedValue: await sealCredential(
      config.keyEncryptionKey,
      { tenantId: "team", id: DEPLOYMENT_CREDENTIAL, kind: "mcp" },
      `deployment-token-${tag}`,
    ),
    metadata: {},
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  entraServer?.stop(true);
  mcpServer?.stop(true);
  await database.delete(mcpServers).where(like(mcpServers.id, `obo-%-${tag}`));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database
    .delete(credentials)
    .where(inArray(credentials.id, [DEPLOYMENT_CREDENTIAL]));
  await database.delete(users).where(like(users.email, `%-${tag}@obo.test`));
  await database
    .delete(revokedAccess)
    .where(like(revokedAccess.email, `%-${tag}@obo.test`));
  await releaseRoleWriter?.();
  await database.$client.end({ timeout: 5 });
});

/* ---------------------------------------------------------------- the tests */

describe("a server an admin marked as reached as the signed-in person", () => {
  test("an admin marks a server as reached as the signed-in person, and it is asked what it offers as them", async () => {
    const response = await api(
      "/plugins/servers/custom",
      await tokenToOpenBot(ada),
      {
        id: SERVER,
        title: "HR",
        url: `https://${HR_HOST}/mcp`,
        entraScope: HR_SCOPE,
      },
    );
    expect(response.status).toBe(200);
    const { server } = (await response.json()) as {
      server: {
        entraScope: string;
        tools: { ref: string }[];
        lastError: string | null;
      };
    };
    expect(server.entraScope).toBe(HR_SCOPE);
    expect(server.lastError).toBeNull();
    expect(server.tools.map((tool) => tool.ref)).toEqual([`${SERVER}/whoami`]);
    expect(reached).toEqual([]);
    // The deployment's Bot is a `system` row, so its grants are too.
    await runAsTenant("system", () =>
      store.grant("mcp", `${SERVER}/whoami`, BOT, ADMIN),
    );
  });

  test("re-adding it the way the app's add-by-URL request does keeps it reached as the signed-in person", async () => {
    // What the app's add-by-URL request sends: no `entraScope`, which it knows nothing of.
    const response = await api(
      "/plugins/servers/custom",
      await tokenToOpenBot(ada),
      { id: SERVER, title: "HR", url: `https://${HR_HOST}/mcp` },
    );
    expect(response.status).toBe(200);
    const { server } = (await response.json()) as {
      server: { entraScope: string | null; lastError: string | null };
    };
    expect(server.entraScope).toBe(HR_SCOPE);
    // And it was asked what it offers as the admin, as a marked server is, not on a missing token.
    expect(server.lastError).toBeNull();
  });

  test("a scope that is not a string is refused at the door", async () => {
    const response = await api(
      "/plugins/servers/custom",
      await tokenToOpenBot(ada),
      {
        id: `obo-shape-${tag}`,
        title: "Shape",
        url: `https://${HR_HOST}/mcp`,
        entraScope: 42,
      },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Entra scope 必须是非空字符串；传 null 表示不再以登录人的身份访问这个服务器。",
    );
  });

  test("two people each reach the system as themselves, on the token their app sent", async () => {
    const aliceToken = await tokenToOpenBot(alice);
    const bobToken = await tokenToOpenBot(bob);
    const asked = entra.requests.length;

    const forAlice = await api("/plugins/call", aliceToken, {
      ref: `${SERVER}/whoami`,
      agentId: BOT,
      args: {},
    });
    const forBob = await api("/plugins/call", bobToken, {
      ref: `${SERVER}/whoami`,
      agentId: BOT,
      args: {},
    });

    expect(forAlice.status).toBe(200);
    expect(((await forAlice.json()) as { text: string }).text).toContain(
      `You are ${alice.upn}.`,
    );
    expect(forBob.status).toBe(200);
    expect(((await forBob.json()) as { text: string }).text).toContain(
      `You are ${bob.upn}.`,
    );

    // On behalf of each, with the token each one's app sent as the assertion.
    expect(entra.requests.slice(asked)).toEqual([
      {
        grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        scope: HR_SCOPE,
        assertion: aliceToken,
      },
      {
        grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        scope: HR_SCOPE,
        assertion: bobToken,
      },
    ]);
  });

  test("the trail names the person, and holds none of the tokens", async () => {
    const aliceId = (await userId(alice.upn)) ?? "";
    const rows = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(sql`${auditEvents.payload}->>'server' = ${SERVER}`);
    // Every call on the trail names the person it reached as, and Alice's names her.
    expect(
      rows.some(
        (row) => (row.payload as { reachedAs?: string }).reachedAs === aliceId,
      ),
    ).toBe(true);
    // And nothing that looks like a token went with any of them.
    expect(JSON.stringify(rows)).not.toMatch(/eyJ[\w-]+\.[\w-]+\./);
  });

  test("a second call reuses the person's token until it is close to expiring", async () => {
    const asked = entra.requests.length;
    const response = await api("/plugins/call", await tokenToOpenBot(alice), {
      ref: `${SERVER}/whoami`,
      agentId: BOT,
      args: {},
    });
    expect(((await response.json()) as { text: string }).text).toContain(
      `You are ${alice.upn}.`,
    );
    expect(entra.requests.length).toBe(asked);
  });
});

describe("a routine reaches the system as its person, with nobody in the browser", () => {
  test("the token is minted from the person's stored Microsoft sign-in, and the rotated refresh token is stored back", async () => {
    const caraId = await signedInWithMicrosoft(cara);
    const before = await storedRefreshToken(caraId);
    const asked = entra.requests.length;

    // A fresh instance has seen no token from anybody's app: this is the stored sign-in alone.
    const answer = await backgroundCall(newEntra(), caraId);
    expect(answer).toContain(`You are ${cara.upn}.`);

    const grants = entra.requests.slice(asked);
    expect(
      grants.map(({ grantType, scope }) => ({ grantType, scope })),
    ).toEqual([
      { grantType: "refresh_token", scope: `api://${CLIENT_ID}/.default` },
      {
        grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        scope: HR_SCOPE,
      },
    ]);

    const after = await storedRefreshToken(caraId);
    expect(after.plain).not.toBe(before.plain);
    // The one Entra now honours, and still encrypted the way Better Auth writes it.
    expect(entra.refreshTokens.get(after.plain ?? "")?.oid).toBe(cara.oid);
    expect(after.raw).not.toBe(after.plain);
    expect(after.raw ?? "").not.toContain(after.plain ?? "");
  });

  test("a person who never signed in with Microsoft is told so", async () => {
    // Somebody who came in another way, a directory sync say, and has no Microsoft account here.
    const danId = randomUUID();
    await database
      .insert(users)
      .values({ id: danId, email: email("dan"), name: "dan" });
    expect(await backgroundCall(newEntra(), danId)).toBe(
      `${REFUSAL_MARKER} 「HR」要用你的 Microsoft 账号，但熊宝数字员工还没有你的 Microsoft 登录。请先在浏览器里用 Microsoft 登录熊宝数字员工一次，再重新提问。`,
    );
  });

  test("somebody who has only used OpenBot through their app is told to sign in once in the browser", async () => {
    // Signed in from their app's token alone: a user and a Microsoft account, and no refresh token.
    const ivy = person("ivy");
    await newEntra().sessionFrom(
      new Headers({ authorization: `Bearer ${await tokenToOpenBot(ivy)}` }),
    );
    const ivyId = (await userId(ivy.upn)) ?? "";
    expect((await storedRefreshToken(ivyId)).raw).toBeNull();
    // Their routine runs later, in a process that never saw that token (a restart, say).
    expect(await backgroundCall(newEntra(), ivyId)).toBe(
      `${REFUSAL_MARKER} 「HR」要用你的 Microsoft 账号，但熊宝数字员工还没有你的 Microsoft 登录。请先在浏览器里用 Microsoft 登录熊宝数字员工一次，再重新提问。`,
    );
  });

  test("somebody an admin removed stops reaching the system, on a token already held for them or a new one", async () => {
    const jo = person("jo");
    const joId = await signedInWithMicrosoft(jo);
    const tokens = newEntra();
    // Reached once, so a token for HR is held for them, and their stored sign-in still works.
    expect(await backgroundCall(tokens, joId)).toContain(`You are ${jo.upn}.`);

    await people.revoke(joId, ADMIN);
    const asked = entra.requests.length;
    const calls = reached.length;
    expect(await backgroundCall(tokens, joId)).toBe(
      `${REFUSAL_MARKER} 你已经不能使用熊宝数字员工，所以没有使用「HR」。`,
    );
    // Neither the held token nor Entra was asked: nothing reached the system as them.
    expect(entra.requests.length).toBe(asked);
    expect(reached.length).toBe(calls);
  });

  test("an expired Microsoft sign-in is told to sign in again", async () => {
    const eve = person("eve");
    const eveId = await signedInWithMicrosoft(eve);
    for (const held of entra.refreshTokens.values())
      if (held.oid === eve.oid) held.expired = true;
    expect(await backgroundCall(newEntra(), eveId)).toBe(
      `${REFUSAL_MARKER} 你的 Microsoft 登录已过期，所以没有使用「HR」。请重新用 Microsoft 登录后再提问。`,
    );
  });

  test("a system an admin has not granted OpenBot access to in Entra says so", async () => {
    // Added while access was granted, so its tools are known; then an admin withdraws it in Entra.
    entra.consented.add(PAYROLL_SCOPE);
    await store.addCustomServer({
      id: PAYROLL,
      title: "Payroll",
      url: `https://${HR_HOST}/mcp`,
      entraScope: PAYROLL_SCOPE,
      by: ADMIN,
      actorId: (await userId(ADMIN)) ?? "",
    });
    // The deployment's Bot is a `system` row, so its grants are too.
    await runAsTenant("system", () =>
      store.grant("mcp", `${PAYROLL}/whoami`, BOT, ADMIN),
    );
    entra.consented.delete(PAYROLL_SCOPE);

    const fayId = await signedInWithMicrosoft(person("fay"));
    expect(await backgroundCall(newEntra(), fayId, PAYROLL)).toBe(
      `${REFUSAL_MARKER} 管理员还没有在 Microsoft Entra 里授权熊宝数字员工访问「Payroll」。请联系管理员授权。`,
    );
  });

  test("missing consent to OpenBot's own API names OpenBot's API, not the system", async () => {
    const hal = person("hal");
    const halId = await signedInWithMicrosoft(hal);
    entra.apiConsented = false;
    try {
      expect(await backgroundCall(newEntra(), halId)).toBe(
        `${REFUSAL_MARKER} 熊宝数字员工在 Microsoft Entra 里还没有获得对它自己 API 的授权，所以无法以你的身份访问「HR」。请联系管理员授权。`,
      );
    } finally {
      entra.apiConsented = true;
    }
  });

  test("an app registration that exposes no API says so", async () => {
    const gus = person("gus");
    const gusId = await signedInWithMicrosoft(gus);
    entra.apiExposed = false;
    try {
      expect(await backgroundCall(newEntra(), gusId)).toBe(
        `${REFUSAL_MARKER} 熊宝数字员工在 Microsoft Entra 里还没有设置好，无法以你的身份访问「HR」。请管理员在那里公开熊宝数字员工的 API。`,
      );
    } finally {
      entra.apiExposed = true;
    }
  });

  test("a run attributed to nobody is refused before Entra is asked", async () => {
    const asked = entra.requests.length;
    expect(await backgroundCall(newEntra(), "")).toStartWith(REFUSAL_MARKER);
    expect(entra.requests.length).toBe(asked);
  });
});

describe("what does not change", () => {
  test("a server added without a scope is still reached on the deployment's own token", async () => {
    const added = await store.addCustomServer({
      id: PLAIN,
      title: "Plain",
      url: `https://${HR_HOST}/mcp`,
      credentialId: DEPLOYMENT_CREDENTIAL,
      by: ADMIN,
    });
    expect(added.entraScope).toBeNull();
    // The deployment's Bot is a `system` row, so its grants are too.
    await runAsTenant("system", () =>
      store.grant("mcp", `${PLAIN}/whoami`, BOT, ADMIN),
    );
    const asked = entra.requests.length;
    const caraId = (await userId(cara.upn)) ?? "";
    expect(await backgroundCall(newEntra(), caraId, PLAIN)).toContain(
      "You are the deployment.",
    );
    expect(entra.requests.length).toBe(asked);
  });

  test("a scope of null puts a marked server back on the deployment's credential, and a token alone is refused", async () => {
    const id = `obo-switch-${tag}`;
    const url = `https://${HR_HOST}/mcp`;
    await store.addCustomServer({
      id,
      title: "Switch",
      url,
      entraScope: HR_SCOPE,
      by: ADMIN,
      actorId: (await userId(ADMIN)) ?? "",
    });
    // A token sent without saying how it is reached would never be used, so it is refused aloud.
    await expect(
      store.addCustomServer({
        id,
        title: "Switch",
        url,
        credentialId: DEPLOYMENT_CREDENTIAL,
        by: ADMIN,
      }),
    ).rejects.toThrow(
      `${id} 以登录人的身份访问，不收令牌。要改用令牌访问，请同时把 entraScope 设为 null。`,
    );
    const unmarked = await store.addCustomServer({
      id,
      title: "Switch",
      url,
      entraScope: null,
      by: ADMIN,
    });
    expect(unmarked.entraScope).toBeNull();
  });

  test("a marked server is not moved to another address, so nobody's token follows it there", async () => {
    const id = `obo-move-${tag}`;
    await store.addCustomServer({
      id,
      title: "Move",
      url: `https://${HR_HOST}/mcp`,
      entraScope: HR_SCOPE,
      by: ADMIN,
      actorId: (await userId(ADMIN)) ?? "",
    });
    await expect(
      store.addCustomServer({
        id,
        title: "Move",
        url: `https://elsewhere-${tag}.obo.test/mcp`,
        by: ADMIN,
        actorId: (await userId(ADMIN)) ?? "",
      }),
    ).rejects.toThrow(
      `${id} 以登录人的身份访问，已经在另一个地址。要换地址，请先移除再重新添加。`,
    );
    const [row] = await database
      .select({ url: mcpServers.url })
      .from(mcpServers)
      .where(eq(mcpServers.id, id));
    expect(row?.url).toBe(`https://${HR_HOST}/mcp`);
  });

  test("a scope that is not one scope is refused", async () => {
    await expect(
      store.addCustomServer({
        id: `obo-two-${tag}`,
        title: "Two",
        url: `https://${HR_HOST}/mcp`,
        entraScope: "api://hr/.default api://payroll/.default",
        by: ADMIN,
      }),
    ).rejects.toThrow("请只填一个 Entra scope，例如 api://hr-api/.default。");
  });

  test("a server cannot be marked this way where Microsoft sign-in is not set up", async () => {
    const id = `obo-unset-${tag}`;
    await expect(
      storeWith().addCustomServer({
        id,
        title: "Unset",
        url: `https://${HR_HOST}/mcp`,
        entraScope: HR_SCOPE,
        by: ADMIN,
      }),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);
    const [row] = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, id));
    expect(row).toBeUndefined();
  });

  test("a marked server already stored, on a deployment without Microsoft sign-in, is refused rather than called on nobody's token", async () => {
    const caraId = (await userId(cara.upn)) ?? "";
    const calls = reached.length;
    const answer = await runAsTenant(caraId, async () => {
      const [tool] = (
        await grantedTools({
          store: storeWith(),
          botId: BOT,
          actorId: caraId,
          initiator: { kind: "routine", id: `routine-${tag}` },
        })
      ).filter((granted) => granted.ref === `${SERVER}/whoami`);
      return String(await tool?.execute({}));
    });
    expect(answer).toBe(
      `${REFUSAL_MARKER} 「HR」需要 Microsoft 登录，但这里还没有配置。请联系管理员配置。`,
    );
    expect(reached.length).toBe(calls);
  });
});

describe("a scope only reaches a registered system, at its own host (review I-2)", () => {
  const refusedAdd = async (body: Record<string, unknown>) => {
    const response = await api(
      "/plugins/servers/custom",
      await tokenToOpenBot(ada),
      { title: "Harvest", ...body },
    );
    expect(response.status).toBe(400);
    const [row] = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, body.id as string));
    // Nothing was written, and nobody's token was minted for it.
    expect(row).toBeUndefined();
    return ((await response.json()) as { error: string }).error;
  };

  test("Microsoft Graph cannot be marked, whatever the address", async () => {
    const asked = entra.requests.length;
    expect(
      await refusedAdd({
        id: `obo-graph-${tag}`,
        url: `https://${HR_HOST}/mcp`,
        entraScope: "https://graph.microsoft.com/.default",
      }),
    ).toContain("Microsoft 的第一方资源");
    expect(entra.requests.length).toBe(asked);
  });

  test("OpenBot's own API cannot be marked, so no token that could call back in is minted", async () => {
    expect(
      await refusedAdd({
        id: `obo-self-${tag}`,
        url: `https://${HR_HOST}/mcp`,
        entraScope: `api://${CLIENT_ID}/.default`,
      }),
    ).toContain("熊宝数字员工自己的 API");
  });

  test("a registered system's scope cannot be sent to another host", async () => {
    expect(
      await refusedAdd({
        id: `obo-elsewhere-${tag}`,
        url: `https://harvest-${tag}.obo.test/mcp`,
        entraScope: HR_SCOPE,
      }),
    ).toContain("token 只发往登记的主机");
  });

  test("a system the deployment did not register cannot be marked", async () => {
    expect(
      await refusedAdd({
        id: `obo-unlisted-${tag}`,
        url: `https://${HR_HOST}/mcp`,
        entraScope: `api://${randomUUID()}/.default`,
      }),
    ).toContain("没有登记在部署设置 MICROSOFT_OAUTH_OBO_RESOURCES 里");
  });

  test("a server marked before its registration was withdrawn is refused at the call, before Entra is asked", async () => {
    const caraId = (await userId(cara.upn)) ?? "";
    const asked = entra.requests.length;
    const calls = reached.length;
    const withdrawn = createPluginStore({
      database,
      auditStore,
      credentials: credentialReader,
      encryptionKey: config.keyEncryptionKey,
      policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
      outboundLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      entra: { ...framed(newEntra()), resources: [] },
    });
    const answer = await runAsTenant(caraId, async () => {
      const [tool] = (
        await grantedTools({
          store: withdrawn,
          botId: BOT,
          actorId: caraId,
          initiator: { kind: "routine", id: `routine-${tag}` },
        })
      ).filter((granted) => granted.ref === `${SERVER}/whoami`);
      return String(await tool?.execute({}));
    });
    expect(answer).toBe(
      `${REFUSAL_MARKER} 「HR」的 Entra scope 已经不在部署登记的范围里，所以没有发出。请联系管理员。`,
    );
    expect(entra.requests.length).toBe(asked);
    expect(reached.length).toBe(calls);
  });
});

describe("the address rules hold under concurrent adds (review M-1)", () => {
  test("a server is never left marked at an address it was not marked for", async () => {
    const elsewhere = `https://moved-${tag}.obo.test/mcp`;
    const home = `https://${HR_HOST}/mcp`;
    for (let round = 0; round < 6; round += 1) {
      const id = `obo-race-${round}-${tag}`;
      await store.addCustomServer({ id, title: "Race", url: home, by: ADMIN });
      // One admin marks it where it is; another moves it, naming no scope. Both read it unmarked.
      await Promise.allSettled([
        store.addCustomServer({
          id,
          title: "Race",
          url: home,
          entraScope: HR_SCOPE,
          by: ADMIN,
          actorId: (await userId(ADMIN)) ?? "",
        }),
        store.addCustomServer({ id, title: "Race", url: elsewhere, by: ADMIN }),
      ]);
      const [row] = await database
        .select({ url: mcpServers.url, entraScope: mcpServers.entraScope })
        .from(mcpServers)
        .where(eq(mcpServers.id, id));
      // Marked at home, or unmarked anywhere: never marked at the other address.
      expect(row?.entraScope === null || row?.url === home).toBe(true);
    }
  });
});

describe("hardening after re-review", () => {
  test("a server reached as the signed-in person must be https, so nobody's token crosses in the clear", async () => {
    const id = `obo-plaintext-${tag}`;
    const response = await api(
      "/plugins/servers/custom",
      await tokenToOpenBot(ada),
      {
        id,
        title: "Plaintext",
        url: `http://${HR_HOST}/mcp`,
        entraScope: HR_SCOPE,
      },
    );
    expect(response.status).toBe(400);
    // Refused at the address before the scope is even read: a server added by URL is https-only
    // in this fork. The scope rule says the same again, and the call is checked again below.
    expect(((await response.json()) as { error: string }).error).toBe(
      "An MCP server must be reached over https.",
    );
    const [row] = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, id));
    expect(row).toBeUndefined();
  });

  test("a marked server stored at an http address is refused at the call, before Entra is asked", async () => {
    const id = `obo-http-${tag}`;
    // As a row written before the rule, or by hand: marked, at plain http.
    await database.insert(mcpServers).values({
      id,
      tenantId: "team",
      title: "Http",
      vendor: HR_HOST,
      url: `http://${HR_HOST}/mcp`,
      provenance: "custom",
      entraScope: HR_SCOPE,
    });
    await database.insert(mcpTools).values({
      serverId: id,
      tenantId: "team",
      name: "whoami",
      description: "Who this HR system sees calling it.",
      inputSchema: { type: "object" },
      effect: "read",
    });
    await runAsTenant("system", () =>
      store.grant("mcp", `${id}/whoami`, BOT, ADMIN),
    );
    const caraId = (await userId(cara.upn)) ?? "";
    const asked = entra.requests.length;
    const calls = reached.length;
    expect(await backgroundCall(newEntra(), caraId, id)).toBe(
      `${REFUSAL_MARKER} 「Http」的 Entra scope 已经不在部署登记的范围里，所以没有发出。请联系管理员。`,
    );
    expect(entra.requests.length).toBe(asked);
    expect(reached.length).toBe(calls);
  });

  test("a call is never sent as anybody but the asker, whatever the Team Bot rule picked before the server was marked", async () => {
    const caraId = (await userId(cara.upn)) ?? "";
    const adminId = (await userId(ADMIN)) ?? "";
    const asked = entra.requests.length;
    const calls = reached.length;
    // As the Team Bot rule would answer for an owner's account it read before the mark landed.
    const refusal = await runAsTenant(caraId, () =>
      store.callTool({
        ref: `${SERVER}/whoami`,
        args: {},
        botId: BOT,
        actorId: caraId,
        credentialActorId: adminId,
      }),
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PluginRefusedError);
    expect((refusal as Error).message).toBe(
      "「HR」只以提问人自己的身份访问，不能借用别人的身份，所以没有发出。",
    );
    expect(entra.requests.length).toBe(asked);
    expect(reached.length).toBe(calls);
  });

  test("the asker's consent is asked at the send, on the row the token is sent for, before Entra", async () => {
    const caraId = (await userId(cara.upn)) ?? "";
    const askedFor: { actorId: string; botId: string; serverId: string }[] = [];
    const card = new PluginRefusedError("[team-bot-consent] ask first", null);
    const consenting = createPluginStore({
      database,
      auditStore,
      credentials: credentialReader,
      encryptionKey: config.keyEncryptionKey,
      policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
      outboundLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      entra: framed(newEntra()),
      entraConsent: async (input) => {
        askedFor.push(input);
        throw card;
      },
    });
    const asked = entra.requests.length;
    const calls = reached.length;
    const call = (ref: string) =>
      runAsTenant(caraId, () =>
        consenting.callTool({ ref, args: {}, botId: BOT, actorId: caraId }),
      );
    await expect(call(`${SERVER}/whoami`)).rejects.toBe(card);
    expect(askedFor).toEqual([
      { actorId: caraId, botId: BOT, serverId: SERVER },
    ]);
    expect(entra.requests.length).toBe(asked);
    expect(reached.length).toBe(calls);
    // An unmarked server is not asked about: it goes on the deployment's token, as before.
    expect((await call(`${PLAIN}/whoami`)).text).toContain(
      "You are the deployment.",
    );
    expect(askedFor).toHaveLength(1);
  });
});
