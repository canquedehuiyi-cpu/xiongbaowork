import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const environment = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
  KEY_ENCRYPTION_KEY: "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=",
  INTELLIGENCE_API_URL: "https://api.intelligence.copilotkit.ai",
  INTELLIGENCE_GATEWAY_WS_URL: "wss://realtime.intelligence.copilotkit.ai",
  INTELLIGENCE_API_KEY: "test-project-key",
  OPENBOT_SINGLE_USER: "true",
};

test("Learning is optional at startup even if a revision was left behind", () => {
  expect(loadConfig(environment).learning).toBeUndefined();
  expect(
    loadConfig({ ...environment, CPK_INTELLIGENCE_SKILLS_REVISION: "old" })
      .learning,
  ).toBeUndefined();
});

test("an operator can seed a validated default and optional opaque revision", () => {
  expect(
    loadConfig({
      ...environment,
      CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: " support-learning ",
      CPK_INTELLIGENCE_SKILLS_REVISION: "revision-1",
    }).learning,
  ).toEqual({ containerId: "support-learning", revision: "revision-1" });
  expect(() =>
    loadConfig({
      ...environment,
      CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: "Bad--Id",
    }),
  ).toThrow("CPK_INTELLIGENCE_LEARNING_CONTAINER_ID");
});

/*
 * CopilotKit Intelligence is OPTIONAL in this fork (R0): threads stay in the deployment's own
 * PostgreSQL either way, and Intelligence only adds learned-skill delivery.
 */
const withoutIntelligence = {
  DATABASE_URL: environment.DATABASE_URL,
  KEY_ENCRYPTION_KEY: environment.KEY_ENCRYPTION_KEY,
  OPENBOT_SINGLE_USER: "true",
};

test("without INTELLIGENCE_API_KEY there is no Intelligence, and the deployment boots", () => {
  const config = loadConfig(withoutIntelligence);
  expect(config.intelligence).toBeUndefined();
  expect(config.runtime.mode).toBe("local");
});

test("with the key, Intelligence is connected with whatever addresses were given", () => {
  expect(loadConfig(environment).intelligence).toEqual({
    apiKey: "test-project-key",
    apiUrl: "https://api.intelligence.copilotkit.ai",
    gatewayWsUrl: "wss://realtime.intelligence.copilotkit.ai",
  });
  // Managed Intelligence has default addresses, so the key alone is a complete configuration.
  expect(
    loadConfig({ ...withoutIntelligence, INTELLIGENCE_API_KEY: "k" })
      .intelligence,
  ).toEqual({ apiKey: "k" });
  expect(
    loadConfig({
      ...environment,
      COPILOTKIT_LICENSE_TOKEN: "licence",
    }).intelligence?.licenseToken,
  ).toBe("licence");
});

test("an address or licence without the key is a half-configured Intelligence, refused at boot", () => {
  for (const name of [
    "INTELLIGENCE_API_URL",
    "INTELLIGENCE_GATEWAY_WS_URL",
    "COPILOTKIT_LICENSE_TOKEN",
  ] as const) {
    expect(() =>
      loadConfig({
        ...withoutIntelligence,
        [name]: (environment as Record<string, string>)[name] ?? "licence",
      }),
    ).toThrow(name);
  }
});

test("the threads stay local: the platform-hosted mode is still refused", () => {
  expect(() =>
    loadConfig({ ...environment, INTELLIGENCE_MODE: "managed" }),
  ).toThrow("INTELLIGENCE_MODE");
});
