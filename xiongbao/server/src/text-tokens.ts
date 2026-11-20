/**
 * 一段文字的词集和两段文字的相似度：记忆按相关程度挑选（`memory/rank.ts`）和技能挑选结果的复用
 * （`routing/model.ts`）共用。只看词，不调模型；向量相似度是期 2 的事。
 *
 * 英文数字按词（去掉复数的 s），中日韩文字按相邻两字（中文没有空格，整词切分要词典）。
 */

const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/** 一段文字的词集：英文数字的词，加中日韩文字的相邻两字（单独一个字就用它自己）。 */
export function tokensOf(text: string): Set<string> {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();
  // 去掉复数的 s，让 restaurant 和 restaurants 算同一个词。
  for (const word of lower.match(/[a-z0-9_]{2,}/g) ?? [])
    tokens.add(
      word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word,
    );
  for (const run of lower.match(CJK) ?? []) {
    if (run.length === 1) tokens.add(run);
    else
      for (let index = 0; index + 1 < run.length; index += 1)
        tokens.add(run.slice(index, index + 2));
  }
  return tokens;
}

/** 两个词集的相似度，0 到 1：共有词数的两倍除以两边词数之和（Dice 系数）。任一边为空是 0。 */
export function similarity(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}
