import { describe, expect, test } from "bun:test";
import { buildComposioClient } from "../src/plugins/composio-adapter";
import { keyGuideFor } from "../src/plugins/key-guides";

/**
 * The broker's own link for making an app's key, and what its failures cost: only the link.
 *
 * `connectionGuideUrl` is answered beside the broker as `guides`, not among its methods (see
 * `KeyGuideSource` in `broker.ts`; review M-6), because none of its failures reaches a person:
 * the key form's first press reads any of them, and any delay, as "no link", and the maintained map
 * answers. This file is the table for that door: every kind of failure the adapter tests raise at
 * the other doors, raised here, ends as the map's guide and never as a refusal.
 */

const refuse = (what: string) => async () => {
  throw new Error(`${what} should not have been called in this test.`);
};

/** A vendor whose one live answer is the app detail; anything else names itself and fails. */
function vendorRetrieving(retrieve: (slug: string) => Promise<unknown>) {
  return {
    tools: {
      list: refuse("tools.list"),
      getRawComposioToolBySlug: refuse("tools.getRawComposioToolBySlug"),
      execute: refuse("tools.execute"),
    },
    toolkits: { list: refuse("toolkits.list"), retrieve },
    authConfigs: {
      list: refuse("authConfigs.list"),
      create: refuse("authConfigs.create"),
      delete: refuse("authConfigs.delete"),
    },
    connectedAccounts: {
      list: refuse("connectedAccounts.list"),
      link: refuse("connectedAccounts.link"),
      create: refuse("connectedAccounts.create"),
      delete: refuse("connectedAccounts.delete"),
    },
  };
}

const FIRECRAWL_MAP = {
  steps: "登录 Firecrawl，在 API Keys 页面复制你的密钥。",
  url: "https://www.firecrawl.dev/app/api-keys",
};

const THROWN: { kind: string; raise: () => Error }[] = [
  { kind: "an outage", raise: () => new Error("socket hang up") },
  {
    kind: "a named vendor condition",
    raise: () =>
      Object.assign(new Error("Toolkit firecrawl not found."), {
        name: "ComposioToolkitNotFoundError",
      }),
  },
  {
    kind: "a shape the SDK itself could not read",
    raise: () =>
      new TypeError(
        "undefined is not an object (evaluating 'response.items.map')",
      ),
  },
];

describe("the broker's link for an app's key", () => {
  test("is beside the broker, and not among the methods the seam's failure table enumerates", () => {
    const { broker, guides } = buildComposioClient(
      vendorRetrieving(refuse("toolkits.retrieve")) as never,
    );
    expect(typeof guides.connectionGuideUrl).toBe("function");
    expect("connectionGuideUrl" in broker).toBe(false);
  });

  test("the mode's hint wins over the app's guide, and anything not text is no link", async () => {
    const { guides } = buildComposioClient(
      vendorRetrieving(async () => ({
        auth_guide_url: "https://example.com/guide",
        auth_config_details: [
          { mode: "OAUTH2", auth_hint_url: "https://example.com/oauth" },
          { mode: "API_KEY", auth_hint_url: "https://example.com/key" },
        ],
      })) as never,
    );
    expect(
      await guides.connectionGuideUrl({
        toolkit: "firecrawl",
        authScheme: "API_KEY",
      }),
    ).toBe("https://example.com/key");

    const { guides: bare } = buildComposioClient(
      vendorRetrieving(async () => ({
        auth_guide_url: 42,
        auth_config_details: "not a list",
      })) as never,
    );
    expect(
      await bare.connectionGuideUrl({
        toolkit: "firecrawl",
        authScheme: "API_KEY",
      }),
    ).toBeNull();
  });

  for (const thrown of THROWN) {
    test(`${thrown.kind} costs only the link: the map answers`, async () => {
      const { guides } = buildComposioClient(
        vendorRetrieving(async () => {
          throw thrown.raise();
        }) as never,
      );
      expect(
        await keyGuideFor({
          ask: guides.connectionGuideUrl.bind(guides),
          toolkit: "firecrawl",
          authScheme: "API_KEY",
          title: "Firecrawl",
        }),
      ).toEqual(FIRECRAWL_MAP);
    });
  }

  test("a link that never comes is no link once the bound passes", async () => {
    const guide = await keyGuideFor({
      ask: () => new Promise<string | null>(() => {}),
      toolkit: "firecrawl",
      authScheme: "API_KEY",
      title: "Firecrawl",
      afterMs: 10,
    });
    expect(guide).toEqual(FIRECRAWL_MAP);
  });

  test("a broker that throws before it returns a promise costs only the link too", async () => {
    const guide = await keyGuideFor({
      ask: () => {
        throw new Error("synchronous");
      },
      toolkit: "0codekit",
      authScheme: "API_KEY",
      title: "0CodeKit",
    });
    expect(guide.url).toBeNull();
    expect(guide.steps).toContain("0CodeKit");
  });

  test("the broker's own provider link is used ahead of the map", async () => {
    const guide = await keyGuideFor({
      ask: async () => "https://docs.firecrawl.dev/keys",
      toolkit: "firecrawl",
      authScheme: "API_KEY",
      title: "Firecrawl",
    });
    expect(guide).toEqual({
      steps: FIRECRAWL_MAP.steps,
      url: "https://docs.firecrawl.dev/keys",
    });
  });
});
