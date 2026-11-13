import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type AllowEntry,
  isExpired,
  releasesAfter,
} from "../../scripts/brand/guard/allowlist";

const ALLOWLIST: AllowEntry[] = JSON.parse(
  readFileSync(new URL("./brand-leak-allowlist.json", import.meta.url), "utf8"),
);

const CHANGELOG = `# Changelog

## Unreleased

## 0.2.10

## 0.2.9

## 0.2.8
`;

const legacy: AllowEntry = {
  file: "a.ts",
  text: "openbot-x",
  reason: "legacy-compat: x",
  category: "legacy-compat",
  plan: "remove",
  introducedIn: "0.2.9",
  removeIn: "0.2.11",
};

describe("compat window", () => {
  test("releasesAfter counts formal releases from the changelog and the current version", () => {
    expect(releasesAfter("0.2.9", CHANGELOG, "0.2.10")).toEqual(["0.2.10"]);
    expect(releasesAfter("0.2.9", CHANGELOG, "0.2.11")).toEqual([
      "0.2.10",
      "0.2.11",
    ]);
    expect(releasesAfter("0.2.8", CHANGELOG, "0.2.10")).toEqual([
      "0.2.9",
      "0.2.10",
    ]);
  });

  test("two releases after N expire it, one does not", () => {
    expect(isExpired(legacy, CHANGELOG, "0.2.10")).toBe(false);
    expect(isExpired(legacy, CHANGELOG, "0.2.11")).toBe(true);
    // Skipping from 0.2.10 straight to 0.3.0 is still one release.
    expect(isExpired(legacy, CHANGELOG, "0.3.0")).toBe(true);
    expect(
      isExpired({ ...legacy, introducedIn: "0.2.10" }, CHANGELOG, "0.3.0"),
    ).toBe(false);
  });

  test("only legacy-compat entries expire", () => {
    expect(
      isExpired(
        { ...legacy, category: "persisted-data", plan: "keep" },
        CHANGELOG,
        "0.9.0",
      ),
    ).toBe(false);
  });

  test("notBefore holds a device entry back", () => {
    const device = { ...legacy, device: true as const, notBefore: "0.2.12" };
    expect(isExpired(device, CHANGELOG, "0.2.11")).toBe(false);
    expect(isExpired(device, CHANGELOG, "0.2.12")).toBe(true);
  });

  test("no legacy-compat entry is past its window", () => {
    const changelog = readFileSync(
      new URL("../../CHANGELOG.md", import.meta.url),
      "utf8",
    );
    const { version } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const expired = ALLOWLIST.filter((e) =>
      isExpired(e, changelog, version),
    ).map(
      (e) =>
        `这个旧名到期了：删掉兼容代码和这条白名单（Task 21）：${e.file} ${e.text}${e.device ? "（先完成 Task U7）" : ""}`,
    );
    expect(expired).toEqual([]);
  });
});
