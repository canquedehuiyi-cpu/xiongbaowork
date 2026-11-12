import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { IdentityProviderStore } from "../src/auth/identity-provider-store";
import { loadConfig } from "../src/config";
import { currentTenant } from "../src/tenant/context";
import { testEnvironment } from "./support/environment";

const app = createApp(
  loadConfig({
    ...testEnvironment(),
  }),
);

describe("health endpoint", () => {
  test("reports the server as healthy", async () => {
    const response = await app.request("http://openbot.local/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});

describe("runtime capabilities", () => {
  test("reports transcription without exposing its endpoint, model, or key", async () => {
    const configured = createApp(
      loadConfig(
        testEnvironment({
          TRANSCRIPTION_PROVIDER: "openai-compatible",
          TRANSCRIPTION_BASE_URL: "https://speech.private.example/v1",
          TRANSCRIPTION_MODEL: "private-speech-model",
          TRANSCRIPTION_API_KEY: "private-speech-key",
        }),
      ),
    );
    const response = await configured.request("/api/capabilities");
    const body = await response.text();
    expect(JSON.parse(body).transcription).toBe(true);
    expect(body).not.toContain("private");
  });
  /*
   * G01-E: this route answers before anybody signs in, so it has no person's frame, and the providers
   * are deployment rows. They are read as `platform`; with no frame at all the read is refused (it
   * used to fall back to `system`), and the whole route answered 500 on a deployment that had an
   * identity provider store, which is every one that boots `index.ts`.
   */
  test("counts the registered identity providers in the platform frame, with nobody signed in", async () => {
    const frames: string[] = [];
    const identityProviders: IdentityProviderStore = {
      list: async () => {
        frames.push(currentTenant());
        return [
          {
            providerId: "okta",
            issuer: "https://idp.example",
            domain: "example.com",
            protocol: "saml",
            registeredBy: null,
          },
        ];
      },
      remove: async () => false,
    };
    // `identityProviders` is createApp's 19th argument, after the config and seventeen optional ones.
    // Placed by index, so it is type-checked against the parameter it lands on.
    const args = new Array(createApp.length) as unknown as Parameters<
      typeof createApp
    >;
    args[0] = loadConfig(testEnvironment());
    args[18] = identityProviders;
    const withProviders = createApp(...args);
    const response = await withProviders.request(
      "http://openbot.local/api/capabilities",
    );
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { ssoConfigured: boolean }).ssoConfigured,
    ).toBe(true);
    expect(frames).toEqual(["platform"]);
  });

  test("offers WakerFlow automations only where the WakerFlow target is registered (AUT3)", async () => {
    const plain = await app.request("http://openbot.local/api/capabilities");
    expect(
      ((await plain.json()) as { wakerflowAutomations: boolean })
        .wakerflowAutomations,
    ).toBe(false);
    // `coworker` is createApp's 34th argument, after the config and thirty-two optional ones.
    const args = new Array(createApp.length) as unknown as Parameters<
      typeof createApp
    >;
    args[0] = loadConfig(testEnvironment());
    args[33] = { wakerflowAutomations: true };
    const withFlows = createApp(...args);
    const offered = await withFlows.request(
      "http://openbot.local/api/capabilities",
    );
    expect(
      ((await offered.json()) as { wakerflowAutomations: boolean })
        .wakerflowAutomations,
    ).toBe(true);
  });

  test("reports the local runtime without exposing configuration secrets", async () => {
    const response = await app.request("http://openbot.local/api/capabilities");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: "local",
      durableHistory: true,
      // Default-on. The browser reads this to decide whether to offer the tool that generates an
      // interface, so it has to be here and not only in the runtime.
      generativeUi: true,
      // AUT3: off unless the WakerFlow automation target was registered (index.ts does).
      wakerflowAutomations: false,
      // Default-on: a fresh clone is somebody evaluating the template.
      selfHostBanner: false,
      // Off: this deployment has an identity provider, so it is not somebody's local trial.
      localEvaluation: false,
      // Which product this is. The app trims its screens for the personal edition.
      edition: "team",
      transcription: false,
      voice: false,
      // Names only. The sign-in screen reads this to know which buttons to draw.
      authProviders: ["google"],
      // A boolean, not a list: naming the registered providers would tell anybody who loads the
      // sign-in page which companies use this deployment.
      ssoConfigured: false,
      ssoRequired: false,
      // Whether the password form has an endpoint behind it. On whenever Better Auth is built here.
      emailPassword: true,
    });
  });

  // The runtime object holds the Intelligence API key and licence token. This endpoint has no
  // authentication, so a projection bug here publishes deployment secrets to anyone who asks.
  test("never serves the Intelligence credentials", async () => {
    const response = await app.request("http://openbot.local/api/capabilities");
    const body = await response.text();
    const parsed = (await new Response(body).json()) as Record<string, unknown>;

    expect(body).not.toContain("tenant-api-key");
    expect(body).not.toContain("license-token");
    // The settings object itself must not be projected, whatever it happens to hold today.
    expect(Object.keys(parsed)).toEqual([
      "mode",
      "durableHistory",
      "generativeUi",
      "wakerflowAutomations",
      "selfHostBanner",
      "localEvaluation",
      "edition",
      "transcription",
      "voice",
      "authProviders",
      "ssoConfigured",
      "ssoRequired",
      "emailPassword",
    ]);
    // The provider list is names, never the clients and secrets behind them.
    expect(body).not.toContain("google-client-secret");
  });

  /*
   * The answer has to reach the browser, not just the runtime.
   *
   * The app offers the model the tool that generates an interface, and it decides whether to from
   * this field. The two halves disagreeing is the one configuration this capability must not be able
   * to end up in: runtime-only means the tool is never offered, browser-only means a Bot writes a
   * whole interface that nothing renders.
   */
  test("reports generated interfaces as off when the deployment opts out", async () => {
    const disabled = createApp(
      loadConfig(testEnvironment({ OPENBOT_GENERATIVE_UI: "false" })),
    );

    const response = await disabled.request(
      "http://openbot.local/api/capabilities",
    );

    expect(response.status).toBe(200);
    expect((await response.json()).generativeUi).toBe(false);
  });

  // The banner is opt-in, and the browser has to hear that an operator turned it on.
  test("reports the self-host banner as on when the deployment opts in", async () => {
    const enabled = createApp(
      loadConfig(testEnvironment({ OPENBOT_SELF_HOST_BANNER: "true" })),
    );

    const response = await enabled.request(
      "http://openbot.local/api/capabilities",
    );

    expect(response.status).toBe(200);
    expect((await response.json()).selfHostBanner).toBe(true);
  });

  // One person running it for themselves is not somebody to offer help running it for a company.
  test("reports the personal edition, with no self-host banner", async () => {
    const personal = createApp(
      loadConfig(
        testEnvironment({
          GOOGLE_OAUTH_CLIENT_ID: undefined,
          GOOGLE_OAUTH_CLIENT_SECRET: undefined,
          BETTER_AUTH_SECRET: undefined,
          BETTER_AUTH_URL: undefined,
          INITIAL_ADMIN_EMAILS: undefined,
          OPENBOT_EDITION: "personal",
          OPENBOT_SINGLE_USER: "true",
          AGENT_COMPUTER_URL: "http://127.0.0.1:7000",
        }),
      ),
    );

    const body = await (
      await personal.request("http://openbot.local/api/capabilities")
    ).json();
    expect(body.edition).toBe("personal");
    expect(body.selfHostBanner).toBe(false);
  });
});

describe("authentication availability", () => {
  test("a single-person install answers Sign out as done, since it has no sign-in to end", async () => {
    // OpenBot Desktop: one person, no identity provider, no sessions. A page that still offers Sign
    // out must not be told "No identity provider is configured." for a button that cannot fail.
    const single = createApp(
      loadConfig(
        testEnvironment({
          OPENBOT_SINGLE_USER: "true",
          BETTER_AUTH_URL: undefined,
          BETTER_AUTH_SECRET: undefined,
          GOOGLE_OAUTH_CLIENT_ID: undefined,
          GOOGLE_OAUTH_CLIENT_SECRET: undefined,
          INITIAL_ADMIN_EMAILS: undefined,
        }),
      ),
    );
    const signOut = await single.request(
      "http://127.0.0.1:3001/api/auth/sign-out",
      { method: "POST" },
    );
    expect(signOut.status).toBe(200);
    await expect(signOut.json()).resolves.toEqual({ success: true });
    // Only Sign out: anything else that needs a provider still says there is none.
    const signIn = await single.request(
      "http://127.0.0.1:3001/api/auth/sign-in/social",
      { method: "POST" },
    );
    expect(signIn.status).toBe(503);
  });

  test("fails loudly when no identity provider has been configured", async () => {
    const response = await app.request(
      "http://openbot.local/api/auth/sign-in/social",
      { method: "POST" },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "No identity provider is configured.",
    });
  });

  test("forwards auth requests to the configured Better Auth handler", async () => {
    const authenticatedApp = createApp(
      loadConfig({
        ...testEnvironment(),
      }),
      {
        handler: () => new Response("mounted", { status: 204 }),
      },
    );

    const response = await authenticatedApp.request(
      "http://openbot.local/api/auth/callback/google",
    );

    expect(response.status).toBe(204);
  });

  test("forwards logout requests to Better Auth", async () => {
    const authenticatedApp = createApp(
      loadConfig({
        ...testEnvironment(),
      }),
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => null,
        },
      },
    );

    const response = await authenticatedApp.request(
      "http://openbot.local/api/auth/sign-out",
      { method: "POST" },
    );

    expect(response.status).toBe(204);
  });
});

