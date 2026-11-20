import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { convertMinor, parseAmountMinor } from "./money";

type Config = {
  source: string;
  delimiter: string;
  decimal: string;
  currency: string;
  ratesDir: string;
  output: string;
};

function fail(message: string): never {
  console.error(`import: ${message}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync("import.config.json", "utf8")) as Config;

if (!existsSync(config.source))
  fail(`cannot read ${config.source}: no such file`);

const unavailable = `rate table for "${config.currency}" is not available (check "currency" in import.config.json)`;
if (!existsSync(".cache/rates.json")) fail(unavailable);
const rates = JSON.parse(readFileSync(".cache/rates.json", "utf8")) as Record<
  string,
  { perUnitMicro: number }
>;
const rate = rates[config.currency];
if (!rate) fail(unavailable);

const lines = readFileSync(config.source, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim() !== "");
const header = (lines[0] ?? "").split(config.delimiter);
const merchantAt = header.indexOf("merchant");
const amountAt = header.indexOf("amount");
if (merchantAt < 0 || amountAt < 0)
  fail(
    `schema mismatch in ${config.source}: required columns merchant, amount not found`,
  );

const totals = new Map<string, number>();
let skipped = 0;
const body = lines.slice(1);
for (const line of body) {
  const cells = line.split(config.delimiter);
  const minor = parseAmountMinor(cells[amountAt] ?? "", config.decimal);
  if (minor === null) {
    skipped += 1;
    continue;
  }
  const merchant = cells[merchantAt] ?? "";
  totals.set(
    merchant,
    (totals.get(merchant) ?? 0) + convertMinor(minor, rate.perUnitMicro),
  );
}

const summary = {
  currency: config.currency,
  base: "EUR",
  rows: body.length,
  skipped,
  merchants: [...totals]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([merchant, total]) => ({ merchant, total })),
};
mkdirSync(dirname(config.output), { recursive: true });
writeFileSync(config.output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  `import: ${body.length} rows from ${config.source}, ${skipped} skipped`,
);
if (skipped > 0)
  console.warn(
    `import: warning: skipped ${skipped} of ${body.length} rows (unreadable amount)`,
  );
