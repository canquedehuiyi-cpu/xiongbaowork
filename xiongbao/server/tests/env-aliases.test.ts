import { describe, expect, test } from "bun:test";
import {
  applyEnvironmentAliases,
  reportEnvironmentAliases,
} from "../../shared/env-aliases";
import { loadConfig } from "../src/config";

/*
 * The old OPENBOT_ spellings below are the point of this file: they prove that a deployment written
 * before the rename still configures the server.
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
 */
describe("applyEnvironmentAliases", () => {
  test("old-only deployment reads the new name", () => {
    const env: Record<string, string | undefined> = {
      OPENBOT_PUBLIC_URL: "http://a",
    };
    expect(applyEnvironmentAliases(env)).toEqual({
      conflicts: [],
      legacy: ["OPENBOT_PUBLIC_URL"],
    });
    expect(env.XIONGBAO_PUBLIC_URL).toBe("http://a");
    // The old name stays where it was: nothing is taken away from a process that reads it itself.
    expect(env.OPENBOT_PUBLIC_URL).toBe("http://a");
  });

  test("conflicting old and new names keep the new value and report the old name", () => {
    const env: Record<string, string | undefined> = {
      XIONGBAO_PUBLIC_URL: "http://new",
      OPENBOT_PUBLIC_URL: "http://old",
    };
    expect(applyEnvironmentAliases(env)).toEqual({
      conflicts: ["OPENBOT_PUBLIC_URL"],
      legacy: [],
    });
    expect(env.XIONGBAO_PUBLIC_URL).toBe("http://new");
  });

  test("new-only deployment reports nothing", () => {
    const env: Record<string, string | undefined> = {
      XIONGBAO_PUBLIC_URL: "http://b",
      XIONGBAO_RLS_ENFORCE: "refuse",
    };
    expect(applyEnvironmentAliases(env)).toEqual({
      conflicts: [],
      legacy: [],
    });
    expect(env).toEqual({
      XIONGBAO_PUBLIC_URL: "http://b",
      XIONGBAO_RLS_ENFORCE: "refuse",
    });
  });

  test("both set and equal: no conflict, and the old name is still reported as in use", () => {
    // What the container's alias step leaves for an env file with old names: the server still says so.
    const env: Record<string, string | undefined> = {
      XIONGBAO_RLS_ENFORCE: "refuse",
      OPENBOT_RLS_ENFORCE: "refuse",
    };
    expect(applyEnvironmentAliases(env)).toEqual({
      conflicts: [],
      legacy: ["OPENBOT_RLS_ENFORCE"],
    });
  });

  test("an empty new name counts as unset, as an image's unset build argument leaves it", () => {
    const env: Record<string, string | undefined> = {
      XIONGBAO_BUILD_VERSION: "",
      OPENBOT_BUILD_VERSION: "v1",
    };
    expect(applyEnvironmentAliases(env)).toEqual({
      conflicts: [],
      legacy: ["OPENBOT_BUILD_VERSION"],
    });
    expect(env.XIONGBAO_BUILD_VERSION).toBe("v1");
  });

  test("an empty or undefined old name is not copied, and the bare prefix is ignored", () => {
    const env: Record<string, string | undefined> = {
      OPENBOT_: "x",
      OPENBOT_EMPTY: "",
      OPENBOT_UNSET: undefined,
    };
    expect(applyEnvironmentAliases(env)).toEqual({
      conflicts: [],
      legacy: [],
    });
    expect(env.XIONGBAO_).toBeUndefined();
    expect(env.XIONGBAO_EMPTY).toBeUndefined();
    expect(env.XIONGBAO_UNSET).toBeUndefined();
  });

  test("a platform model key is copied like any other: v0.2.16 renames the pool row that names it", () => {
    const env: Record<string, string | undefined> = {
      OPENBOT_POOL_OPENAI: "sk-test",
    };
    expect(applyEnvironmentAliases(env)).toEqual({
      conflicts: [],
      legacy: ["OPENBOT_POOL_OPENAI"],
    });
    expect(env.XIONGBAO_POOL_OPENAI).toBe("sk-test");
  });

  test("names come back sorted, so the warning reads the same on every start", () => {
    const env: Record<string, string | undefined> = {
      OPENBOT_SINGLE_USER: "true",
      OPENBOT_PUBLIC_URL: "http://a",
    };
    expect(applyEnvironmentAliases(env).legacy).toEqual([
      "OPENBOT_PUBLIC_URL",
      "OPENBOT_SINGLE_USER",
    ]);
  });
});

