import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CopilotRuntime, InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import { frameworkLabel } from "../src/agents/framework";
import { resetBrand, setBrand } from "../src/brand";
import { CATALOGUE } from "../src/plugins/catalogue";
import { buildComposioClient } from "../src/plugins/composio-adapter";
import { registerDynamicClient } from "../src/plugins/oauth";
import {
  disableRuntimeTelemetryByDefault,
  runtimeTelemetryOptions,
  silentRuntimeTelemetry,
} from "../src/telemetry/runtime-telemetry";

/*
 * What third parties and the model read about this deployment comes out of the brand exit, so a
 * tenant package that renames the product renames these too.
 */
afterEach(() => resetBrand());

const refuse = (name: string) => async () => {
  throw new Error(`unexpected call: ${name}`);
};
const vendor = (authConfigs: Record<string, unknown>) =>
  ({
    tools: {},
    toolkits: {},
    authConfigs: {
      list: refuse("authConfigs.list"),
      create: refuse("authConfigs.create"),
      delete: refuse("authConfigs.delete"),
      ...authConfigs,
    },
    connectedAccounts: {},
  }) as never;

describe("OAuth client registration", () => {
  test("introduces the deployment by the brand's English name", async () => {
    setBrand({ productName: "示例", englishName: "Example Work" });
    const bodies: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ client_id: "dyn-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      await registerDynamicClient({
        registrationUrl: "https://vendor.example/register",
        redirectUri: "https://x.example/cb",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(bodies[0]).toMatchObject({ client_name: "Example Work" });
  });
});

describe("first-party catalogue entries", () => {
  const firstParty = () =>
    CATALOGUE.filter(({ key }) => key === "routines" || key === "staffing");

  test("name the brand's company as vendor and carry no docs link without a support URL", () => {
    setBrand({ productName: "示例", companyName: "示例公司" });
    expect(firstParty().map((entry) => entry.vendor)).toEqual([
      "示例公司",
      "示例公司",
    ]);
    expect(firstParty().map((entry) => entry.docsUrl)).toEqual([
      undefined,
      undefined,
    ]);
  });

  test("link to the support URL when one is set", () => {
    setBrand({ productName: "示例", supportUrl: "https://help.example/" });
    expect(firstParty().map((entry) => entry.docsUrl)).toEqual([
      "https://help.example/",
      "https://help.example/",
    ]);
  });
});

describe("Composio auth config provenance", () => {
  test("a new config is named with the brand's English name", async () => {
    setBrand({ productName: "示例", englishName: "Example Work" });
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      vendor({
        list: async () => ({ items: [] }),
        create: async (...call: unknown[]) => {
          created.push(call);
          return { id: "ac_new" };
        },
      }),
    );
    await broker.ensureAuthConfig({
      toolkit: "linear",
      name: "Linear",
      connection: { kind: "consent" },
    });
    expect(created).toEqual([
      [
        "linear",
        { type: "use_composio_managed_auth", name: "Linear (Example Work)" },
      ],
    ]);
  });

  // Provenance is read from the NAME, so a config made before the rename must still be found or
  // enabling the app again would create the split this suffix exists to prevent.
  test.each([
    ["written before the rename", "Linear (OpenBot)"],
    ["written under the current brand", "Linear (Example Work)"],
  ])(
    "a config %s is found and no second one is created",
    async (_case, name) => {
      setBrand({ productName: "示例", englishName: "Example Work" });
      const created: unknown[] = [];
      const { broker } = buildComposioClient(
        vendor({
          list: async () => ({
            items: [{ id: "ac_old", name, status: "ENABLED" }],
          }),
          create: async (...call: unknown[]) => {
            created.push(call);
            return { id: "ac_new" };
          },
        }),
      );
      await broker.ensureAuthConfig({
        toolkit: "linear",
        name: "Linear",
        connection: { kind: "consent" },
      });
      expect(created).toEqual([]);
    },
  );
});

describe("the framework the model is told", () => {
  test("is the product's English name for a Bot that runs here, and unchanged for others", () => {
    setBrand({ productName: "示例", englishName: "Example Work" });
    expect(frameworkLabel("OpenBot")).toBe("Example Work");
    expect(frameworkLabel("Claude Agent SDK")).toBe("Claude Agent SDK");
  });
});

describe("runtime telemetry", () => {
  test("a runtime built with the deployment's options reports through the silent scope", async () => {
    const runtime = new CopilotRuntime({
      agents: {},
      runner: new InMemoryAgentRunner(),
      ...runtimeTelemetryOptions,
    });
    expect(runtime.telemetry).toBe(silentRuntimeTelemetry);
    await expect(
      runtime.telemetry?.capture(
        "oss.runtime.instance_created" as never,
        {} as never,
      ),
    ).resolves.toBeUndefined();
  });

  test("mountCopilotRuntime spreads those options into the runtime it builds", () => {
    const copilot = readFileSync(
      new URL("../src/copilot.ts", import.meta.url),
      "utf8",
    );
    expect(copilot).toContain("...runtimeTelemetryOptions");
    expect(copilot).toContain("disableRuntimeTelemetryByDefault();");
  });

  test("the vendor's opt-out variable defaults on and respects an explicit choice", () => {
    const unset: Record<string, string | undefined> = {};
    disableRuntimeTelemetryByDefault(unset);
    expect(unset.COPILOTKIT_TELEMETRY_DISABLED).toBe("1");
    const chosen: Record<string, string | undefined> = {
      COPILOTKIT_TELEMETRY_DISABLED: "0",
    };
    disableRuntimeTelemetryByDefault(chosen);
    expect(chosen.COPILOTKIT_TELEMETRY_DISABLED).toBe("0");
  });

  test("the image also sets the variable", () => {
    const dockerfile = readFileSync(
      new URL("../../Dockerfile", import.meta.url),
      "utf8",
    );
    expect(dockerfile).toMatch(/^ENV COPILOTKIT_TELEMETRY_DISABLED=1$/m);
  });
});
