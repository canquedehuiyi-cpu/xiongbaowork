import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { decryptOAuthToken, setTokenUtil } from "better-auth/oauth2";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  exportJWK,
  generateKeyPair,
  type JWK,
  jwtVerify,
  type KeyObject,
  SignJWT,
} from "jose";
import { createApp } from "../src/app";
import { createPeopleStore } from "../src/people/store";
import { createAuditStore } from "../src/audit";
import { createAuth } from "../src/auth";
import { createEntra, withEntraBearer } from "../src/auth/entra";
import { createRoleRepository } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  agents,
  auditEvents,
  credentials,
  mcpServers,
  revokedAccess,
  sessions,
  users,
} from "../src/db/schema";
import {
  CustomServerRefusedError,
  createPluginStore,
} from "../src/plugins/store";
import { grantedTools, REFUSAL_MARKER } from "../src/plugins/tools";
import { createRequestActor } from "../src/request-actor";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
import { afterAll, beforeAll } from "./support/platform-frame";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * A company system behind Microsoft Entra, reached as the signed-in person.
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
const ENTRA_PORT = 7483;
const MCP_PORT = 7484;
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

const credentialReader = {
  readSecret: async (id: string) => {
    const [row] = await database
      .select({
        encryptedValue: credentials.encryptedValue,
        revokedAt: credentials.revokedAt,
      })
      .from(credentials)
      .where(eq(credentials.id, id));
    return row ?? null;
  },
} as never;

const storeWith = (tokens?: ReturnType<typeof createEntra>) =>
  createPluginStore({
    database,
    auditStore,
    credentials: credentialReader,
    encryptionKey: config.keyEncryptionKey,
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    ...(tokens ? { entra: tokens } : {}),
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
  const [account] = await database
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, id), eq(accounts.providerId, "microsoft")));
  if (!account) throw new Error(`${who.upn} has a Microsoft account`);
  const ctx = (await betterAuth.$context) as unknown as Parameters<
    typeof setTokenUtil
  >[1];
  const refreshToken = `rt-${randomUUID()}`;
  entra.refreshTokens.set(refreshToken, who);
  await ctx.internalAdapter.updateAccount(account.id, {
    refreshToken: (await setTokenUtil(refreshToken, ctx)) as string,
  });
  return id;
}

async function storedRefreshToken(id: string) {
  const ctx = (await betterAuth.$context) as unknown as Parameters<
    typeof decryptOAuthToken
  >[1];
  const [row] = await database
    .select({ refreshToken: accounts.refreshToken })
    .from(accounts)
    .where(and(eq(accounts.userId, id), eq(accounts.providerId, "microsoft")));
  return {
    raw: row?.refreshToken ?? null,
    plain: row?.refreshToken
      ? await decryptOAuthToken(row.refreshToken, ctx)
      : null,
  };
}