describe("reportEnvironmentAliases", () => {
  test("one line names every old name in use, one line per conflict, and no value is printed", () => {
    const lines: string[] = [];
    const env = {
      OPENBOT_PUBLIC_URL: "http://secret-host.example",
      OPENBOT_SINGLE_USER: "true",
      OPENBOT_SELF_HOST_BANNER: "true",
      XIONGBAO_SELF_HOST_BANNER: "false",
    };
    reportEnvironmentAliases(
      applyEnvironmentAliases(env),
      (line) => lines.push(line),
      new Set(),
    );
    expect(lines).toHaveLength(2);
    const conflict = lines.find((line) =>
      line.includes("OPENBOT_SELF_HOST_BANNER"),
    );
    expect(conflict).toContain("XIONGBAO_SELF_HOST_BANNER");
    const legacy = lines.find((line) => line.includes("OPENBOT_PUBLIC_URL"));
    expect(legacy).toContain("OPENBOT_SINGLE_USER");
    expect(legacy).toContain("XIONGBAO_");
    const printed = lines.join("\n");
    expect(printed).not.toContain("secret-host");
    expect(printed).not.toContain("true");
    expect(printed).not.toContain("false");
  });

  test("a name already reported in this process is not reported again", () => {
    const lines: string[] = [];
    const seen = new Set<string>();
    const result = {
      conflicts: ["OPENBOT_RLS_ENFORCE"],
      legacy: ["OPENBOT_PUBLIC_URL"],
    };
    reportEnvironmentAliases(result, (line) => lines.push(line), seen);
    reportEnvironmentAliases(result, (line) => lines.push(line), seen);
    expect(lines).toHaveLength(2);
  });

  test("nothing to report prints nothing", () => {
    const lines: string[] = [];
    reportEnvironmentAliases(
      { conflicts: [], legacy: [] },
      (line) => lines.push(line),
      new Set(),
    );
    expect(lines).toEqual([]);
  });
});

/*
 * Scripts (fire-routines, cull-idle-computers, reseal-credentials, …) call loadConfig without importing the server's
 * entry, so the alias step has to happen inside loadConfig for them to honour the old names too.
 */
describe("loadConfig reads both spellings", () => {
  const base = {
    DATABASE_URL: "postgres://openbot:openbot@localhost:5432/xiongbao",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
    BETTER_AUTH_URL: "http://localhost:3001",
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
    MANAGED_AGENT_TOKEN: "managed-agent-token",
    INITIAL_ADMIN_EMAILS: "admin@example.com",
  };
  const settings = (prefix: string) => ({
    [`${prefix}PUBLIC_URL`]: "https://work.example.com/",
    [`${prefix}SELF_HOST_BANNER`]: "true",
    [`${prefix}GENERATIVE_UI`]: "false",
    [`${prefix}RLS_ENFORCE`]: "refuse",
  });

  test("a deployment written with the old names configures what the new names do", () => {
    const renamed = loadConfig({ ...base, ...settings("XIONGBAO_") });
    const legacy = loadConfig({ ...base, ...settings("OPENBOT_") });
    expect(renamed.publicUrl).toBe("https://work.example.com");
    expect(renamed.selfHostBanner).toBe(true);
    expect(renamed.generativeUi).toBe(false);
    expect(legacy).toEqual(renamed);
  });

  test("an environment handed in is read through a copy, never written to", () => {
    const environment: Record<string, string | undefined> = {
      ...base,
      OPENBOT_PUBLIC_URL: "https://work.example.com",
    };
    expect(loadConfig(environment).publicUrl).toBe("https://work.example.com");
    expect(environment.XIONGBAO_PUBLIC_URL).toBeUndefined();
  });

  test("the process environment is aliased in place, for the reads a script makes after it", () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, base, {
        OPENBOT_RLS_ENFORCE: "warn",
      });
      delete process.env.XIONGBAO_RLS_ENFORCE;
      loadConfig();
      /*
       * A fresh copy: `delete` above narrowed the property itself to `undefined`, and TypeScript keeps
       * that narrowing across the call that put it back.
       */
      const aliased = { ...process.env };
      expect(aliased.XIONGBAO_RLS_ENFORCE).toBe("warn");
    } finally {
      for (const name of Object.keys(process.env))
        if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });
});
