import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { createPurposeModel } from "../src/agents/purpose-model";
import type { DeploymentModel } from "../src/models/runtime-resolver";

/*
 * The model an employee uses for the small background jobs (automatic memory, the retrospective): its
 * light model (期 1·1.5) when it set one and the catalogue still offers it, otherwise the model it
 * always uses.
 */
const ordinary = { id: "ordinary" } as unknown as LanguageModel;
const light = { id: "light" } as unknown as LanguageModel;

function harness(
  overrides: {
    lightModelOf?: (agentId: string) => Promise<string | undefined>;
    allowed?: () => Promise<readonly string[]>;
    deployment?: (name?: string) => Promise<DeploymentModel | undefined>;
  } = {},
) {
  const resolved: { deployment: string; ignoreBinding: boolean }[] = [];
  const modelFor = createPurposeModel({
    resolve: async (_agent, deployment, options) => {
      const name = deployment?.modelName ?? "none";
      resolved.push({
        deployment: name,
        ignoreBinding: options?.ignoreBinding === true,
      });
      return name === "cheap" ? light : ordinary;
    },
    deployment: async (name) =>
      ({ modelName: name ?? "default" }) as unknown as DeploymentModel,
    lightModelOf: async () => "cheap",
    allowed: async () => ["default", "cheap"],
    ...overrides,
  });
  return { modelFor, resolved };
}

describe("purpose: light", () => {
  test("the employee's light model, built on the deployment, ahead of any binding it has", async () => {
    const { modelFor, resolved } = harness();
    expect(await modelFor("bot", "light")).toBe(light);
    expect(resolved).toEqual([{ deployment: "cheap", ignoreBinding: true }]);
  });

  test("none set: the model it always uses", async () => {
    const { modelFor, resolved } = harness({
      lightModelOf: async () => undefined,
    });
    expect(await modelFor("bot", "light")).toBe(ordinary);
    expect(resolved).toEqual([{ deployment: "default", ignoreBinding: false }]);
  });

  test("one the catalogue no longer offers, or a setting that cannot be read: the model it always uses", async () => {
    const gone = harness({ allowed: async () => ["default"] });
    expect(await gone.modelFor("bot", "light")).toBe(ordinary);
    const unreadable = harness({
      lightModelOf: async () => {
        throw new Error("db down");
      },
    });
    expect(await unreadable.modelFor("bot", "light")).toBe(ordinary);
    const catalogueDown = harness({
      allowed: async () => {
        throw new Error("no catalogue");
      },
    });
    expect(await catalogueDown.modelFor("bot", "light")).toBe(ordinary);
  });

  test("a light model that cannot be built (no key) is the model it always uses, not nothing", async () => {
    const { modelFor } = harness({
      deployment: async (name) =>
        name
          ? undefined
          : ({ modelName: "default" } as unknown as DeploymentModel),
    });
    expect(await modelFor("bot", "light")).toBe(ordinary);
  });
});

describe("purpose: work", () => {
  test("never reads the light setting", async () => {
    let read = 0;
    const { modelFor, resolved } = harness({
      lightModelOf: async () => {
        read += 1;
        return "cheap";
      },
    });
    expect(await modelFor("bot", "work")).toBe(ordinary);
    expect(read).toBe(0);
    expect(resolved).toEqual([{ deployment: "default", ignoreBinding: false }]);
  });

  test("nothing to run on is null, and a throw is null", async () => {
    const none = createPurposeModel({
      resolve: async () => null,
      deployment: async () => undefined,
      lightModelOf: async () => undefined,
      allowed: async () => [],
    });
    expect(await none("bot", "work")).toBeNull();
    const broken = createPurposeModel({
      resolve: async () => {
        throw new Error("x");
      },
      deployment: async () => undefined,
      lightModelOf: async () => undefined,
      allowed: async () => [],
    });
    expect(await broken("bot", "light")).toBeNull();
  });
});
