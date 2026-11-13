import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";

/**
 * 上游 `config.test.ts` 里「读 Arcade key 和 broker 提供商」那一条（X5 移植），单独成文件，
 * 因为 fork 的 `config.test.ts` 不改。另加一条 fork 的底线：两个变量都不设时，配置对象里
 * 根本没有这两个字段，与以前一模一样。
 */
const baseEnvironment = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
  BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
  BETTER_AUTH_URL: "http://localhost:3001",
  INITIAL_ADMIN_EMAILS: "admin@openbot.test",
  MANAGED_AGENT_AG_UI_URL: " http://localhost:4200/ag-ui ",
  MANAGED_AGENT_TOKEN: "managed-agent-token",
};

test("an Arcade key and a broker provider are read, and an unknown provider is refused", () => {
  const unset = loadConfig(baseEnvironment);
  // 上游答一个值为 undefined 的属性；fork 不设时根本没有这两个属性（见下一条）。
  expect(unset.arcadeApiKey).toBeUndefined();
  expect(unset.brokerProvider).toBeUndefined();
  const set = loadConfig({
    ...baseEnvironment,
    ARCADE_API_KEY: "  arc_example  ",
    OPENBOT_BROKER_PROVIDER: " arcade ",
  });
  expect(set.arcadeApiKey).toBe("arc_example");
  expect(set.brokerProvider).toBe("arcade");
  expect(() =>
    loadConfig({ ...baseEnvironment, OPENBOT_BROKER_PROVIDER: "zapier" }),
  ).toThrow(/XIONGBAO_BROKER_PROVIDER 只能是 "composio" 或 "arcade"/);
});

test("neither variable set leaves the config exactly as it was: no Arcade fields at all", () => {
  const config = loadConfig({ ...baseEnvironment, COMPOSIO_API_KEY: "c" });
  expect(Object.keys(config)).not.toContain("arcadeApiKey");
  expect(Object.keys(config)).not.toContain("brokerProvider");
  expect(config.composioApiKey).toBe("c");
});

test("a blank Arcade key is no key", () => {
  const config = loadConfig({ ...baseEnvironment, ARCADE_API_KEY: "   " });
  expect(Object.keys(config)).not.toContain("arcadeApiKey");
});
