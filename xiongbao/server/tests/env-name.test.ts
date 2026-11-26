import { describe, expect, test } from "bun:test";
import { envName } from "../../shared/env-aliases";
import { loadConfig } from "../src/config";

const environment = {
  DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/xiongbao",
  KEY_ENCRYPTION_KEY: "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=",
  OPENBOT_SINGLE_USER: "true",
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

describe("a start-up refusal names the setting by its new name", () => {
  // The EDITION refusal is the same shape, but the existing config.test.ts still asserts its old spelling
  // (appendix A of the gradual-rewrite plan), so it is held back; this one setting stands for the rest.
  const bad = "not-a-provider";

  test("set under the new name", () => {
    const message = refusal({ XIONGBAO_BROKER_PROVIDER: bad });
    expect(message).toContain("XIONGBAO_BROKER_PROVIDER");
    expect(message).not.toContain("OPENBOT_");
  });

  test("set only under the old name, the refusal still says the new one", () => {
    const message = refusal({ OPENBOT_BROKER_PROVIDER: bad });
    expect(message).toContain("XIONGBAO_BROKER_PROVIDER");
    expect(message).not.toContain("OPENBOT_");
  });
});
