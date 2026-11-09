import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { BrokerApp } from "../src/plugins/broker";
import type { PluginStore } from "../src/plugins/store";
import { testEnvironment } from "./support/environment";

/**
 * The routes around a deployment's own OAuth client for a server-to-server app (upstream #950):
 * an administrator stores, lists and removes it, the directory offers the app once one is held,
 * and a person's connect to such an app is refused before the form is drawn.
 */

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
};

/** `createApp`'s positions 4-14 and 16-29; see the note in plugin-routes.test.ts. */
const UP_TO_PLUGIN_STORE = Array.from({ length: 11 }, () => undefined) as [
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
];
const UP_TO_BROKER = Array.from({ length: 14 }, () => undefined) as [
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
];

const SECRET = "shpss_never_comes_back";

const SHOPIFY: BrokerApp = {
  slug: "shopify",
  name: "Shopify",
  description: "Commerce.",
  logo: null,
  categories: [],
  actionCount: 1,
  connection: {
    kind: "unsupported",
    reason: "needs a client",
    awaitsClient: true,
  },
};
const SLACK: BrokerApp = {
  ...SHOPIFY,
  slug: "slack",
  name: "Slack",
  connection: { kind: "consent" },
};

function appFor(options: {
  role?: "admin" | "user";
  held?: string[];
  heldThrows?: boolean;
}) {
  const stored: unknown[] = [];
  const removed: unknown[] = [];
  const added: unknown[] = [];
  const connected: unknown[] = [];
  const asked: unknown[] = [];
  const store = {
    serverUrls: async () => [],
    listServers: async () => [],
    listSkills: async () => [],
    deploymentClientToolkits: async () => {
      if (options.heldThrows) throw new Error("vault unreachable");
      return new Set(options.held ?? []);
    },
    listDeploymentClients: async () => [
      { toolkit: "shopify", clientId: "shpca_id", storedAt: null },
    ],
    storeDeploymentClient: async (input: unknown) => {
      stored.push(input);
      return { replaced: false };
    },
    removeDeploymentClient: async (input: unknown) => {
      removed.push(input);
      return { removed: true };
    },
    addBrokeredApp: async (input: { slug: string }) => {
      added.push(input);
      return {
        id: `composio-${input.slug}`,
        url: `composio://${input.slug}`,
        tools: [],
        withdrawn: [],
      };
    },
    serverAddress: async (id: string) =>
      id === "composio-shopify"
        ? {
            id,
            url: "composio://shopify",
            title: "Shopify",
            authScheme: "S2S_OAUTH2",
            catalogueKey: null,
          }
        : undefined,
    brokeredConnectionsFor: async () => [],
    // Nobody is connected yet: the press is a first connect.
    brokeredConnection: async () => null,
    connectBrokeredWithFields: async (input: unknown) => {
      connected.push(input);
      return { connected: true, verified: false, probe: null };
    },
  } as unknown as PluginStore;

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [options.role ?? "admin"] },
    ...UP_TO_PLUGIN_STORE,
    store,
    ...UP_TO_BROKER,
    {
      broker: {
        listApps: async () => [SHOPIFY, SLACK],
        connectionFields: async (request: unknown) => {
          asked.push(request);
          return [
            {
              name: "subdomain",
              label: "Subdomain",
              help: "",
              required: true,
              secret: false,
            },
          ];
        },
      },
    } as never,
  );
  return { app, stored, removed, added, connected, asked };
}

