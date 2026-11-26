import { describe, expect, test } from "bun:test";
import { environmentFor } from "../src/environment";

const BOT = { kind: "bot", id: "bot-1" } as const;

/**
 * Whitespace-only `COMPUTER_TOKEN` used to be forwarded verbatim while the child trims and then
 * exits, a boot crash loop from a value the supervisor accepted. Invalid `COMPUTER_BROWSER_MODE`
 * was likewise forwarded to crash the child instead of failing fast here.
 */
describe("supervisor environment hardening", () => {
  test("omits a whitespace-only computer token", () => {
    expect(
      environmentFor(BOT, {
        COMPUTER_TOKEN: "   ",
        COMPUTER_BROWSER_MODE: "headless",
      }),
    ).toEqual([
      "COMPUTER_BOT_ID=bot-1",
      "COMPUTER_SEPARATE_WORKSPACES=on",
      "COMPUTER_BROWSER_MODE=headless",
    ]);
  });

  test("trims a padded token", () => {
    // The computer's own token, derived from the trimmed one: `HMAC-SHA256("secret",
    // "xiongbao computer token v1\nbot:bot-1")`, worked out with openssl rather than the code.
    expect(environmentFor(BOT, { COMPUTER_TOKEN: "  secret  " })).toContain(
      "COMPUTER_TOKEN=b6e2ee50a3c7b21ecc3b1e65f134a8aed6f6c52e323ab50df7ce089ad65e685b",
    );
  });

  test("refuses an invalid browser mode instead of forwarding it", () => {
    expect(() =>
      environmentFor(BOT, {
        COMPUTER_TOKEN: "s",
        COMPUTER_BROWSER_MODE: "fullscreen",
      }),
    ).toThrow(/headless or headed/);
  });

  test("accepts both valid modes", () => {
    for (const mode of ["headless", "headed"]) {
      expect(
        environmentFor(BOT, {
          COMPUTER_TOKEN: "s",
          COMPUTER_BROWSER_MODE: mode,
        }),
      ).toContain(`COMPUTER_BROWSER_MODE=${mode}`);
    }
  });
});
