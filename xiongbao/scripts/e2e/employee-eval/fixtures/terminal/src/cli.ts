import { readFileSync } from "node:fs";
import { parseCsv } from "./csv";
import { renderTable } from "./table";

const file = process.argv[2];
if (!file) {
  console.error("用法：report-cli <文件.csv>");
  process.exit(2);
}
console.log(renderTable(parseCsv(readFileSync(file, "utf8"))));
