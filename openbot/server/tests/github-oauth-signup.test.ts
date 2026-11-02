import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuth } from "../src/auth";
import type { DeploymentConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  agentProfiles,
  agents,
  sessions,
  subscriptions,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * Story J1: somebody arriving through GitHub gets a tenant the same way a password sign-up does.
 *
 * Run through Better Auth's own handler, start to callback, so the `user.create` hook that provisions
 * the tenant is the real one. GitHub itself is never called: `fetch` answers the three GitHub
 * addresses Better Auth asks (the token exchange, `/user` and `/user/emails`) from a stub, and every
 * other address goes to the real `fetch` untouched.
 */
const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
let releaseRoleWriter: (() => Promise<void>) | undefined;

const suite = randomUUID().slice(0, 8);
const BASE = "http://127.0.0.1:3000";

/** What the stubbed GitHub says about the person signing in. */
let githubPerson: {
  id: number;
  login: string;
  email: string;
  verified: boolean;
} = { id: 0, login: "", email: "", verified: false };

const realFetch = globalThis.fetch;
beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (
      url.hostname === "github.com" &&
      url.pathname === "/login/oauth/access_token"
    ) {
      return json({
        access_token: `stub-token-${suite}`,
        token_type: "bearer",
        scope: "read:user,user:email",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user") {
      // No public email on the profile, which is the common case: Better Auth then reads /user/emails.
      return json({
        id: githubPerson.id,
        login: githubPerson.login,
        name: githubPerson.login,
        email: null,
        avatar_url: null,
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user/emails") {
      return json([
        {
          email: githubPerson.email,
          primary: true,
          verified: githubPerson.verified,
          visibility: "private",
        },
      ]);
    }
    if (url.hostname.endsWith("github.com")) {
      throw new Error(`unexpected GitHub request in a test: ${url.href}`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

const auth = createAuth(
  {
    auth: {
      baseUrl: BASE,
      secret: "x".repeat(40),
      trustedOrigins: [],
      initialAdminEmails: [],
      allowedEmailDomains: [],
      github: { clientId: "github-client-id", clientSecret: "github-secret" },
    },
    keyEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  } as unknown as DeploymentConfig,
  database,
  async () => false,
);

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/**
 * Sign in with GitHub the way the browser does: start, follow GitHub's redirect back with a code.
 * Answers with where the callback sent the browser.
 */
async function signInWithGithub(): Promise<string> {
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ provider: "github", callbackURL: `${BASE}/` }),
    }),
  );
  const started = (await start.json()) as { url?: string };
  expect(start.status, JSON.stringify(started)).toBe(200);
  const authorize = new URL(started.url ?? "");
  expect(authorize.hostname).toBe("github.com");
  const state = authorize.searchParams.get("state");
  expect(state).toBeString();

  const callback = await auth.handler(
    new Request(
      `${BASE}/api/auth/callback/github?code=stub-code&state=${encodeURIComponent(state ?? "")}`,
      { method: "GET", headers: { cookie: cookieHeader(start), origin: BASE } },
    ),
  );
  expect([301, 302, 303, 307]).toContain(callback.status);
  return callback.headers.get("location") ?? "";
}

const createdUserIds: string[] = [];

async function userByEmail(email: string) {
  const [row] = await database
    .select({ id: users.id, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.email, email));
  return row;
}

afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const userId of createdUserIds) {
    await runAsTenant(userId, async () => {
      await database
        .delete(agentProfiles)
        .where(eq(agentProfiles.tenantId, userId));
      await database.delete(agents).where(eq(agents.tenantId, userId));
      await database
        .delete(subscriptions)
        .where(eq(subscriptions.tenantId, userId));
    });
  }
  if (createdUserIds.length > 0) {
    await database
      .delete(accounts)
      .where(inArray(accounts.userId, createdUserIds));
    await database
      .delete(sessions)
      .where(inArray(sessions.userId, createdUserIds));
    await database.delete(users).where(inArray(users.id, createdUserIds));
  }
  await releaseRoleWriter?.();
});

