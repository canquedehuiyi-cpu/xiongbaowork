/*
 * 微信里「回编号」的提示：这个人的一条回复是不是在回某条还开着的提示（计划 2026-11-16-im-channels-wechat
 * Task 6 起步，Task 7 加审批、交付闭环几类）。
 *
 * 只负责认：每类提示自己说认哪些回答（`accepts`），这里按规则挑出是哪一条；怎么处理由调用方按 `kind` 分派。
 *  - 带编号（`A2 1`、`a2：1`）：就是那一条，回答交给它（它不认这个回答也交给它，由它说怎么回）。
 *    编号不在开着的提示里：不算回提示。
 *  - 不带编号：只有一条开着、且它认这个回答 → 对它生效；不止一条开着、而其中有认这个回答的 → 要求带编号
 *    （`ambiguous`）。
 *  - 没有开着的提示，或者谁都不认：返回 null，当普通消息交给员工（Review Focus 3）。
 */
import type { WechatPrompt, WechatPromptKind } from "../../db/schema/wechat";

/** 一类提示认哪些回答。 */
export type PromptAccepts = (answer: string, prompt: WechatPrompt) => boolean;

export type PromptMatch =
  | { kind: "answer"; prompt: WechatPrompt; answer: string }
  | { kind: "ambiguous"; open: WechatPrompt[] };

const WITH_CODE = /^([Aa]\d+)[\s:：,，、.]*(.*)$/su;

export function matchPromptReply(
  text: string,
  open: readonly WechatPrompt[],
  accepts: Partial<Record<WechatPromptKind, PromptAccepts>>,
): PromptMatch | null {
  const reply = text.trim();
  if (!reply || open.length === 0) return null;
  const coded = WITH_CODE.exec(reply);
  if (coded?.[1] && coded[2]?.trim()) {
    const code = coded[1].toUpperCase();
    const prompt = open.find((p) => p.code.toUpperCase() === code);
    if (prompt && accepts[prompt.kind])
      return { kind: "answer", prompt, answer: coded[2].trim() };
  }
  const takers = open.filter((p) => accepts[p.kind]?.(reply, p));
  if (takers.length === 0) return null;
  const [only] = open;
  if (open.length === 1 && only)
    return { kind: "answer", prompt: only, answer: reply };
  return { kind: "ambiguous", open: [...open] };
}
