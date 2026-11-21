/**
 * Screenshots of first-run onboarding, which the route list cannot take: the fixture user has no
 * onboarding to do, so `/onboarding` sends them home. Here `/api/me` answers with somebody partway
 * through (no name yet, so every step is in the list), and each step is opened by its `?step=`.
 *
 *   bun tests/parity/onboarding-shots.ts --out <dir> [--base http://127.0.0.1:3910]
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { newContext } from "./capture";
import { USER } from "./fixtures";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};
const base = flag("--base", "http://127.0.0.1:3910");
const out = flag("--out", "onboarding-shots");
mkdirSync(out, { recursive: true });

const STEPS = ["welcome", "sources", "name"] as const;
const SHOTS = [
  { theme: "dark", width: 1440, height: 900 },
  { theme: "light", width: 1440, height: 900 },
  { theme: "dark", width: 390, height: 844 },
] as const;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
});
try {
  for (const shot of SHOTS) {
    const unmatched = new Set<string>();
    const context = await newContext(
      browser,
      {
        base,
        out,
        scenarios: ["data"],
        themes: [shot.theme],
        only: undefined,
        path: undefined,
        viewports: [{ width: shot.width, height: shot.height }],
        concurrency: 1,
      },
      "data",
      shot.theme,
      { width: shot.width, height: shot.height },
      unmatched,
      new Set(),
    );
    // Registered after the fixtures, so it is the one that answers.
    await context.route(/\/api\/me$/, (route) =>
      route.fulfill({
        json: {
          user: {
            ...USER,
            name: null,
            needsName: true,
            onboarding: { step: 4, completedAt: null },
          },
        },
      }),
    );
    const page = await context.newPage();
    for (const step of STEPS) {
      await page.goto(`${base}/onboarding?step=${step}`);
      await page.waitForSelector("[data-onboarding-frame] h1");
      await page.waitForTimeout(600);
      const file = join(
        out,
        `onboarding-${step}-${shot.theme}-${shot.width}x${shot.height}.png`,
      );
      await page.screenshot({ path: file });
      console.log(file);
    }
    if (unmatched.size > 0) console.log("unmatched:", [...unmatched]);
    await context.close();
  }
} finally {
  await browser.close();
}
