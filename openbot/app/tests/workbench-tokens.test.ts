import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * The workbench palette (docs/design/ios-studio): 熊宝's 京剧脸谱 in black, white and red. Neutral
 * grounds and graphite cards, white (dark) or black (light) for the primary action and main text, and
 * red kept as a signal — selection, attention, the brand — never as a fill behind white words.
 * Surfaces are matte: opaque, with a faint sheen, not frosted glass.
 *
 * What is pinned is that shape, and that every pairing a person has to read clears WCAG AA, so tuning
 * a shade later cannot quietly make a button, a caption or a red label unreadable.
 */

const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

function block(selector: RegExp): Record<string, string> {
  const match = styles.match(selector);
  if (!match?.[1]) throw new Error(`no block for ${selector}`);
  const tokens: Record<string, string> = {};
  for (const [, name, value] of match[1].matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    if (name && value) tokens[name] = value.trim();
  }
  return tokens;
}

const light = block(/:root\s*\{([\s\S]*?)\n\}/);
const dark = block(/\.dark\s*\{([\s\S]*?)\n\}/);

type Oklch = { l: number; c: number; h: number; alpha: number };

function parseOklch(value: string | undefined): Oklch {
  const match = value?.match(
    /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)%?)?\s*\)$/,
  );
  if (!match) throw new Error(`not an oklch colour: ${value}`);
  const alpha = match[4] === undefined ? 1 : Number(match[4]) / 100;
  return {
    l: Number(match[1]),
    c: Number(match[2]),
    h: Number(match[3]),
    alpha,
  };
}

/** OKLCH → linear sRGB → relative luminance (Björn Ottosson's matrices, WCAG's definition). */
function luminance({ l, c, h }: Oklch): number {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const r = clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_);
  const g = clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_);
  const bl = clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(fg: string | undefined, bg: string | undefined): number {
  const a = luminance(parseOklch(fg));
  const b = luminance(parseOklch(bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe.each([
  ["light", light],
  ["dark", dark],
] as const)("%s theme", (_name, tokens) => {
  test("the primary action is the face's black or white, not a colour", () => {
    expect(parseOklch(tokens.primary).c).toBeLessThan(0.01);
    expect(tokens["sidebar-primary"]).toBe(tokens.primary);
    expect(
      contrast(tokens["primary-foreground"], tokens.primary),
    ).toBeGreaterThanOrEqual(7);
  });

  test("red is the signal: the focus ring, the selection mark, the brand", () => {
    for (const name of ["signal", "ring", "sidebar-ring"]) {
      const red = parseOklch(tokens[name]);
      expect(red.h).toBeGreaterThanOrEqual(15);
      expect(red.h).toBeLessThanOrEqual(35);
      expect(red.c).toBeGreaterThan(0.15);
    }
    // Red words — a failed task, an alert badge — still read on the page and on a card.
    for (const ground of ["background", "card"]) {
      expect(
        contrast(tokens["signal-ink"], tokens[ground]),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("the grounds and cards are neutral greys", () => {
    for (const name of ["background", "card", "popover", "sidebar", "muted"]) {
      expect(parseOklch(tokens[name]).c).toBeLessThan(0.01);
    }
  });

  test("body, card and sidebar text clear AA, and so do secondary and faint text", () => {
    expect(contrast(tokens.foreground, tokens.background)).toBeGreaterThan(7);
    expect(
      contrast(tokens["card-foreground"], tokens.card),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(tokens["sidebar-foreground"], tokens.sidebar),
    ).toBeGreaterThanOrEqual(4.5);
    for (const text of ["muted-foreground", "faint"]) {
      for (const ground of ["background", "card", "sidebar"]) {
        expect(contrast(tokens[text], tokens[ground])).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });
});

describe("dark theme surfaces", () => {
  test("the canvas is the reference's near-black, and cards and sidebar sit a step above it", () => {
    const page = parseOklch(dark.background).l;
    expect(page).toBeGreaterThan(0.14);
    expect(page).toBeLessThan(0.18);
    expect(parseOklch(dark.sidebar).l).toBeGreaterThan(page);
    const card = parseOklch(dark.card).l;
    expect(card).toBeGreaterThan(page);
    expect(card - page).toBeLessThanOrEqual(0.08);
  });

  test("borders are hairlines: translucent white, not solid grey", () => {
    const border = parseOklch(dark.border);
    expect(border.l).toBe(1);
    expect(border.alpha).toBeLessThanOrEqual(0.12);
  });
});

describe("matte surfaces", () => {
  const theme = styles.match(/@theme inline\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

  test.each(["card", "popover", "sidebar"])(
    "%s is drawn opaque, straight from its token",
    (name) => {
      expect(theme).toContain(`--color-${name}: var(--${name});`);
    },
  );

  test("nothing frosts what is behind it", () => {
    /*
     * Surfaces are matte (docs/design/ios-studio: 哑光材质，不用磨砂玻璃). The one blur left is inside a
     * Bot's live orb (upstream's `.bot-orb-live .agent-orb::after`), which draws the orb itself and
     * sits behind no card or panel, so it is taken out before looking.
     */
    const surfaces = styles.replace(
      /\.bot-orb-live \.agent-orb::after \{[^}]*\}/g,
      "",
    );
    expect(surfaces).not.toContain("backdrop-filter: blur(");
  });

  test("cards carry a faint sheen and the page one soft light, in both themes", () => {
    for (const tokens of [light, dark]) {
      expect(tokens["card-sheen"]).toContain("linear-gradient(");
      expect(tokens["app-backdrop"]).toContain("radial-gradient(");
    }
  });
});
