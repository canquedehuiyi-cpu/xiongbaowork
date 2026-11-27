import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OLD_ENV_PREFIX } from "../../scripts/brand/guard/words";
import {
  envName,
  isProductSetting,
  oldSettingsRefusal,
  PRODUCT_SETTINGS,
  settingsUnderOldNamesOnly,
} from "../../shared/env-name";
import { loadConfig } from "../src/config";

/*
 * Settings under the names they had before v0.2.16 (the old prefix) are refused, not read: v0.2.16 read
 * both and its upgrade sheet renamed every line, and this release is reached only from v0.2.16. The old
 * names below are the input under test.
 */
const OLD = OLD_ENV_PREFIX;

const environment = {
  DATABASE_URL: "postgres://xiongbao:xiongbao@127.0.0.1:5432/xiongbao",
  KEY_ENCRYPTION_KEY: "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=",
  XIONGBAO_SINGLE_USER: "true",
};

function refusal(overrides: Record<string, string>): string {
  try {
    loadConfig({ ...environment, ...overrides });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("loadConfig accepted a value it should have refused");
}

describe("envName", () => {
  test("puts the XIONGBAO_ prefix on a suffix", () => {
    expect(envName("PUBLIC_URL")).toBe("XIONGBAO_PUBLIC_URL");
  });
});

describe("settingsUnderOldNamesOnly", () => {
  test("an old name with a value and no new name is found", () => {
    expect(
      settingsUnderOldNamesOnly({
        [`${OLD}PUBLIC_URL`]: "https://example.com",
        DATABASE_URL: "postgres://x",
      }),
    ).toEqual([`${OLD}PUBLIC_URL`]);
  });

  test("an empty new name counts as unset", () => {
    expect(
      settingsUnderOldNamesOnly({
        [`${OLD}PORT`]: "3000",
        XIONGBAO_PORT: "",
      }),
    ).toEqual([`${OLD}PORT`]);
  });

  test("a setting under both names is not one: the new one is in effect", () => {
    expect(
      settingsUnderOldNamesOnly({
        [`${OLD}PORT`]: "3000",
        XIONGBAO_PORT: "4000",
      }),
    ).toEqual([]);
  });

  test("an empty or undefined old name and the bare prefix are not settings", () => {
    expect(
      settingsUnderOldNamesOnly({
        [`${OLD}PORT`]: "",
        [`${OLD}IMAGE`]: undefined,
        [OLD]: "x",
      }),
    ).toEqual([]);
  });

  test("a new-only deployment has none", () => {
    expect(
      settingsUnderOldNamesOnly({
        XIONGBAO_PUBLIC_URL: "https://example.com",
        XIONGBAO_RLS_ENFORCE: "refuse",
      }),
    ).toEqual([]);
  });

  test("only the product's settings count: another tool's variable under the same prefix does not", () => {
    // Another tool may read these under the old prefix; they are no setting of this product.
    expect(
      settingsUnderOldNamesOnly({
        [`${OLD}UPSTREAM_REPOSITORY`]: "example/upstream",
        [`${OLD}UPSTREAM_COMMIT`]: "0123abc",
        [`${OLD}UPSTREAM_UPGRADES`]: "on",
        [`${OLD}UPGRADE_CHECKS`]: "all",
        [`${OLD}DISTRIBUTION_ID`]: "d",
        [`${OLD}SOMETHING_ELSE`]: "x",
      }),
    ).toEqual([]);
    expect(isProductSetting("UPSTREAM_REPOSITORY")).toBe(false);
  });

  test("a platform model key and a build identity count, by their families", () => {
    expect(
      settingsUnderOldNamesOnly({
        [`${OLD}POOL_DEEPSEEK`]: "sk-test",
        [`${OLD}BUILD_VERSION`]: "v1",
        [`${OLD}POOL_`]: "bare",
      }),
    ).toEqual([`${OLD}BUILD_VERSION`, `${OLD}POOL_DEEPSEEK`]);
  });

  test("names come back sorted, so the refusal reads the same on every start", () => {
    expect(
      settingsUnderOldNamesOnly({
        [`${OLD}RLS_ENFORCE`]: "warn",
        [`${OLD}IMAGE`]: "x",
        [`${OLD}PORT`]: "3000",
      }),
    ).toEqual([`${OLD}IMAGE`, `${OLD}PORT`, `${OLD}RLS_ENFORCE`]);
  });
});

describe("the refusal", () => {
  test("names every old setting and its new name, and never a value", () => {
    const message = oldSettingsRefusal([`${OLD}IMAGE`, `${OLD}PORT`]);
    expect(message).toContain(`${OLD}IMAGE, ${OLD}PORT`);
    expect(message).toContain("XIONGBAO_IMAGE, XIONGBAO_PORT");
    expect(message).toContain("请先升级到 v0.2.16");
  });

  test("loadConfig refuses a deployment that sets a setting only under its old name", () => {
    const message = refusal({ [`${OLD}BROKER_PROVIDER`]: "composio" });
    expect(message).toContain(`${OLD}BROKER_PROVIDER`);
    expect(message).toContain("XIONGBAO_BROKER_PROVIDER");
    expect(message).toContain("请先升级到 v0.2.16");
    expect(message).not.toContain("composio");
  });

  test("a start-up refusal for a bad value names the setting by its new name", () => {
    const message = refusal({ XIONGBAO_BROKER_PROVIDER: "not-a-provider" });
    expect(message).toContain("XIONGBAO_BROKER_PROVIDER");
    expect(message).not.toContain(OLD);
  });

  test("the entries' first import exits 1 before anything reads the environment, and is silent otherwise", () => {
    const entry = join(import.meta.dir, "../../shared/refuse-old-settings.ts");
    const run = (env: Record<string, string>) =>
      Bun.spawnSync(["bun", entry], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ...env,
        },
      });
    const refused = run({ [`${OLD}PUBLIC_URL`]: "https://secret.example" });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toContain(`${OLD}PUBLIC_URL`);
    expect(refused.stderr.toString()).not.toContain("secret.example");
    const started = run({ XIONGBAO_PUBLIC_URL: "https://example.com" });
    expect(started.exitCode).toBe(0);
    expect(started.stderr.toString()).toBe("");
    // A shell that still exports another tool's variables under the old prefix starts every process as before.
    const upstream = run({
      [`${OLD}UPSTREAM_REPOSITORY`]: "example/upstream",
      [`${OLD}UPSTREAM_COMMIT`]: "0123abc",
    });
    expect(upstream.exitCode).toBe(0);
    expect(upstream.stderr.toString()).toBe("");
  });

  test("a runner test run from a shell that exports another tool's old-prefix variables still runs", () => {
    const runner = join(import.meta.dir, "../../runner");
    const result = Bun.spawnSync(
      [process.execPath, "test", "tests/project-roots.test.ts"],
      {
        cwd: runner,
        env: {
          ...process.env,
          [`${OLD}UPSTREAM_REPOSITORY`]: "example/upstream",
        },
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }, 60_000);
});

/*
 * The list is the product's settings and nothing else, and it is kept with the source: every
 * `XIONGBAO_<X>` the production code names is either a setting on the list (or in a family), or one of the
 * names below that only share the prefix (run error codes, stored version names, constants, the families'
 * stems). A new setting that is not added fails here, so it cannot slip past the refusal.
 */
const NOT_SETTINGS = new Set([
  "APPROVAL_EXACT_AEAD_V1",
  "APPROVAL_EXACT_HEADER_V1",
  "APPROVAL_EXACT_SOURCE_BINDING_V1",
  "APPROVAL_EXACT_WIRE_V1",
  "EXACT_INPUT_JSON_V1",
  "MODEL_REFUSED",
  "HEADLESS_TOOL_ERROR",
  "TOOL_LIMIT_EXCEEDED",
  "TOOL_LIMIT",
  "ORB",
  "UI",
  "UI_ID",
  "UI_THEME",
  "ASKS",
  "HARNESS_NAME",
  "WAITING_METADATA",
  "PATH_END",
  "PATH_START",
  "WS_PORT",
  "BUILD",
  "POOL",
  "CRAWL",
  "EMBEDDING",
  "SEARCH",
  "VIDEO",
]);
const SOURCES = [
  "server/src",
  "shared",
  "worker/src",
  "runner/src",
  "supervisor/src",
  "toolkit/src",
  "agent-computer/src",
  "agent-*/src",
  "app/src",
  "app/vite.config.ts",
  "app/serve.ts",
  "scripts/start.sh",
  "scripts/start-local-chrome-computer.ts",
  "scripts/update.ts",
  "scripts/update-local.ts",
  "docker",
  "docker-compose.yml",
  "charts",
  "desktop-device/src-tauri/src",
  "Dockerfile",
  "server/Dockerfile",
];

describe("the product's settings", () => {
  test("every setting the production source names is on the list, and the list names nothing else", () => {
    const root = join(import.meta.dir, "../..");
    const grep = Bun.spawnSync(
      [
        "git",
        "grep",
        "-ohE",
        "XIONGBAO_[A-Z][A-Z0-9_]*[A-Z0-9]",
        "--",
        ...SOURCES,
        ":!**/*.test.*",
        ":!**/tests/**",
        ":!**/*.md",
      ],
      { cwd: root },
    );
    const named = new Set(
      grep.stdout
        .toString()
        .split("\n")
        .filter(Boolean)
        .map((name) => name.slice("XIONGBAO_".length)),
    );
    expect(named.size).toBeGreaterThan(100);
    const missing = [...named].filter(
      (suffix) => !NOT_SETTINGS.has(suffix) && !isProductSetting(suffix),
    );
    expect(missing).toEqual([]);
    const unknown = PRODUCT_SETTINGS.filter((suffix) => !named.has(suffix));
    expect(unknown).toEqual([]);
    expect([...PRODUCT_SETTINGS]).toEqual([...PRODUCT_SETTINGS].sort());
  });

  test("the container's own check refuses exactly the same list", () => {
    const script = readFileSync(
      join(import.meta.dir, "../../docker/s6/scripts/env-defaults.sh"),
      "utf8",
    );
    const listed = /\nsettings='\n([^']*)'\n/.exec(script)?.[1] ?? "";
    expect(listed.split(/\s+/).filter(Boolean)).toEqual([...PRODUCT_SETTINGS]);
    expect(script).toContain("BUILD_?* | POOL_?*)");
  });
});
