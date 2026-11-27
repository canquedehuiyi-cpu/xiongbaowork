import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ArtifactEntry,
  compareWords,
  wordsIn,
} from "../../scripts/brand/guard/artifact-words";
import {
  LIBRARY,
  LIBRARY_LOWER,
  OLD_ENV_PREFIX,
  OLD_PRODUCT,
  OLD_PRODUCT_LOWER,
} from "../../scripts/brand/guard/words";

// The old names, short, from the one place that spells them (words.ts).
const E = OLD_ENV_PREFIX;
const P = OLD_PRODUCT;
const O = OLD_PRODUCT_LOWER;
const LP = LIBRARY;
const L = LIBRARY_LOWER;

const REPO = fileURLToPath(new URL("../..", import.meta.url));
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
  category: "kept",
  note: "x",
  ...e,
});

describe("artifact words", () => {
  test("wordsIn writes a release tag as v<version>, so a release does not change the list", () => {
    const one = wordsIn(`tag ${E}TAG:-v0.2.9 here`);
    const two = wordsIn(`tag ${E}TAG:-v0.2.10-rc.1 here`);
    expect([...one.keys()]).toEqual([`${E}TAG:-v<version>`]);
    expect([...two.keys()]).toEqual([...one.keys()]);
    expect([...wordsIn(`postgres://${O}@127.0.0.1:5433`).keys()]).toEqual([
      `postgres://${O}@127.0.0.1:5433`,
    ]);
  });

  test("wordsIn counts each word", () => {
    const found = wordsIn(`a="${O}.ping";console.warn("${P} couldn't")`);
    expect(found.get(`${O}.ping`)).toBe(1);
    expect(found.get(`${P}`)).toBe(1);
    expect(found.size).toBe(2);
  });

  test("compareWords: several words, a missing word, a prefix hit", () => {
    const found = new Map([
      [`${P}`, 2],
      [`${E}TAG`, 1],
      [`${L}/x`, 1],
    ]);
    expect(
      compareWords(found, [
        entry({ word: `${P}` }),
        entry({ word: `${E}TAG` }),
        entry({
          prefix: `${L}/`,
          category: "dependency",
        }),
      ]),
    ).toEqual({ extra: [], stale: [] });
    expect(compareWords(found, [entry({ word: `${P}` })]).extra.sort()).toEqual(
      [`${E}TAG`, `${L}/x`],
    );
    expect(
      compareWords(new Map([[`${P}`, 1]]), [
        entry({ word: `${P}` }),
        entry({ word: "gone" }),
        entry({
          prefix: "nothing/",
          category: "dependency",
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
      if (e.category === "dependency")
        rest = rest.split((e.word ?? e.prefix) as string).join(" ");
    expect(rest).not.toContain(`github.com/${LP}`);
    expect(rest).not.toContain(`${L}.ai`);
  });

  test("prefix entries are third-party names only", () => {
    expect(DOCS.filter((e) => e.prefix && e.category !== "dependency")).toEqual(
      [],
    );
  });
});
