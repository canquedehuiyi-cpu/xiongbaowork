import { expect, test } from "bun:test";
import { fixtureFiles } from "./lib";
import {
  pairSeeds,
  pitfallExpected,
  pitfallFiles,
  pitfallGold,
  pitfallSpec,
} from "./gen-pitfall";

/*
 * 「有坑可学」题的夹具由种子生成：同一个种子永远是同一份，不同种子的文件名、数值、输出都不一样；
 * 连做两次的一对，两次的坑本质相同、表面不同（照抄上一次的具体值会错）。
 */

const text = (buffer: Buffer | undefined) => buffer?.toString("utf8") ?? "";

test("the same seed always gives the same files, a different seed gives different ones", () => {
  const once = pitfallFiles("seed-1");
  const again = pitfallFiles("seed-1");
  expect([...again.keys()]).toEqual([...once.keys()]);
  for (const [path, contents] of once)
    expect(again.get(path)?.equals(contents)).toBe(true);
  const other = pitfallFiles("seed-2");
  expect(JSON.stringify([...other.keys()])).not.toBe(
    JSON.stringify([...once.keys()]),
  );
  expect(pitfallExpected("seed-1")).not.toEqual(pitfallExpected("seed-2"));
});

test("the fixture ships a config that is wrong in four places, and the data says how", () => {
  const spec = pitfallSpec("seed-1");
  const config = JSON.parse(
    text(pitfallFiles("seed-1").get("import.config.json")),
  );
  // 出厂配置：分隔符、小数点、汇率目录都不对，币种是对的（报错偏偏会指着币种）。
  expect(config).toMatchObject({
    delimiter: ",",
    decimal: ".",
    ratesDir: "rates",
    currency: spec.currency,
  });
  expect([";", "|", "\t"]).toContain(spec.delimiter);
  expect(spec.ratesDir).not.toBe("rates");
  // 数据里的分隔符和小数点就是答案：员工看一眼数据文件就知道。
  const csv = text(pitfallFiles("seed-1").get(`inbox/${spec.sourceFile}`));
  const [header, first] = csv.split("\n");
  expect(header?.split(spec.delimiter)).toEqual(["merchant", "ref", "amount"]);
  expect(first?.split(spec.delimiter)[2]).toMatch(/^\d+,\d\d$/);
  // 汇率目录里有好几个币种的文件，按配置里的币种取。
  const rates = [...pitfallFiles("seed-1").keys()].filter((path) =>
    path.startsWith(`${spec.ratesDir}/`),
  );
  expect(rates.length).toBeGreaterThanOrEqual(3);
  expect(rates).toContain(`${spec.ratesDir}/${spec.currency}.rates.json`);
});

test("the two rounds of a pair differ in every concrete value a copy would carry over", () => {
  for (const base of ["a", "run-77/1", "run-77/2", "xyz", "9"]) {
    const [first, second] = pairSeeds(base);
    expect(first).not.toBe(second);
    const one = pitfallSpec(first);
    const two = pitfallSpec(second);
    expect(one.delimiter).not.toBe(two.delimiter);
    expect(one.ratesDir).not.toBe(two.ratesDir);
    expect(one.currency).not.toBe(two.currency);
    expect(one.sourceFile).not.toBe(two.sourceFile);
    expect(pitfallExpected(first)).not.toEqual(pitfallExpected(second));
  }
  // 同一个基础种子永远给出同一对。
  expect(pairSeeds("a")).toEqual(pairSeeds("a"));
  expect(pairSeeds("a")).not.toEqual(pairSeeds("b"));
});

test("what the employee is handed contains neither the answer nor the hint", () => {
  const seed = "seed-1";
  const spec = pitfallSpec(seed);
  const files = fixtureFiles("repeat-pitfall", seed);
  expect(files.has("TASK.md")).toBe(true);
  expect(files.has("out/summary.json")).toBe(false);
  expect(files.has(".cache/rates.json")).toBe(false);
  const task = text(files.get("TASK.md"));
  for (const word of ["warm", ".cache", "delimiter", "decimal", "ratesDir"])
    expect(task).not.toContain(word);
  const everything = [...files.values()].map(text).join("\n");
  for (const merchant of pitfallExpected(seed).merchants)
    expect(everything).not.toContain(`"total": ${merchant.total}`);
  expect(everything).not.toContain('skipped": 0');
  expect(spec.rows).toBeGreaterThanOrEqual(24);
});

test("the gold overlay is the right config, the rate cache and the summary", () => {
  const gold = pitfallGold("seed-1");
  const spec = pitfallSpec("seed-1");
  expect([...gold.keys()].sort()).toEqual(
    [".cache/rates.json", "import.config.json", "out/summary.json"].sort(),
  );
  expect(JSON.parse(text(gold.get("import.config.json")))).toMatchObject({
    delimiter: spec.delimiter,
    decimal: ",",
    ratesDir: spec.ratesDir,
    currency: spec.currency,
  });
  expect(JSON.parse(text(gold.get("out/summary.json")))).toEqual(
    pitfallExpected("seed-1"),
  );
});
