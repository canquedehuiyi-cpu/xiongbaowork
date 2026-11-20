import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkRepeatPitfall } from "./check-repeat-pitfall";
import { pairSeeds, pitfallGold, pitfallSpec } from "./gen-pitfall";
import { materialize } from "./lib";
import { solveGenerically } from "./pitfall-solve";
import { cleanup, emptyDir, failed, write } from "./test-support";

afterAll(cleanup);

/*
 * 判分在两件事上要钉死：按「通用做法」（看数据定分隔符和小数点、找到汇率目录、先暖缓存再导入）做完会过；
 * 照抄上一次的具体值（上一次的配置、缓存、汇总）会不过。夹具和隐藏校验都由种子决定。
 */

const [seedA, seedB] = pairSeeds("unit");

const fresh = (seed: string) => {
  const dir = emptyDir();
  materialize("repeat-pitfall", dir, {}, seed);
  return dir;
};
const gold = (seed: string) => {
  const dir = fresh(seed);
  for (const [path, contents] of pitfallGold(seed))
    write(dir, path, contents.toString("utf8"));
  return dir;
};
const run = (dir: string, seed: string) => checkRepeatPitfall(dir, seed);

describe("the right way passes", () => {
  test("the gold overlay passes every check", () => {
    const outcome = run(gold(seedA), seedA);
    expect(failed(outcome)).toEqual([]);
    expect(outcome.task).toBe("repeat-pitfall");
    expect(outcome.passed).toBe(true);
  });

  test("the general approach (read the data, find the rates, warm, import) passes on any seed", () => {
    for (const seed of [seedA, seedB, "another", "and-one-more"]) {
      const dir = fresh(seed);
      const steps = solveGenerically(dir);
      expect(steps.every((step) => step.ok)).toBe(true);
      expect(failed(run(dir, seed))).toEqual([]);
    }
  });
});

describe("untouched and empty directories fail", () => {
  test("the fixture as handed over fails, and says why", () => {
    const outcome = run(fresh(seedA), seedA);
    expect(outcome.passed).toBe(false);
    expect(failed(outcome)).toContain("out/summary.json 存在");
    expect(failed(outcome)).toContain("干净副本里 bun run import 成功");
  });

  test("an empty directory fails", () => {
    expect(run(emptyDir(), seedA).passed).toBe(false);
  });
});

describe("copying the last round's concrete values fails", () => {
  const previous = gold(seedA);
  const copyOver = (dir: string, paths: string[]) => {
    for (const path of paths) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      copyFileSync(join(previous, path), join(dir, path));
    }
  };

  test("config, rate cache and summary from the other round", () => {
    const dir = fresh(seedB);
    copyOver(dir, [
      "import.config.json",
      ".cache/rates.json",
      "out/summary.json",
    ]);
    const outcome = run(dir, seedB);
    expect(outcome.passed).toBe(false);
    expect(failed(outcome)).toContain("out/summary.json 与预期一致");
  });

  test("just the config from the other round (then running the importer)", () => {
    const dir = fresh(seedB);
    copyOver(dir, ["import.config.json"]);
    const outcome = run(dir, seedB);
    expect(outcome.passed).toBe(false);
    expect(failed(outcome)).toContain("干净副本里 bun run import 成功");
  });

  test("the other round's config and cache, with this round's data re-imported, still disagree with the expected totals", () => {
    const dir = fresh(seedB);
    copyOver(dir, ["import.config.json", ".cache/rates.json"]);
    expect(run(dir, seedB).passed).toBe(false);
  });

  test("the two rounds really would not pass for each other", () => {
    // 把 A 的金标当成 B 的答案交上去：A 的数据 B 的判分。
    expect(run(gold(seedA), seedB).passed).toBe(false);
  });
});

describe("shortcuts that skip the real fix fail", () => {
  test("a hand-written summary with the right numbers, config left broken", () => {
    const dir = fresh(seedA);
    write(
      dir,
      "out/summary.json",
      pitfallGold(seedA).get("out/summary.json")?.toString("utf8") ?? "",
    );
    const outcome = run(dir, seedA);
    expect(outcome.passed).toBe(false);
    expect(failed(outcome)).toContain("干净副本里 bun run import 成功");
    // 汇总本身是对的，所以只有「重新导入」这一条把它拦住。
    expect(failed(outcome)).not.toContain("out/summary.json 与预期一致");
  });

  test("config fixed but the rate cache never built", () => {
    const dir = gold(seedA);
    const cache = join(dir, ".cache", "rates.json");
    expect(existsSync(cache)).toBe(true);
    write(dir, ".cache/rates.json", "{}");
    expect(run(dir, seedA).passed).toBe(false);
  });

  test("delimiter fixed but the decimal comma left alone: rows are skipped", () => {
    const dir = fresh(seedA);
    const spec = pitfallSpec(seedA);
    const config = JSON.parse(
      readFileSync(join(dir, "import.config.json"), "utf8"),
    );
    write(
      dir,
      "import.config.json",
      JSON.stringify({
        ...config,
        delimiter: spec.delimiter,
        ratesDir: spec.ratesDir,
      }),
    );
    Bun.spawnSync(["bun", "run", "warm"], { cwd: dir });
    Bun.spawnSync(["bun", "run", "import"], { cwd: dir });
    const outcome = run(dir, seedA);
    expect(outcome.passed).toBe(false);
    expect(failed(outcome)).toContain("拷入隐藏测试后 bun test 全绿");
  });

  test("editing the importer or the data does not count", () => {
    const edited = gold(seedA);
    write(edited, "src/import.ts", "console.log('hardcoded');\n");
    expect(failed(run(edited, seedA))).toContain(
      "src/、scripts/、tests/、inbox/ 和汇率目录里的原有文件没改没删",
    );
    const data = gold(seedA);
    const spec = pitfallSpec(seedA);
    write(data, `inbox/${spec.sourceFile}`, "merchant;ref;amount\n");
    expect(run(data, seedA).passed).toBe(false);
  });
});
