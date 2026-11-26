import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYWRIGHT_DISABLED_FEATURES } from "../src/installed-browser";

const original = { ...process.env };
afterEach(() => {
  for (const name of [
    "COMPUTER_BROWSER_BACKEND",
    "COMPUTER_BROWSER_MODE",
    "COMPUTER_SANDBOX",
  ]) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

// The root CI install deliberately excludes this separately deployed package's dependencies.
describe.skipIf(
  !existsSync(join(import.meta.dir, "../node_modules/playwright/package.json")),
)("persistent launch options", () => {
  test.each([["managed"], ["local-chrome"]] as const)(
    "%s passes the runtime to the persistent launcher",
    async (backend) => {
      const { chromium } = await import("playwright");
      process.env.COMPUTER_BROWSER_BACKEND = backend;
      delete process.env.COMPUTER_BROWSER_MODE;
      delete process.env.COMPUTER_SANDBOX;
      const launch = spyOn(
        chromium,
        "launchPersistentContext",
      ).mockImplementation(async () => {
        throw new Error("launch inspected without starting a browser");
      });
      const { createProfiles } = await import(
        `../src/profiles?launch-options=${backend}`
      );
      const root = await mkdtemp(join(tmpdir(), "xiongbao-launch-options-"));
      const profiles = createProfiles(root);
      try {
        await expect(profiles.page("bot-one")).rejects.toThrow(
          "launch inspected",
        );
        expect(launch).toHaveBeenCalledTimes(1);
        const [directory, options] = launch.mock.calls[0]!;
        expect(directory).toBe(join(root, "bot-one"));
        expect(options?.channel).toBe(
          backend === "managed" ? "chromium" : "chrome",
        );
        // Managed is headed where hosted computers run (Linux) and headless on a developer's machine.
        expect(options?.headless).toBe(
          backend === "managed" && process.platform !== "linux",
        );
        expect(options?.handleSIGINT).toBe(false);
        expect(options?.handleSIGTERM).toBe(false);
        if (backend === "local-chrome") {
          expect(options?.chromiumSandbox).toBe(true);
          expect(options?.args).not.toContain("--password-store=basic");
          expect(options?.args).not.toContain("--no-sandbox");
        }
        /*
         * The whole launch, pinned. A Bot's browser keeps exactly these options, with every Playwright default
         * it had before. Its features are Playwright's own and AcceptCHFrame, off for every browser behind the
         * egress filter, or Google never loads in it (profiles.ts).
         */
        const features = `--disable-features=${[
          ...PLAYWRIGHT_DISABLED_FEATURES,
          "AcceptCHFrame",
        ].join(",")}`;
        expect(options).toEqual({
          channel: backend === "managed" ? "chromium" : "chrome",
          headless: backend === "managed" && process.platform !== "linux",
          args:
            backend === "managed"
              ? [
                  "--no-sandbox",
                  "--disable-dev-shm-usage",
                  "--password-store=basic",
                  "--disable-blink-features=AutomationControlled",
                  features,
                ]
              : [
                  "--disable-dev-shm-usage",
                  "--disable-blink-features=AutomationControlled",
                  features,
                ],
          ignoreDefaultArgs: ["--enable-automation"],
          chromiumSandbox: backend === "local-chrome",
          viewport: { width: 1280, height: 800 },
          handleSIGTERM: false,
          handleSIGINT: false,
          handleSIGHUP: false,
        });
      } finally {
        await profiles.closeAll();
        launch.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
