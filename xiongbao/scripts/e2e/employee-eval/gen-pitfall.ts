/**
 * 「有坑可学」重复题（`repeat-pitfall`）的夹具生成器：商户对账单导入。
 *
 * 随种子变的是表面：对账单的文件名、分隔符、汇率目录的名字、币种、汇率、商户、每一行的金额。不变的是坑的本质：
 * 出厂配置是坏的，而第一条报错偏偏指向没坏的那一项；真要修，得（1）看数据定下分隔符和小数点，（2）找到汇率数据
 * 所在的目录，（3）先跑 `bun run warm` 把汇率缓存暖起来（文档里没写）。照抄上一次的具体值（上一次的分隔符、目录名、
 * 币种、缓存、汇总）在这一次必错；只有写成通用做法才有用。
 *
 * 判分用的预期汇总也由种子算出，员工看不到：夹具里没有它，隐藏测试在判分时才拷进去。
 */

import { createHash } from "node:crypto";

/** 汇总折成的基准币种。 */
export const BASE_CURRENCY = "EUR";
const DELIMITERS = [";", "|", "\t"] as const;
const CURRENCIES = ["GBP", "CHF", "SEK", "NOK", "CAD", "AUD", "PLN", "DKK"];
const MERCHANTS = [
  "Kestrel Foods",
  "Brightwater Tools",
  "Alder & Finch",
  "Northgate Print",
  "Quill Studio",
  "Marlow Freight",
  "Juniper Labs",
  "Harbor Linen",
  "Tallow Bakery",
  "Ostrich Cycles",
  "Pine Row Books",
  "Saffron Supply",
  "Copperleaf Tea",
  "Windmere Optics",
  "Lark Ceramics",
  "Granite Bay Fuel",
];

export type PitfallSpec = {
  seed: string;
  /** 对账单的分隔符（出厂配置里写的是逗号，不对）。 */
  delimiter: (typeof DELIMITERS)[number];
  /** 汇率数据所在的目录（出厂配置里写的是 `rates`，不对）。 */
  ratesDir: string;
  /** 这一期用的币种。 */
  currency: string;
  /** 对账单文件名（在 `inbox/` 下）。 */
  sourceFile: string;
  /** 汇率目录里每个币种的汇率（每 1 单位折成多少百万分之一欧元）。 */
  rates: Record<string, number>;
  /** 对账单的行。 */
  entries: { merchant: string; ref: string; amountMinor: number }[];
  /** 行数。 */
  rows: number;
};

export type PitfallSummary = {
  currency: string;
  base: string;
  rows: number;
  skipped: number;
  merchants: { merchant: string; total: number }[];
};

/** 种子 -> 一串 [0,1) 的数；同一个种子永远同一串。 */
function stream(seed: string): () => number {
  let counter = 0;
  return () => {
    const digest = createHash("sha256").update(`${seed}:${counter}`).digest();
    counter += 1;
    return digest.readUInt32BE(0) / 2 ** 32;
  };
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function pitfallSpec(seed: string): PitfallSpec {
  const next = stream(seed);
  const int = (low: number, high: number) =>
    low + Math.floor(next() * (high - low + 1));
  const pick = <T>(items: readonly T[]): T =>
    items[int(0, items.length - 1)] as T;
  const tag = (length: number) =>
    Array.from({ length }, () => ALPHABET[int(0, ALPHABET.length - 1)]).join(
      "",
    );
  const sample = <T>(items: readonly T[], count: number): T[] => {
    const left = [...items];
    return Array.from({ length: count }, () => {
      const [taken] = left.splice(int(0, left.length - 1), 1);
      return taken as T;
    });
  };

  const delimiter = pick(DELIMITERS);
  const currencies = sample(CURRENCIES, 3);
  const currency = currencies[0] as string;
  const ratesDir = `feeds-${tag(4)}`;
  const month = String(int(1, 12)).padStart(2, "0");
  const sourceFile = `stmt-2026${month}-${tag(4)}.csv`;
  const rates = Object.fromEntries(
    currencies.map((code) => [code, int(300_000, 1_900_000)]),
  );
  const merchants = sample(MERCHANTS, 5);
  const rows = int(24, 36);
  const used = new Set<string>();
  const entries = Array.from({ length: rows }, () => {
    let ref = `R${int(10_000, 99_999)}`;
    while (used.has(ref)) ref = `R${int(10_000, 99_999)}`;
    used.add(ref);
    return {
      merchant: pick(merchants),
      ref,
      amountMinor: int(1_000, 250_000),
    };
  });
  return {
    seed,
    delimiter,
    ratesDir,
    currency,
    sourceFile,
    rates,
    entries,
    rows,
  };
}

/** 一笔金额（币种的最小单位）按汇率折成欧元分，四舍五入。导入程序里是同一个算法。 */
export const convertMinor = (minor: number, perUnitMicro: number) =>
  Math.floor((minor * perUnitMicro + 500_000) / 1_000_000);

/** 判分用的预期汇总：全部行都读对、折算后按商户名排序。 */
export function pitfallExpected(seed: string): PitfallSummary {
  const spec = pitfallSpec(seed);
  const rate = spec.rates[spec.currency] as number;
  const totals = new Map<string, number>();
  for (const entry of spec.entries)
    totals.set(
      entry.merchant,
      (totals.get(entry.merchant) ?? 0) + convertMinor(entry.amountMinor, rate),
    );
  return {
    currency: spec.currency,
    base: BASE_CURRENCY,
    rows: spec.rows,
    skipped: 0,
    merchants: [...totals]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([merchant, total]) => ({ merchant, total })),
  };
}

