import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  envName,
  oldSettingsRefusal,
  settingsUnderOldNamesOnly,
} from "../../shared/env-name";
import { loadConfig } from "../src/config";

/*
 * Settings under the names they had before v0.2.16 (the old prefix) are refused, not read: v0.2.16 read
 * both and its upgrade sheet renamed every line, and this release is reached only from v0.2.16. The old
 * names below are the input under test.
 */
const OLD = "OPENBOT_";

const environment = {
  DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/xiongbao",
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
  });
});
