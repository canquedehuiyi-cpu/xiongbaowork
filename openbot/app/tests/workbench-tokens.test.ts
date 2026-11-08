import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * The workbench palette, taken from the product's logo (熊宝数字员工 · xiongbao work): a 京剧脸谱
 * red panda in a black hoodie, framed in glowing gold on black. So the primary action is that red,
 * focus rings and highlights are the frame's gold, and the grounds are warm blacks (dark) or a warm
 * paper white (light) rather than neutral grey. Surfaces are iOS-style glass: translucent and
 * blurred over a ground lit by a red and a gold glow.
 *
 * The numbers are this product's own; what is pinned here is the shape — red primary, gold ring,
 * warm grounds, glass surfaces — and that every pairing a person has to read still clears WCAG AA,
 * so tuning a shade later cannot quietly make a button or a caption unreadable.
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
  test("the primary action is the logo's red", () => {
    const primary = parseOklch(tokens.primary);
    expect(primary.h).toBeGreaterThanOrEqual(15);
    expect(primary.h).toBeLessThanOrEqual(35);
    expect(primary.c).toBeGreaterThan(0.15);
    expect(parseOklch(tokens["sidebar-primary"]).h).toBe(primary.h);
  });

  test("focus rings and highlights are the frame's gold", () => {
    for (const name of ["brand-gold", "ring", "sidebar-ring"]) {
      const gold = parseOklch(tokens[name]);
      expect(gold.h).toBeGreaterThanOrEqual(60);
      expect(gold.h).toBeLessThanOrEqual(95);
      expect(gold.c).toBeGreaterThan(0.08);
    }
    expect(
      contrast(tokens["brand-gold-foreground"], tokens["brand-gold"]),
    ).toBeGreaterThanOrEqual(4.5);
    // Gold words (the English product name) still read on the page and the sidebar.
    expect(
      contrast(tokens["brand-gold-ink"], tokens.background),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(tokens["brand-gold-ink"], tokens.sidebar),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("the grounds are warm, not neutral grey", () => {
    for (const name of ["background", "card", "sidebar"]) {
      const ground = parseOklch(tokens[name]);
      if (ground.c === 0) continue; // pure white is allowed for a light card
      expect(ground.h).toBeGreaterThanOrEqual(30);
      expect(ground.h).toBeLessThanOrEqual(95);
    }
    expect(parseOklch(tokens.background).c).toBeGreaterThan(0);
  });

  test("text on the primary action clears AA", () => {
    expect(
      contrast(tokens["primary-foreground"], tokens.primary),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("body, card and sidebar text clear AA, and so does secondary text", () => {
    expect(contrast(tokens.foreground, tokens.background)).toBeGreaterThan(7);
    expect(
      contrast(tokens["card-foreground"], tokens.card),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(tokens["sidebar-foreground"], tokens.sidebar),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(tokens["muted-foreground"], tokens.background),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(tokens["muted-foreground"], tokens.card),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("dark theme surfaces", () => {
  test("the sidebar and cards sit one step apart from the page", () => {
    const page = parseOklch(dark.background).l;
    const sidebar = parseOklch(dark.sidebar).l;
    const card = parseOklch(dark.card).l;
    expect(sidebar).toBeGreaterThan(page);
    expect(card).toBeGreaterThan(page);
    expect(card - page).toBeLessThanOrEqual(0.08);
  });

  test("borders are hairlines: translucent white, not solid grey", () => {
    const border = parseOklch(dark.border);
    expect(border.l).toBe(1);
    expect(border.alpha).toBeLessThanOrEqual(0.12);
  });
});

describe("glass surfaces", () => {
  const theme = styles.match(/@theme inline\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

  test.each(["card", "popover", "sidebar"])(
    "%s is drawn translucent, mixed with transparent",
    (name) => {
      const declared = theme.match(
        new RegExp(`--color-${name}:\\s*([^;]+);`),
      )?.[1];
      expect(declared).toMatch(
        new RegExp(
          `color-mix\\(in oklab, var\\(--${name}\\) \\d+%, transparent\\)`,
        ),
      );
    },
  );

  test("translucent surfaces blur what is behind them", () => {
    const rule = styles.match(
      /\.bg-card,\s*\.bg-popover,\s*\.bg-sidebar\s*\{([^}]*)\}/,
    )?.[1];
    expect(rule).toContain("backdrop-filter: blur(");
    expect(rule).toContain("-webkit-backdrop-filter: blur(");
  });

  test("the page ground carries the red and gold glows the glass blurs", () => {
    for (const tokens of [light, dark]) {
      expect(tokens["app-backdrop"]).toContain("radial-gradient(");
      expect(tokens["app-backdrop"]).toContain("var(--primary)");
      expect(tokens["app-backdrop"]).toContain("var(--brand-gold)");
    }
  });
});