/** One tool call from a routine: the in-process door a background run takes, with nobody watching. */
async function backgroundCall(
  tokens: ReturnType<typeof createEntra>,
  actorId: string,
  serverId = SERVER,
) {
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

  // The deployment's Bot and its shared credential are catalogue rows every person reads (`system`).
  const deploymentToken = await encryptSecret(
    config.keyEncryptionKey,
    `deployment-token-${tag}`,
  );
  await runAsTenant("system", async () => {
    await database
      .insert(agents)
      .values({ id: BOT, name: BOT, type: "remote_ag_ui", configuration: {} });
    await database.insert(credentials).values({
      id: DEPLOYMENT_CREDENTIAL,
      kind: "mcp",
      provider: PLAIN,
      keyId: `mcp-${PLAIN}`,
      encryptedValue: deploymentToken,
      metadata: {},
    });
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

describe("an app calls OpenBot with a person's Entra token", () => {
  test("a valid token runs as that person, signed in the way the sign-in screen signs them in", async () => {
    const response = await api("/me", await tokenToOpenBot(ada));
    expect(response.status).toBe(200);
    const { user } = (await response.json()) as {
      user: { email: string; role: string };
    };
    expect(user.email).toBe(ADMIN);
    // Admitted by the same rules: INITIAL_ADMIN_EMAILS names her, so sign-in made her an admin.
    expect(user.role).toBe("admin");

    // And the second request finds her rather than signing her in again.
    const again = await api("/me", await tokenToOpenBot(ada));
    expect(again.status).toBe(200);
    // Signing her in left no session behind: the token is what each request runs on.
    const adminId = (await userId(ADMIN)) ?? "";
    // Read back across tenants, as the platform (G01).
    const signedIn = await asPlatform(() =>
      database
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, adminId)),
    );
    expect(signedIn).toHaveLength(0);
    // The sign-in itself is still on the trail.
    const trail = await asPlatform(() =>
      database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "session.signed_in"),
            eq(auditEvents.actorUserId, adminId),
          ),
        ),
    );
    expect(trail).toHaveLength(1);
  });

  test("an agent request with the token runs as that person too", async () => {
    const door = withEntraBearer(betterAuth, signIn);
    const { resolveRequestActor } = createRequestActor({
      singleUser: false,
      // Framed as index.ts frames them: who a request is, asked as `platform`.
      getSession: async (headers) =>
        (await asPlatform(() => door.api.getSession({ headers }))) ?? null,
      rolesForUser: (id) =>
        asPlatform(() => createRoleRepository(database).rolesForUser(id)),
    });
    const actor = await resolveRequestActor(
      new Request("http://127.0.0.1:7480/api/copilotkit", {
        method: "POST",
        headers: { authorization: `Bearer ${await tokenToOpenBot(ada)}` },
      }),
    );
    expect(actor).toEqual({
      id: (await userId(ADMIN)) ?? "",
      name: ada.upn.split("@")[0],
      role: "admin",
    });
  });

  test.each([
    ["a token for another audience", { aud: randomUUID() }, undefined],
    [
      "a token from another directory",
      { iss: `https://login.microsoftonline.com/${randomUUID()}/v2.0` },
      undefined,
    ],
    ["an expired token", {}, -60],
    [
      "an app's own token, with no person behind it",
      { scp: undefined },
      undefined,
    ],
    [
      "a token issued to an app MICROSOFT_OAUTH_ALLOWED_CLIENTS does not list",
      { azp: randomUUID() },
      undefined,
    ],
    ["a token that names no app", { azp: undefined }, undefined],
    [
      // What Entra issues when OpenBot's registration asks for v1.0 tokens: the app is in `appid`.
      "a v1.0 token, even from a listed app",
      {
        ver: "1.0",
        iss: `https://sts.windows.net/${TENANT}/`,
        aud: `api://${CLIENT_ID}`,
        azp: undefined,
        azpacr: undefined,
        appid: APP_CLIENT,
        appidacr: "0",
      },
      undefined,
    ],
  ] as const)("%s is refused", async (_name, overrides, expiresIn) => {
    // Somebody new each time, so one case signing them in cannot decide the next.
    const stranger = person(`stranger-${randomUUID().slice(0, 8)}`);
    const response = await api(
      "/me",
      await tokenToOpenBot(stranger, overrides, expiresIn),
    );
    expect(response.status).toBe(401);
    // Nobody was signed in on its strength.
    expect(await userId(stranger.upn)).toBeNull();
  });

  test("a deployment that lists no app takes no app's token", async () => {
    const unlisted = newEntra({ ...microsoft, allowedClients: [] });
    const stranger = person("unlisted");
    const token = await tokenToOpenBot(stranger);
    // As the request guard asks it: as `platform`, before anybody is known.
    expect(
      await asPlatform(() =>
        unlisted.sessionFrom(new Headers({ authorization: `Bearer ${token}` })),
      ),
    ).toBeNull();
    expect(await userId(stranger.upn)).toBeNull();
  });

  test("the token does not sign anybody in at Better Auth's own endpoint", async () => {
    // The first sign-in from a token is answered for the bearer path only; this door stays shut.
    const response = await app.request(
      "http://127.0.0.1:7480/api/auth/sign-in/social",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "microsoft",
          idToken: { token: await tokenToOpenBot(person("door")) },
        }),
      },
    );
    expect(response.status).toBe(401);
    expect(await userId(email("door"))).toBeNull();
  });

  test("a token signed by anybody but Entra is refused", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await sign(
      {
        iss: ISSUER,
        aud: CLIENT_ID,
        oid: ada.oid,
        scp: "access_as_user",
        preferred_username: ADMIN,
      },
      { key: privateKey },
    );
    expect((await api("/me", forged)).status).toBe(401);
  });

  /*
   * M3: upstream's cases from here to the end of the file — a server marked as reached as the
   * signed-in person (`entraScope`), a routine reaching it on the person's stored Microsoft sign-in,
   * and what does not change for an unmarked server — are not kept. They exercise the plugin store
   * reaching an MCP server on Entra on-behalf-of tokens, which the fork's plugin store does not have
   * (no `entra` option, no `entraScope` on a server). The helpers above that only they used
   * (`signedInWithMicrosoft`, `storedRefreshToken`, `backgroundCall`) stay for when it does.
   */
});
