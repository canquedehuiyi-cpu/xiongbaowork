/** 把任意标题变成网址别名：小写、非字母数字换成连字符、去掉首尾连字符。 */
export function slugify(input: string, separator = "-"): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, separator)
    .replace(new RegExp(`^${separator}+|${separator}+$`, "g"), "");
}
