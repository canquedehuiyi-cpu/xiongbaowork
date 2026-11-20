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

/** 英文里没有实际内容的词：应答、「接着做」、谢谢、语气词。 */
const FILLER_WORDS =
  /\b(?:ok|okay|yes|yeah|yep|sure|fine|good|great|cool|right|alright|go|on|ahead|continue|proceed|next|keep|going|thanks|thank|you|please|do|it|that|and|then|so|now|just|again|more|got|noted)\b/g;
/** 中文里没有实际内容的词和字，长的在前。 */
const FILLER_CJK =
  /知道了|没问题|好的|是的|好吧|行吧|可以|继续|接着|然后|谢谢|感谢|下去|开始|明白|收到|嗯|哦|好|行|对|是|吧|吗|呢|啊|呀|请|再|就|那|做|了|的|也|还|都/g;

/**
 * 这段话里有没有实词：「好的」「继续」「ok go on」「谢谢」这类应答和催促没有，说了什么事、什么东西的有。
 * 没有实词的话，不改变话题，记忆和技能的挑选可以不看它。
 */
export function hasSubstantiveWords(text: string): boolean {
  const rest = text
    .toLowerCase()
    .replace(FILLER_WORDS, " ")
    .replace(FILLER_CJK, " ");
  return tokensOf(rest).size > 0;
}
