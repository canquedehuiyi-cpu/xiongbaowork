import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createSelfHostBanner } from "../src/self-host-banner";
import { testEnvironment } from "./support/environment";

describe("the self-host banner", () => {
  test("follows the operator's switch", async () => {
    expect(await createSelfHostBanner({ enabled: false }).shown()).toBe(false);
    expect(await createSelfHostBanner({ enabled: true }).shown()).toBe(true);
  });
});

describe("the capabilities endpoint", () => {
  const config = loadConfig(testEnvironment());

  // createApp takes its services positionally. Here the banner is the 37th (after this fork's
  // thread reader and quota), followed by the identity store and the GitHub sign-in callback.
  const SELF_HOST_BANNER_ARG = 36;
  function appWith(banner: ReturnType<typeof createSelfHostBanner>) {
    const args: unknown[] = new Array(createApp.length).fill(undefined);
    args[0] = config;
    args[SELF_HOST_BANNER_ARG] = banner;
    return (createApp as (...input: unknown[]) => ReturnType<typeof createApp>)(
      ...args,
    );
  }

  test("hides the banner when the operator switched it off", async () => {
    const app = appWith(createSelfHostBanner({ enabled: false }));
    const response = await app.request("/api/capabilities");
    expect((await response.json()).selfHostBanner).toBe(false);
  });

  test("shows it when the operator switched it on", async () => {
    const app = appWith(createSelfHostBanner({ enabled: true }));
    const response = await app.request("/api/capabilities");
    expect((await response.json()).selfHostBanner).toBe(true);
  });
});
