/** 把一行 CSV 按逗号切开，每格去掉首尾空白。不处理引号。 */
export function parseLine(line: string): string[] {
  return line.split(",").map((cell) => cell.trim());
}

/** 把整段 CSV 文本读成二维数组，跳过空行。 */
export function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map(parseLine);
}
