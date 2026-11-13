import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ArtifactEntry,
  compareWords,
  wordsIn,
} from "../../scripts/brand/guard/artifact-words";

const REPO = new URL("../..", import.meta.url).pathname;
const ROOT = join(REPO, "..");
const DOCS: ArtifactEntry[] = JSON.parse(
  readFileSync(new URL("./brand-artifacts/docs.json", import.meta.url), "utf8"),
);
const FILES = [
  join(ROOT, "README.md"),
  ...readdirSync(join(REPO, "docs"))
    .filter((name) => name.endsWith("-xiongbao.md"))
    .map((name) => join(REPO, "docs", name)),
  join(REPO, "docker/delivery.env.example"),
  join(REPO, "docker/compose.delivery.yml"),
];
const text = FILES.map((f) => readFileSync(f, "utf8")).join("\n");
const entry = (e: Partial<ArtifactEntry>): ArtifactEntry => ({
  category: "operator-visible",
  plan: "rewrite",
  note: "x",
  ...e,
});

describe("artifact words", () => {
  test("wordsIn counts each word", () => {
    const found = wordsIn(`a="openbot.ping";console.warn("OpenBot couldn't")`);
    expect(found.get("openbot.ping")).toBe(1);
    expect(found.get("OpenBot")).toBe(1);
    expect(found.size).toBe(2);
  });

  test("compareWords: several words, a missing word, a prefix hit", () => {
    const found = new Map([
      ["OpenBot", 2],
      ["OPENBOT_TAG", 1],
      ["copilotkit/x", 1],
    ]);
    expect(
      compareWords(found, [
        entry({ word: "OpenBot" }),
        entry({ word: "OPENBOT_TAG" }),
        entry({
          prefix: "copilotkit/",
          category: "third-party-name",
          plan: "keep",
        }),
      ]),
    ).toEqual({ extra: [], stale: [] });
    expect(
      compareWords(found, [entry({ word: "OpenBot" })]).extra.sort(),
    ).toEqual(["OPENBOT_TAG", "copilotkit/x"]);
    expect(
      compareWords(new Map([["OpenBot", 1]]), [
        entry({ word: "OpenBot" }),
        entry({ word: "gone" }),
        entry({
          prefix: "nothing/",
          category: "third-party-name",
          plan: "keep",
        }),
      ]).stale.sort(),
    ).toEqual(["gone", "nothing/"]);
  });
});

describe("customer docs", () => {
  test("customer docs carry only listed words", () => {
    expect(compareWords(wordsIn(text), DOCS)).toEqual({ extra: [], stale: [] });
  });

  test("customer docs never point at the upstream", () => {
    let rest = text;
    for (const e of DOCS)
      if (e.category === "third-party-name")
        rest = rest.split((e.word ?? e.prefix) as string).join(" ");
    expect(rest).not.toContain("github.com/CopilotKit");
    expect(rest).not.toContain("copilotkit.ai");
  });

  test("prefix entries are third-party names only", () => {
    expect(
      DOCS.filter((e) => e.prefix && e.category !== "third-party-name"),
    ).toEqual([]);
  });
});
