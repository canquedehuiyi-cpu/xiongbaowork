/** 截断时默认补在末尾的省略号。 */
export const DEFAULT_ELLIPSIS = "…";

export type TruncateOptions = {
  /** 末尾补的字符串，默认 {@link DEFAULT_ELLIPSIS}。 */
  ellipsis?: string;
  /** 为 true 时不在单词中间截断（只对空格分词的文字有效）。 */
  wordBoundary?: boolean;
};

/** 把文本截到最多 `max` 个字符（含省略号）。 */
export function truncate(
  text: string,
  max: number,
  options: TruncateOptions = {},
): string {
  const ellipsis = options.ellipsis ?? DEFAULT_ELLIPSIS;
  const chars = [...text];
  if (chars.length <= max) return text;
  let cut = chars.slice(0, Math.max(0, max - [...ellipsis].length)).join("");
  if (options.wordBoundary) {
    const space = cut.lastIndexOf(" ");
    if (space > 0) cut = cut.slice(0, space);
  }
  return `${cut}${ellipsis}`;
}
