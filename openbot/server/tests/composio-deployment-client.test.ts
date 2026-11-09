import { describe, expect, test } from "bun:test";
import { BrokerRefusalError } from "../src/plugins/broker";
import {
  buildComposioClient,
  connectionOf,
} from "../src/plugins/composio-adapter";
import {
  adminConnectOnly,
  DEPLOYMENT_CLIENT_SCHEME,
  deploymentClientFrom,
  deploymentClientKey,
  toolkitOfDeploymentClientKey,
  withDeploymentClients,
} from "../src/plugins/deployment-clients";

/**
 * A server-to-server grant is offered only on the deployment's own client (upstream #950), and
 * Shopify is the app that publishes nothing else: an OAuth2 that needs a client registered here,
 * and S2S_OAUTH2, with no scheme Composio manages for it.
 *
 * The fork holds that client in the vault rather than the environment, so the catalogue row alone
 * cannot say whether it is held: `connectionOf` marks the app `awaitsClient`, and
 * `withDeploymentClients` turns it into the field scheme for the apps a client is stored for.
 */
const shopify = {
  slug: "shopify",
  auth_schemes: ["OAUTH2", "S2S_OAUTH2"],
  composio_managed_auth_schemes: [],
};

const CLIENT = { client_id: "shpca_id", client_secret: "shpss_secret_value" };

const refuse = (what: string) => async () => {
  throw new Error(`${what} should not have been called in this test.`);
};

function fakeVendor(parts: {
  authConfigs?: Record<string, unknown>;
  connectedAccounts?: Record<string, unknown>;
}) {
  return {
    tools: {
      list: refuse("tools.list"),
      getRawComposioToolBySlug: refuse("tools.getRawComposioToolBySlug"),
      execute: refuse("tools.execute"),
    },
    toolkits: {
      list: refuse("toolkits.list"),
      retrieve: refuse("toolkits.retrieve"),
    },
    authConfigs: {
      list: refuse("authConfigs.list"),
      create: refuse("authConfigs.create"),
      delete: refuse("authConfigs.delete"),
      ...parts.authConfigs,
    },
    connectedAccounts: {
      list: refuse("connectedAccounts.list"),
      link: refuse("connectedAccounts.link"),
      create: refuse("connectedAccounts.create"),
      delete: refuse("connectedAccounts.delete"),
      ...parts.connectedAccounts,
    },
  } as never;
}

describe("which apps a server-to-server grant makes connectable", () => {
  test("from the catalogue row alone, a server-to-server app is unsupported and awaits a client", () => {
    const connection = connectionOf(shopify as never);
    expect(connection.kind).toBe("unsupported");
    if (connection.kind !== "unsupported") throw new Error("unreachable");
    expect(connection.awaitsClient).toBe(true);
    // The administrator is the one person who can fix this, and the sentence says how.
    expect(connection.reason).toContain("保存客户端");
    expect(connection.reason).not.toContain("COMPOSIO_SHOPIFY_CLIENT");
  });

  test("a stored client turns exactly that app into the field scheme", () => {
    const app = {
      slug: "shopify",
      connection: connectionOf(shopify as never),
    };
    const other = { ...app, slug: "otherapp" };
    expect(
      withDeploymentClients([app, other], new Set(["shopify"])).map(
        (entry) => entry.connection,
      ),
    ).toEqual([{ kind: "fields", authScheme: "S2S_OAUTH2" }, other.connection]);
    expect(withDeploymentClients([app], new Set())).toEqual([app]);
  });

  test("an app that is unsupported for any other reason stays so, client or not", () => {
    const app = {
      slug: "shopify",
      connection: connectionOf({
        slug: "shopify",
        auth_schemes: ["OAUTH2"],
        composio_managed_auth_schemes: [],
      } as never),
    };
    expect(app.connection).not.toHaveProperty("awaitsClient");
    expect(withDeploymentClients([app], new Set(["shopify"]))).toEqual([app]);
  });

  test("a plain key is still preferred over a server-to-server grant", () => {
    expect(
      connectionOf({
        ...shopify,
        auth_schemes: ["S2S_OAUTH2", "API_KEY"],
      } as never),
    ).toEqual({ kind: "fields", authScheme: "API_KEY" });
  });

  test("managed consent still wins over a server-to-server grant", () => {
    expect(
      connectionOf({
        ...shopify,
        composio_managed_auth_schemes: ["OAUTH2"],
      } as never),
    ).toEqual({ kind: "consent" });
  });
});

