import { describe, expect, test } from "bun:test";
import {
  demoteStaleSkills,
  isStale,
  STALE_SKILL_NOTE,
} from "../src/skills/usage";

const DAY = 86_400_000;
const now = new Date("2026-11-20T00:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

describe("a skill nobody has used for 30 days", () => {
  test("is stale past 30 days since last use, or since it was written when never used", () => {
    expect(isStale({ lastUsedAt: ago(29), createdAt: ago(90) }, now)).toBe(
      false,
    );
    expect(isStale({ lastUsedAt: ago(31), createdAt: ago(90) }, now)).toBe(
      true,
    );
    expect(isStale({ lastUsedAt: null, createdAt: ago(10) }, now)).toBe(false);
    expect(isStale({ lastUsedAt: null, createdAt: ago(40) }, now)).toBe(true);
  });

  test("goes to the back with a note on its summary; the others keep their order; skills with no record are untouched", () => {
    const held = [
      { slug: "auto-old", summary: "旧的" },
      { slug: "shipped", summary: "自带的" },
      { slug: "auto-fresh", summary: "新的" },
      { slug: "auto-older", summary: "更旧的" },
    ];
    const usage = new Map([
      ["auto-old", { lastUsedAt: ago(45), createdAt: ago(90) }],
      ["auto-fresh", { lastUsedAt: ago(2), createdAt: ago(90) }],
      ["auto-older", { lastUsedAt: null, createdAt: ago(60) }],
    ]);
    const result = demoteStaleSkills(held, usage, now);
    expect(result.map((skill) => skill.slug)).toEqual([
      "shipped",
      "auto-fresh",
      "auto-old",
      "auto-older",
    ]);
    expect(result[2]?.summary).toBe(`旧的${STALE_SKILL_NOTE}`);
    expect(result[0]?.summary).toBe("自带的");
    // Not changed in place.
    expect(held[0]?.summary).toBe("旧的");
  });
});
