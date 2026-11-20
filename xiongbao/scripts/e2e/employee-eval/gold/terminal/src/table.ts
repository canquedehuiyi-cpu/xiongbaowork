import { padCell, repeat } from "textkit";

/** 每一列的宽度：该列最长那一格的字符数。 */
export function columnWidths(rows: string[][]): number[] {
  const count = Math.max(0, ...rows.map((row) => row.length));
  return Array.from({ length: count }, (_, column) =>
    Math.max(0, ...rows.map((row) => (row[column] ?? "").length)),
  );
}

/** 把二维数组排成文本表：首行是表头，下面一条分隔线，各列左对齐、用 ` | ` 隔开。 */
export function renderTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = columnWidths(rows);
  const line = (row: string[]) =>
    widths
      .map((width, column) => padCell(row[column] ?? "", width))
      .join(" | ")
      .trimEnd();
  const rule = widths.map((width) => repeat("-", width)).join("-+-");
  const [header = [], ...body] = rows;
  return [line(header), rule, ...body.map(line)].join("\n");
}
