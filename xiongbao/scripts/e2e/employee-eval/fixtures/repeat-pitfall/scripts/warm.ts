import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

const config = JSON.parse(readFileSync("import.config.json", "utf8")) as {
  ratesDir: string;
};
const files = existsSync(config.ratesDir)
  ? readdirSync(config.ratesDir)
      .filter((name) => name.endsWith(".rates.json"))
      .sort()
  : [];
if (files.length === 0) {
  console.error(`warm: no *.rates.json files under "${config.ratesDir}/"`);
  process.exit(1);
}

const cache: Record<string, { perUnitMicro: number; asOf: string }> = {};
for (const name of files) {
  const rate = JSON.parse(readFileSync(`${config.ratesDir}/${name}`, "utf8"));
  cache[rate.currency] = { perUnitMicro: rate.perUnitMicro, asOf: rate.asOf };
}
mkdirSync(".cache", { recursive: true });
writeFileSync(".cache/rates.json", `${JSON.stringify(cache, null, 2)}\n`);
console.log(`warm: ${files.length} rate tables cached`);