const request = (
  app: ReturnType<typeof appFor>["app"],
  path: string,
  init: RequestInit = {},
) =>
  app.request(`http://openbot.test/api/plugins${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("storing the deployment's own client", () => {
  test("an administrator stores it; the answer names the client id and never the secret", async () => {
    const { app, stored } = appFor({});
    const response = await request(app, "/composio/clients/shopify", {
      method: "PUT",
      body: JSON.stringify({
        client_id: " shpca_id ",
        client_secret: SECRET,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      toolkit: "shopify",
      clientId: "shpca_id",
      replaced: false,
    });
    expect(body).not.toContain(SECRET);
    expect(stored).toEqual([
      {
        toolkit: "shopify",
        client: { client_id: "shpca_id", client_secret: SECRET },
        by: ADMIN.email,
      },
    ]);
  });

  test("half a client is refused, and nothing is stored", async () => {
    const { app, stored } = appFor({});
    const response = await request(app, "/composio/clients/shopify", {
      method: "PUT",
      body: JSON.stringify({ client_id: "shpca_id" }),
    });
    expect(response.status).toBe(400);
    expect(stored).toEqual([]);
  });

  test("a member can neither store, list nor remove one", async () => {
    const { app, stored, removed } = appFor({ role: "user" });
    for (const [path, method] of [
      ["/composio/clients/shopify", "PUT"],
      ["/composio/clients", "GET"],
      ["/composio/clients/shopify", "DELETE"],
    ] as const) {
      const response = await request(app, path, {
        method,
        ...(method === "PUT"
          ? {
              body: JSON.stringify({
                client_id: "id",
                client_secret: SECRET,
              }),
            }
          : {}),
      });
      expect(response.status).toBe(403);
    }
    expect(stored).toEqual([]);
    expect(removed).toEqual([]);
  });

  test("an administrator lists and removes them", async () => {
    const { app, removed } = appFor({});
    const listed = await request(app, "/composio/clients");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      clients: [{ toolkit: "shopify", clientId: "shpca_id", storedAt: null }],
    });
    const gone = await request(app, "/composio/clients/shopify", {
      method: "DELETE",
    });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ removed: true });
    expect(removed).toEqual([{ toolkit: "shopify", by: ADMIN.email }]);
  });
});

describe("the directory and the enable, with and without a client", () => {
  test("without a client the app is not offered", async () => {
    const { app } = appFor({});
    const response = await request(app, "/composio/apps");
    expect(
      (await response.json()).apps.map((entry: { slug: string }) => entry.slug),
    ).toEqual(["slack"]);
  });

  test("a vault that cannot be read offers it no more than no client does", async () => {
    const { app } = appFor({ heldThrows: true });
    const realError = console.error;
    console.error = () => {};
    try {
      const response = await request(app, "/composio/apps");
      expect(response.status).toBe(200);
      expect(
        (await response.json()).apps.map(
          (entry: { slug: string }) => entry.slug,
        ),
      ).toEqual(["slack"]);
    } finally {
      console.error = realError;
    }
  });

  test("with a client the app is offered as a field scheme, and enabling records it so", async () => {
    const { app, added } = appFor({ held: ["shopify"] });
    const listed = await request(app, "/composio/apps");
    const shopify = (
      (await listed.json()).apps as { slug: string; connection: unknown }[]
    ).find((entry) => entry.slug === "shopify");
    expect(shopify?.connection).toEqual({
      kind: "fields",
      authScheme: "S2S_OAUTH2",
    });

    const enabled = await request(app, "/composio/apps", {
      method: "POST",
      body: JSON.stringify({ slug: "shopify" }),
    });
    expect(enabled.status).not.toBe(503);
    expect(added).toEqual([
      expect.objectContaining({
        slug: "shopify",
        connection: { kind: "fields", authScheme: "S2S_OAUTH2" },
      }),
    ]);
  });

  test("without a client the enable is refused with the reason", async () => {
    const { app, added } = appFor({});
    const enabled = await request(app, "/composio/apps", {
      method: "POST",
      body: JSON.stringify({ slug: "shopify" }),
    });
    expect(enabled.status).toBe(503);
    expect((await enabled.json()).error).toBe("needs a client");
    expect(added).toEqual([]);
  });
});

describe("connecting an app on the deployment's own client", () => {
  test("a person is refused before the form is even asked for", async () => {
    const { app, asked, connected } = appFor({ role: "user" });
    for (const body of [undefined, { values: { subdomain: "acme" } }]) {
      const response = await request(app, "/servers/composio-shopify/connect", {
        method: "POST",
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.status).toBe(403);
      expect((await response.json()).error).toContain("只有管理员能连接");
    }
    expect(asked).toEqual([]);
    expect(connected).toEqual([]);
  });

  test("an administrator gets the form, and the connect says it is theirs", async () => {
    const { app, asked, connected } = appFor({});
    const form = await request(app, "/servers/composio-shopify/connect", {
      method: "POST",
    });
    expect(form.status).toBe(200);
    expect(asked).toEqual([{ toolkit: "shopify", authScheme: "S2S_OAUTH2" }]);

    const response = await request(app, "/servers/composio-shopify/connect", {
      method: "POST",
      body: JSON.stringify({ values: { subdomain: "acme" } }),
    });
    expect(response.status).toBe(200);
    expect(connected).toEqual([
      {
        toolkit: "shopify",
        userId: ADMIN.id,
        values: { subdomain: "acme" },
        byAdmin: true,
      },
    ]);
  });
});
