import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { parseAriaSnapshot } from "../src/aria-snapshot";
import {
  HIDDEN_FIELD_SELECTOR,
  hiddenValues,
  MASKED_VALUE,
  markElementSecret,
  markIfFilled,
  maskSensitiveValues,
  PERSON_FILLED_ATTRIBUTE,
  PERSON_FILLED_VALUE,
  SECRET_ATTRIBUTE,
  SENSITIVE_FIELD_SELECTOR,
} from "../src/secret-masking";
import { LOGIN_ATTRIBUTE } from "../src/sign-in";

/**
 * The attributes the computer writes into a third-party page carry no product name (L1-17), and
 * renaming them did not open a hole in the masking: every reader goes through the same constants, so
 * a password, a supplied secret and a field a person filled are still hidden from the snapshot and
 * masked in the screenshot.
 *
 * The browser half launches a real Chromium, like sign-in.test.ts, and is asked for by name:
 *
 *   cd agent-computer && bunx playwright install chromium
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/neutral-page-marks.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const PASSWORD = "hunter2-not-for-the-model";
const TOKEN = "tok_live_abc123";
const TELEPHONE = "555-0100";
const SRC = join(import.meta.dir, "..", "src");

test("the page mark names carry no product name", () => {
  expect(SECRET_ATTRIBUTE).toBe("data-xb-secret");
  expect(PERSON_FILLED_ATTRIBUTE).toBe("data-xb-person-filled");
  expect(LOGIN_ATTRIBUTE).toBe("data-xb-login");
  for (const name of [
    SECRET_ATTRIBUTE,
    PERSON_FILLED_ATTRIBUTE,
    LOGIN_ATTRIBUTE,
  ])
    expect(name).not.toMatch(/openbot|xiongbao/i);
});

test("the masking selectors are built from the renamed attributes", () => {
  expect(SENSITIVE_FIELD_SELECTOR).toContain("input[type=password]");
  expect(SENSITIVE_FIELD_SELECTOR).toContain("[data-xb-secret]");
  expect(HIDDEN_FIELD_SELECTOR).toContain("input[type=password]");
  expect(HIDDEN_FIELD_SELECTOR).toContain("[data-xb-secret]");
  expect(HIDDEN_FIELD_SELECTOR).toContain("[data-xb-person-filled]");
});

test("no source spells a data-openbot- attribute", () => {
  const spelled: string[] = [];
  for (const entry of readdirSync(SRC, { recursive: true })) {
    const file = String(entry);
    if (!/\.(ts|tsx|js|mjs|cjs|json|html|css)$/.test(file)) continue;
    readFileSync(join(SRC, file), "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (line.includes("data-openbot-"))
          spelled.push(`${file}:${index + 1}`);
      });
  }
  expect(spelled).toEqual([]);
});

describe.skipIf(!asked)(
  "a password field is still masked after the rename",
  () => {
    let browser: Browser;

    beforeAll(async () => {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ channel: "chromium" });
    });

    afterAll(async () => {
      await browser?.close();
    });

    /** The same page as sign-in.test.ts's masking test, with a field a person filled added. */
    async function markedPage(): Promise<Page> {
      const tab = await browser.newPage({
        viewport: { width: 600, height: 300 },
      });
      await tab.setContent(`<form style="display:grid;gap:12px;width:320px">
        <input aria-label="User" value="alice">
        <input aria-label="Password" id="password" type="password" value="${PASSWORD}">
        <input aria-label="API token" id="token" value="${TOKEN}">
        <input aria-label="Telephone" id="telephone" value="${TELEPHONE}">
      </form>`);
      // The token field is marked the way a supplied secret is, the telephone the way a takeover marks it.
      await tab.locator("#token").evaluate(markElementSecret, SECRET_ATTRIBUTE);
      await tab.locator("#telephone").evaluate(markIfFilled, {
        attribute: PERSON_FILLED_ATTRIBUTE,
        typed: true,
      });
      return tab;
    }

    test("a password field is still masked in the snapshot and the screenshot after the rename", async () => {
      const tab = await markedPage();
      try {
        // The marks the page now carries are the neutral ones.
        expect(await tab.locator("#token").getAttribute("data-xb-secret")).toBe(
          "true",
        );
        expect(
          await tab.locator("#telephone").getAttribute("data-xb-person-filled"),
        ).toBe("true");

        // The snapshot: the leak is real, and the masked snapshot does not carry it.
        const yaml = await tab.ariaSnapshot({ mode: "ai" });
        expect(yaml).toContain(PASSWORD);
        const { elements } = parseAriaSnapshot(yaml);
        const masked = maskSensitiveValues(
          elements,
          await hiddenValues(tab, elements),
        );
        const text = JSON.stringify(masked);
        expect(text).not.toContain(PASSWORD);
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain(TELEPHONE);
        expect(text).toContain("alice");
        expect(
          masked.filter((element) => element.value === MASKED_VALUE),
        ).toHaveLength(2);
        expect(
          masked.filter((element) => element.value === PERSON_FILLED_VALUE),
        ).toHaveLength(1);

        // The screenshot: the mask the computer hands Playwright covers all three fields, and paints them.
        const covered = await tab
          .locator(HIDDEN_FIELD_SELECTOR)
          .evaluateAll((fields) => fields.map((field) => field.id));
        expect(covered.sort()).toEqual(["password", "telephone", "token"]);

        const MASK = "#FF00FF";
        const shot = await tab.screenshot({
          type: "png",
          mask: [tab.locator(HIDDEN_FIELD_SELECTOR)],
          maskColor: MASK,
        });
        const centre = async (selector: string) => {
          const box = await tab.locator(selector).boundingBox();
          if (!box) throw new Error(`${selector} has no box`);
          return {
            x: Math.round(box.x + box.width / 2),
            y: Math.round(box.y + box.height / 2),
          };
        };
        const points = {
          password: await centre("#password"),
          token: await centre("#token"),
          telephone: await centre("#telephone"),
          user: await centre('[aria-label="User"]'),
        };
        // Read the picture's pixels back in a page of its own.
        const reader = await browser.newPage();
        try {
          const colours = await reader.evaluate(
            async ({ data, at }) => {
              const image = new Image();
              image.src = `data:image/png;base64,${data}`;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = image.width;
              canvas.height = image.height;
              const context = canvas.getContext("2d");
              if (!context) throw new Error("no 2d context");
              context.drawImage(image, 0, 0);
              const out: Record<string, number[]> = {};
              for (const [name, point] of Object.entries(at))
                out[name] = [
                  ...context.getImageData(point.x, point.y, 1, 1).data,
                ].slice(0, 3);
              return out;
            },
            { data: shot.toString("base64"), at: points },
          );
          const magenta = [255, 0, 255];
          expect(colours.password).toEqual(magenta);
          expect(colours.token).toEqual(magenta);
          expect(colours.telephone).toEqual(magenta);
          expect(colours.user).not.toEqual(magenta);
        } finally {
          await reader.close();
        }
      } finally {
        await tab.close();
      }
    });
  },
);