describe("the deployment's own client, as an administrator typed it", () => {
  test("half a client is no client, and a padded one is trimmed", () => {
    expect(deploymentClientFrom({ client_id: "id" })).toBeNull();
    expect(
      deploymentClientFrom({ client_id: "id", client_secret: "   " }),
    ).toBeNull();
    expect(
      deploymentClientFrom({ client_id: 1, client_secret: "secret" }),
    ).toBeNull();
    expect(deploymentClientFrom(null)).toBeNull();
    expect(
      deploymentClientFrom({ client_id: " id ", client_secret: "secret" }),
    ).toEqual({ client_id: "id", client_secret: "secret" });
  });

  test("its vault key names the app, and only a key of that shape is read back as one", () => {
    const key = deploymentClientKey("shopify");
    expect(key.kind).toBe("mcp_oauth_client");
    expect(toolkitOfDeploymentClientKey(key.keyId)).toBe("shopify");
    expect(toolkitOfDeploymentClientKey("oauth-client-notion")).toBeNull();
  });

  test("only an app on the deployment's own client is connected by an administrator alone", () => {
    expect(adminConnectOnly(DEPLOYMENT_CLIENT_SCHEME)).toBe(true);
    expect(adminConnectOnly("API_KEY")).toBe(false);
    expect(adminConnectOnly(null)).toBe(false);
  });
});

describe("enabling a server-to-server app", () => {
  test("the config is created with the deployment's client as its credentials", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [] }),
          create: async (toolkit: string, options: unknown) => {
            created.push({ toolkit, options });
            return { id: "ac_new" };
          },
        },
      }),
    );

    expect(
      await broker.ensureAuthConfig({
        toolkit: "shopify",
        name: "Shopify",
        connection: { kind: "fields", authScheme: "S2S_OAUTH2" },
        client: CLIENT,
      }),
    ).toBe("created");
    expect(created).toEqual([
      {
        toolkit: "shopify",
        options: {
          type: "use_custom_auth",
          authScheme: "S2S_OAUTH2",
          name: "Shopify (OpenBot)",
          credentials: CLIENT,
        },
      },
    ]);
  });

  test("without a stored client nothing is created, and the refusal says what to store", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({ authConfigs: { list: async () => ({ items: [] }) } }),
    );

    const refused = broker.ensureAuthConfig({
      toolkit: "shopify",
      name: "Shopify",
      connection: { kind: "fields", authScheme: "S2S_OAUTH2" },
    });
    await expect(refused).rejects.toBeInstanceOf(BrokerRefusalError);
    await expect(refused).rejects.toThrow("客户端 ID 和密钥");
  });

  test("a key app is still sent no credential, whatever a caller hands in", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [] }),
          create: async (_toolkit: string, options: unknown) => {
            created.push(options);
            return { id: "ac_new" };
          },
        },
      }),
    );
    await broker.ensureAuthConfig({
      toolkit: "firecrawl",
      name: "Firecrawl",
      connection: { kind: "fields", authScheme: "API_KEY" },
      client: CLIENT,
    });
    expect(created).toEqual([
      {
        type: "use_custom_auth",
        authScheme: "API_KEY",
        name: "Firecrawl (OpenBot)",
        credentials: {},
      },
    ]);
  });
});

describe("a refused server-to-server config keeps nothing of the request (review M-5)", () => {
  test("the refusal carries the vendor's sentence and no cause, and never the secret", async () => {
    const vendorError = Object.assign(
      new Error("400 Bad Request: invalid client_id"),
      {
        // What an SDK error object carries: the request it was made for, secret and all.
        request: { body: { credentials: CLIENT } },
      },
    );
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [] }),
          create: async () => {
            throw vendorError;
          },
        },
      }),
    );
    let caught: unknown;
    try {
      await broker.ensureAuthConfig({
        toolkit: "shopify",
        name: "Shopify",
        connection: { kind: "fields", authScheme: "S2S_OAUTH2" },
        client: CLIENT,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BrokerRefusalError);
    const refusal = caught as Error & { cause?: unknown };
    expect(refusal.cause).toBeUndefined();
    expect(refusal.message).not.toContain(CLIENT.client_secret);
    expect(JSON.stringify(Object.entries(refusal))).not.toContain(
      CLIENT.client_secret,
    );
  });
});

describe("connecting a server-to-server app", () => {
  const OURS = { id: "ac_ours", name: "Shopify (OpenBot)", status: "ENABLED" };

  async function sentState(authScheme: "S2S_OAUTH2" | "API_KEY") {
    const asked: { connection: { state: unknown } }[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [OURS] }) },
        connectedAccounts: {
          create: async (body: { connection: { state: unknown } }) => {
            asked.push(body);
            return { id: "ca_new", status: "INITIATED" };
          },
        },
      }),
    );
    await broker.connectWithFields({
      userId: "admin_1",
      toolkit: "shopify",
      authScheme,
      values: { subdomain: "acme-store", status: "ACTIVE" },
    });
    return asked[0]?.connection.state;
  }

  test("no status is claimed, so Composio exchanges the client for the token itself", async () => {
    expect(await sentState("S2S_OAUTH2")).toEqual({
      authScheme: "S2S_OAUTH2",
      val: { subdomain: "acme-store" },
    });
  });

  test("a key app still states ACTIVE, which no typed value can override", async () => {
    expect(await sentState("API_KEY")).toEqual({
      authScheme: "API_KEY",
      val: { subdomain: "acme-store", status: "ACTIVE" },
    });
  });
});
