// textkit 0.3.0：几个文本小工具。本目录是随仓库带的第三方副本，不要改它。

/** 在右侧补空格到 width 个字符（文字比 width 长就原样返回）。 */
export function padCell(text, width) {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** 把 text 重复 count 次。 */
export function repeat(text, count) {
  return text.repeat(Math.max(0, count));
}
