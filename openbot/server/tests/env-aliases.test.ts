import { describe, expect, test } from "bun:test";
import { applyEnvironmentAliases } from "../../shared/env-aliases";
import { loadConfig } from "../src/config";

describe("applyEnvironmentAliases", () => {
  test("legacy-only names are left alone and report no conflict", () => {
    const env: Record<string, string | undefined> = {
      OPENBOT_PUBLIC_URL: "http://a",
    };
    expect(applyEnvironmentAliases(env)).toEqual({ conflicts: [] });
    expect(env).toEqual({ OPENBOT_PUBLIC_URL: "http://a" });
  });

  test("a new name with no legacy counterpart is copied onto the legacy name", () => {
    const env: Record<string, string | undefined> = {
      XIONGBAO_PUBLIC_URL: "http://b",
    };
    expect(applyEnvironmentAliases(env)).toEqual({ conflicts: [] });
    expect(env.OPENBOT_PUBLIC_URL).toBe("http://b");
    expect(env.XIONGBAO_PUBLIC_URL).toBe("http://b");
  });

  test("both set and different: the new value wins and the legacy name is reported", () => {
    const env: Record<string, string | undefined> = {
      XIONGBAO_PUBLIC_URL: "http://new",
      OPENBOT_PUBLIC_URL: "http://old",
    };
    expect(applyEnvironmentAliases(env)).toEqual({
      conflicts: ["OPENBOT_PUBLIC_URL"],
    });
    expect(env.OPENBOT_PUBLIC_URL).toBe("http://new");
  });

  test("both set and equal: no conflict", () => {
    const env: Record<string, string | undefined> = {
      XIONGBAO_RLS_ENFORCE: "refuse",
      OPENBOT_RLS_ENFORCE: "refuse",
    };
    expect(applyEnvironmentAliases(env)).toEqual({ conflicts: [] });
    expect(env.OPENBOT_RLS_ENFORCE).toBe("refuse");
  });

  test("the bare prefix and undefined values are ignored, and nothing is copied backwards", () => {
    const env: Record<string, string | undefined> = {
      XIONGBAO_: "x",
      XIONGBAO_EMPTY: undefined,
      OPENBOT_ONLY_OLD: "old",
    };
    expect(applyEnvironmentAliases(env)).toEqual({ conflicts: [] });
    expect(env.OPENBOT_).toBeUndefined();
    expect(env.OPENBOT_EMPTY).toBeUndefined();
    expect(env.XIONGBAO_ONLY_OLD).toBeUndefined();
  });

  test("an empty new value still overrides, matching how an empty variable reads elsewhere", () => {
    const env: Record<string, string | undefined> = {
      XIONGBAO_X: "",
      OPENBOT_X: "v",
    };
    expect(applyEnvironmentAliases(env)).toEqual({ conflicts: ["OPENBOT_X"] });
    expect(env.OPENBOT_X).toBe("");
  });
});

/*
 * Scripts (fire-routines, cull-idle-computers, reseal-credentials, …) call loadConfig without importing the server's
 * entry, so the alias step has to happen inside loadConfig for them to honour the XIONGBAO_ names.
 */
describe("loadConfig reads the XIONGBAO_ names", () => {
  const base = {
    DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
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

  test("a deployment written with the new names configures what the old names do", () => {
    const renamed = loadConfig({ ...base, ...settings("XIONGBAO_") });
    const legacy = loadConfig({ ...base, ...settings("OPENBOT_") });
    expect(renamed.publicUrl).toBe("https://work.example.com");
    expect(renamed.selfHostBanner).toBe(true);
    expect(renamed.generativeUi).toBe(false);
    expect(renamed).toEqual(legacy);
  });

  test("an environment handed in is read through a copy, never written to", () => {
    const environment: Record<string, string | undefined> = {
      ...base,
      XIONGBAO_PUBLIC_URL: "https://work.example.com",
    };
    expect(loadConfig(environment).publicUrl).toBe("https://work.example.com");
    expect(environment.OPENBOT_PUBLIC_URL).toBeUndefined();
  });

  test("the process environment is aliased in place, for the reads a script makes after it", () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, base, {
        XIONGBAO_RLS_ENFORCE: "warn",
      });
      delete process.env.OPENBOT_RLS_ENFORCE;
      loadConfig();
      expect(process.env.OPENBOT_RLS_ENFORCE).toBe("warn");
    } finally {
      for (const name of Object.keys(process.env))
        if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });
});
