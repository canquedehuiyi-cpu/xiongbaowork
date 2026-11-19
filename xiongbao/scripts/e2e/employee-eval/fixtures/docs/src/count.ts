/** 数词：英文按空白分词，每个汉字算一个词。 */
export function wordCount(text: string): number {
  const han = text.match(/[一-鿿]/g)?.length ?? 0;
  const latin = text
    .replace(/[一-鿿]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return han + latin;
}