/**
 * Who may register an identity provider.
 *
 * Better Auth's SSO plugin guards these with a session, which asks only that somebody is signed in.
 * That is the wrong bar: registering an IdP for a domain means anybody it vouches for can sign in,
 * so a plain user reaching it could mint themselves colleagues. These pin the gate in front of it.
 */
describe("identity provider registration", () => {
  function appFor(roles: ("admin" | "user")[], signedIn = true) {
    let reachedHandler = false;
    const app = createApp(
      loadConfig(testEnvironment()),
      {
        handler: () => {
          reachedHandler = true;
          return new Response(null, { status: 200 });
        },
        api: {
          getSession: async () =>
            signedIn ? { user: { id: "u1", email: "u1@openbot.test" } } : null,
        },
      } as never,
      { rolesForUser: async () => roles },
    );
    return { app, reached: () => reachedHandler };
  }

  const routes = [
    "/api/auth/sso/register",
    "/api/auth/sso/update-provider",
    "/api/auth/sso/delete-provider",
  ];

  test.each(routes)("refuses %s to a plain user", async (route) => {
    const { app, reached } = appFor(["user"]);

    const response = await app.request(`http://openbot.test${route}`, {
      method: "POST",
    });

    expect(response.status).toBe(403);
    // Refused in front of Better Auth, not by it: the plugin would have allowed this.
    expect(reached()).toBe(false);
  });

  test.each(routes)("refuses %s to somebody signed out", async (route) => {
    const { app, reached } = appFor([], false);

    const response = await app.request(`http://openbot.test${route}`, {
      method: "POST",
    });

    expect(response.status).toBe(403);
    expect(reached()).toBe(false);
  });

  test.each(routes)("lets an administrator through to %s", async (route) => {
    const { app, reached } = appFor(["admin"]);

    await app.request(`http://openbot.test${route}`, { method: "POST" });

    expect(reached()).toBe(true);
  });

  // Everything else under /api/auth is Better Auth's own business, including sign-in itself, which
  // by definition happens before anybody has a role.
  test("leaves the rest of the auth routes alone", async () => {
    const { app, reached } = appFor([], false);

    await app.request("http://openbot.test/api/auth/sign-in/social", {
      method: "POST",
    });

    expect(reached()).toBe(true);
  });
});
