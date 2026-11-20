import { createHash } from "node:crypto";
import { similarity, tokensOf } from "../text-tokens";

/**
 * 一条自写技能是从哪种请求里学来的：来源请求的「指纹」。
 *
 * 为什么要有：复盘按要求把人名、日期、文件名都换成占位，技能的「什么时候用」写得很泛；而下一次同类请求
 * 常常只是「请完成「多步办公」这道题：先读 …/TASK.md」这样一句指路的话，题目的内容在文件里。技能的字和
 * 请求的字对不上，靠技能自己的字找不到它。来源请求（复盘时就是那张卡的请求文字）和新请求是同一种句式、
 * 同一批词，拿它们比最稳。
 *
 * 只存词的哈希，不存原文：技能账是长期落库的，请求里可能有人名、路径、金额。哈希只够判断「两句话的词
 * 重合多少」，读不回原话。只有六位十六进制、又是两字一组的词，对着常用字表能逐个猜出来，这一层只防「原文
 * 落库」，不防有人专门去反查。
 *
 * 两份：`t` 是前 {@link FINGERPRINT_CHARS} 个字的全部词；`q` 是其中引号（「」『』《》“”）里的词。引号里是
 * 请求自己给这件事起的名字。句式相同的两个请求，词几乎一样（「请完成」「这道题」「先读」「TASK.md」「做完后自己
 * 核对一遍」），只差名字那几个字；整句比相似度会把「多步办公」和「跨文件重构」判成一件事，所以两边都带名字时，
 * 名字对不上就不算同类。
 */
export const FINGERPRINT_CHARS = 200;
/** 指纹相似度达到这个数才算同类（期 1 记忆排序那套 Dice 相似度，`text-tokens.ts`）。 */
export const MATCH_SIMILARITY = 0.35;
/** 两边都带名字时，名字的相似度至少这么多，指纹才有资格命中。 */
const NAME_SIMILARITY = 0.5;
/** 指纹最多存多少个词：`FINGERPRINT_CHARS` 个字里本来也放不下更多。 */
const MAX_WORDS = 240;

export type SourceFingerprint = {
  /** 前若干字里的词，各取哈希的前 6 位十六进制。 */
  t: string[];
  /** 其中引号里的词。 */
  q: string[];
};

const QUOTED = /「([^」]*)」|『([^』]*)』|《([^》]*)》|“([^”]*)”/g;

const hashOf = (word: string) =>
  createHash("sha256").update(word).digest("hex").slice(0, 6);

const hashedWords = (text: string): Set<string> =>
  new Set([...tokensOf(text)].slice(0, MAX_WORDS).map(hashOf));

/** 一段请求的指纹；没有一个词（空的、只有符号）就是 undefined。 */
export function fingerprintOf(request: string): SourceFingerprint | undefined {
  const head = request.normalize("NFKC").slice(0, FINGERPRINT_CHARS);
  const all = hashedWords(head);
  if (all.size === 0) return undefined;
  const quoted = [...head.matchAll(QUOTED)]
    .map((found) => found.slice(1).find(Boolean) ?? "")
    .join(" ");
  return { t: [...all].sort(), q: [...hashedWords(quoted)].sort() };
}

/** 存进技能账的那一串。 */
export const encodeFingerprint = (fingerprint: SourceFingerprint): string =>
  JSON.stringify(fingerprint);

const isHashList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string" && /^[0-9a-f]{6}$/.test(item));

/** 从技能账读回来；不是一份指纹的值（空、坏的、旧格式）一律当没有。 */
export function decodeFingerprint(
  raw: string | null | undefined,
): SourceFingerprint | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { t?: unknown; q?: unknown };
    if (!isHashList(parsed.t) || !isHashList(parsed.q)) return undefined;
    return parsed.t.length > 0 ? { t: parsed.t, q: parsed.q } : undefined;
  } catch {
    return undefined;
  }
}

const dice = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  similarity(a, b);

/**
 * 新请求和这份指纹有多像，0 到 1。两边都带名字、名字对不上时是 0。
 *
 * 新请求按同样的方式取指纹（前 {@link FINGERPRINT_CHARS} 个字），两边才比得上。
 */
export function fingerprintScore(
  fingerprint: SourceFingerprint,
  request: string,
): number {
  const wanted = fingerprintOf(request);
  if (!wanted) return 0;
  if (
    fingerprint.q.length > 0 &&
    wanted.q.length > 0 &&
    dice(new Set(fingerprint.q), new Set(wanted.q)) < NAME_SIMILARITY
  )
    return 0;
  return dice(new Set(fingerprint.t), new Set(wanted.t));
}