const json = (value: unknown) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** 对账单里的一个金额：欧式写法，小数点是逗号。 */
const amountText = (minor: number) =>
  `${Math.floor(minor / 100)},${String(minor % 100).padStart(2, "0")}`;

/** 汇率目录里一个币种的文件。 */
const rateFile = (spec: PitfallSpec, code: string) =>
  json({
    currency: code,
    base: BASE_CURRENCY,
    perUnitMicro: spec.rates[code],
    asOf: "2026-11-01",
  });

/**
 * 种子生成的那部分夹具（路径 -> 内容）：出厂的坏配置、对账单、汇率目录。静态的部分（代码、文档、可见测试）在
 * `fixtures/repeat-pitfall/`。
 */
export function pitfallFiles(seed: string): Map<string, Buffer> {
  const spec = pitfallSpec(seed);
  const files = new Map<string, Buffer>();
  files.set(
    "import.config.json",
    json({
      source: "inbox/statement.csv",
      delimiter: ",",
      decimal: ".",
      currency: spec.currency,
      ratesDir: "rates",
      output: "out/summary.json",
    }),
  );
  const lines = [
    ["merchant", "ref", "amount"].join(spec.delimiter),
    ...spec.entries.map((entry) =>
      [entry.merchant, entry.ref, amountText(entry.amountMinor)].join(
        spec.delimiter,
      ),
    ),
  ];
  files.set(`inbox/${spec.sourceFile}`, Buffer.from(`${lines.join("\n")}\n`));
  for (const code of Object.keys(spec.rates).sort())
    files.set(`${spec.ratesDir}/${code}.rates.json`, rateFile(spec, code));
  return files;
}

/** 标准答案叠在夹具上的那几个文件：改好的配置、暖好的汇率缓存、导入出来的汇总。 */
export function pitfallGold(seed: string): Map<string, Buffer> {
  const spec = pitfallSpec(seed);
  const cache = Object.fromEntries(
    Object.keys(spec.rates)
      .sort()
      .map((code) => [
        code,
        { perUnitMicro: spec.rates[code], asOf: "2026-11-01" },
      ]),
  );
  return new Map<string, Buffer>([
    [
      "import.config.json",
      json({
        source: `inbox/${spec.sourceFile}`,
        delimiter: spec.delimiter,
        decimal: ",",
        currency: spec.currency,
        ratesDir: spec.ratesDir,
        output: "out/summary.json",
      }),
    ],
    [".cache/rates.json", json(cache)],
    ["out/summary.json", json(pitfallExpected(seed))],
  ]);
}

/**
 * 一对（第一次、第二次）的两个种子：由同一个基础种子定下，且两次的分隔符、汇率目录、币种、对账单文件名、预期汇总
 * 都不一样，所以照抄上一次的具体值在这一次必错。
 */
export function pairSeeds(base: string): [string, string] {
  const first = `${base}/a`;
  const one = pitfallSpec(first);
  const expected = JSON.stringify(pitfallExpected(first));
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const second = `${base}/b${attempt}`;
    const two = pitfallSpec(second);
    if (
      two.delimiter !== one.delimiter &&
      two.ratesDir !== one.ratesDir &&
      two.currency !== one.currency &&
      two.sourceFile !== one.sourceFile &&
      JSON.stringify(pitfallExpected(second)) !== expected
    )
      return [first, second];
  }
  throw new Error(`没有为基础种子 ${base} 找到表面不同的第二个种子`);
}

/** 第 `index` 对（从 1 数）的两个种子：熊宝和 Codex 两侧用同一个基础种子，所以两边每一对的夹具是同一份。 */
export const pitfallPairSeeds = (base: string, index: number) =>
  pairSeeds(`${base}/pair-${index}`);