describe("GitHub sign-in", () => {
  test("a first GitHub sign-in provisions a tenant through the user-create hook", async () => {
    const email = `github-${suite}@acme.test`;
    githubPerson = {
      id: 1_000_000 + Math.floor(Math.random() * 1_000_000),
      login: `octo-${suite}`,
      email,
      verified: true,
    };

    const location = await signInWithGithub();
    expect(location).not.toContain("error=");

    const user = await userByEmail(email);
    expect(user, "the callback has to have created the person").toBeDefined();
    const userId = user?.id ?? "";
    createdUserIds.push(userId);
    // GitHub vouched for the address, and only then is it recorded as verified.
    expect(user?.emailVerified).toBe(true);

    const [account] = await database
      .select({ accountId: accounts.accountId })
      .from(accounts)
      .where(
        and(eq(accounts.userId, userId), eq(accounts.providerId, "github")),
      );
    expect(account?.accountId).toBe(String(githubPerson.id));

    const owned = await runAsTenant(userId, async () => ({
      subscriptions: await database
        .select({
          planId: subscriptions.planId,
          tenant: subscriptions.tenantId,
        })
        .from(subscriptions)
        .where(eq(subscriptions.tenantId, userId)),
      employee: await database
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.tenantId, userId)),
    }));
    expect(owned.subscriptions).toEqual([{ planId: "free", tenant: userId }]);
    expect(owned.employee.map((row) => row.id)).toEqual([`avatar-${userId}`]);
  });

  test("a first GitHub sign-in with an address GitHub has not verified records it as unverified", async () => {
    const email = `github-fresh-unverified-${suite}@acme.test`;
    githubPerson = {
      id: 2_000_000 + Math.floor(Math.random() * 1_000_000),
      login: `octo-fresh-${suite}`,
      email,
      verified: false,
    };

    const location = await signInWithGithub();
    expect(location).not.toContain("error=");

    const user = await userByEmail(email);
    expect(user, "the callback has to have created the person").toBeDefined();
    createdUserIds.push(user?.id ?? "");
    // Only GitHub's own verified flag makes a GitHub address verified here.
    expect(user?.emailVerified).toBe(false);
  });

  /**
   * Both of Better Auth's link refusals, one at a time.
   *
   * Better Auth links a provider onto an existing row with the same address only when the provider
   * vouches for the address (`emailVerified`, which for GitHub is GitHub's own `verified` flag) and the
   * row's own address is verified (`requireLocalEmailVerified`, on by default). Each case below breaks
   * exactly one of the two, so each refusal is that rule's and not the other's.
   */
  async function passwordAccount(email: string, verified: boolean) {
    const signUp = await auth.handler(
      new Request(`${BASE}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({
          name: `Holder ${suite}`,
          email,
          password: "a-passphrase-long-enough",
        }),
      }),
    );
    expect(signUp.status).toBe(200);
    const holder = await userByEmail(email);
    const holderId = holder?.id ?? "";
    expect(holderId).not.toBe("");
    createdUserIds.push(holderId);
    if (verified) {
      await database
        .update(users)
        .set({ emailVerified: true })
        .where(eq(users.id, holderId));
    }
    return holderId;
  }

  async function githubAccountsOf(userId: string) {
    return await database
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(eq(accounts.userId, userId), eq(accounts.providerId, "github")),
      );
  }

  test("a verified GitHub address is not linked onto an unverified password account", async () => {
    const email = `github-squat-${suite}@acme.test`;
    const holderId = await passwordAccount(email, false);

    githubPerson = {
      id: 3_000_000 + Math.floor(Math.random() * 1_000_000),
      login: `octo-squatted-${suite}`,
      email,
      verified: true,
    };
    const location = await signInWithGithub();
    // Better Auth's own refusal, not some other failure on the way through the callback.
    expect(new URL(location).searchParams.get("error")).toBe(
      "account_not_linked",
    );

    expect(await githubAccountsOf(holderId)).toEqual([]);
    // The refused attempt did not mark the password account's address as verified either.
    expect((await userByEmail(email))?.emailVerified).toBe(false);
  });

  test("an address GitHub has not verified is not linked, even onto a verified account", async () => {
    const email = `github-unverified-${suite}@acme.test`;
    const holderId = await passwordAccount(email, true);

    githubPerson = {
      id: 5_000_000 + Math.floor(Math.random() * 1_000_000),
      login: `octo-unverified-${suite}`,
      email,
      verified: false,
    };
    const location = await signInWithGithub();
    // Better Auth's own refusal, not some other failure on the way through the callback.
    expect(new URL(location).searchParams.get("error")).toBe(
      "account_not_linked",
    );

    expect(await githubAccountsOf(holderId)).toEqual([]);
  });
});
