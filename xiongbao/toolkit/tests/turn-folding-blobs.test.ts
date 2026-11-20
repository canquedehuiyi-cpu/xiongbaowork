import { describe, expect, test } from "bun:test";
import type { Prompt } from "../src/copilotkit/last-step";
import {
  BLOB_CHARS_PER_TOKEN,
  FOLD_KEEP_STEPS,
  FOLDED_PREFIX,
  foldEarlyResults,
} from "../src/copilotkit/turn-folding";

/*
 * 兜底：工具结果文字里夹着二进制数据（截图的 base64）时，估算按每 1.5 个字符 1 个 token，越线判断才不会慢；
 * 折叠的范围不变（最近几步原样）；没有二进制数据时和原来一个字节不差。
 */

const WINDOW = 1_000_000;

/** 近似压缩过的图片编出来的 base64：六十四种字符都出现，每次一样。 */
function pngBase64(chars: number): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let state = 12345;
  let out = "iVBORw0KGgo";
  while (out.length < chars) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += alphabet[(state >>> 16) % 64];
  }
  return out;
}

const shot = (chars: number) =>
  JSON.stringify({ ok: true, base64: pngBase64(chars), width: 1280 });
/** 一般的文字结果：每步不一样，约 1500 字符，够长，折得动。 */
const note = (step: number) => `第${step}步：${"数据".repeat(750)}`;

/** 一轮里每步一次工具调用；`results[i]` 是第 i+1 步的工具结果文字。 */
function promptOf(results: string[]): Prompt {
  const prompt: unknown[] = [
    { role: "system", content: "你是员工。" },
    { role: "user", content: [{ type: "text", text: "查一下" }] },
  ];
  results.forEach((text, index) => {
    const step = index + 1;
    prompt.push({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `call-${step}`,
          toolName: "computer_screenshot",
          input: "{}",
        },
      ],
    });
    prompt.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call-${step}`,
          toolName: "computer_screenshot",
          output: { type: "text", value: text },
        },
      ],
    });
  });
  return prompt as Prompt;
}

const outputOf = (prompt: Prompt, step: number) =>
  (
    prompt[2 + (step - 1) * 2 + 1] as {
      content: { output: { value: string } }[];
    }
  ).content[0]?.output.value ?? "";

/** 十二步，第 `at` 步（从 1 起）是 `special`，其余是一般的文字。 */
const twelve = (at: number, special: string, steps = 12) =>
  promptOf(
    Array.from({ length: steps }, (_, i) =>
      i + 1 === at ? special : note(i + 1),
    ),
  );

/** 这个文件测的是二进制数据的估算，线按原来的 64K 给（默认值已降到 24K，用户 2026-11-20 批准）。 */
const BUDGET_64K = 64_000;

describe("二进制数据按每 1.5 个字符 1 个 token 估", () => {
  const blob = 90_000;

  test("同样长的重复字符不算二进制：估得少，没越线，一个字不动", () => {
    const prompt = twelve(12, "x".repeat(blob));
    expect(
      foldEarlyResults(prompt, { window: WINDOW, budget: BUDGET_64K }),
    ).toBe(prompt);
  });

  test("夹着 base64 的结果：估算涨到 6 万 token，越线，较早的结果折叠", () => {
    expect(blob / BLOB_CHARS_PER_TOKEN).toBe(60_000);
    const prompt = twelve(12, shot(blob));
    const before = JSON.stringify(prompt);
    const folded = foldEarlyResults(prompt, { window: WINDOW });
    expect(folded).not.toBe(prompt);
    // 传进去的提示一个字不改。
    expect(JSON.stringify(prompt)).toBe(before);
    for (let step = 1; step <= 12 - FOLD_KEEP_STEPS; step += 1)
      expect(outputOf(folded, step).startsWith(FOLDED_PREFIX)).toBe(true);
  });

  test("最近 4 步完全原样：带二进制数据的结果也不折", () => {
    expect(FOLD_KEEP_STEPS).toBe(4);
    // 第 10 步的截图在越线那一刻的最近 4 步里：它和第 7～12 步一样原样，折的只是第 6 步及以前。
    const prompt = twelve(10, shot(blob));
    const folded = foldEarlyResults(prompt, { window: WINDOW });
    expect(outputOf(folded, 10)).toBe(shot(blob));
    for (const step of [7, 8, 9, 11, 12])
      expect(outputOf(folded, step)).toBe(note(step));
    expect(outputOf(folded, 6).startsWith(FOLDED_PREFIX)).toBe(true);
    // 最后一步的截图也原样。
    const last = foldEarlyResults(twelve(12, shot(blob)), { window: WINDOW });
    expect(outputOf(last, 12)).toBe(shot(blob));
  });

  test("没有二进制数据：一个字节不动，返回同一个数组", () => {
    const prompt = promptOf(Array.from({ length: 12 }, (_, i) => note(i + 1)));
    const before = JSON.stringify(prompt);
    const folded = foldEarlyResults(prompt, {
      window: WINDOW,
      budget: BUDGET_64K,
    });
    expect(folded).toBe(prompt);
    expect(JSON.stringify(folded)).toBe(before);
  });

  test("二进制数据没把估算推过线：也一个字不动", () => {
    const prompt = twelve(12, shot(20_000));
    expect(
      foldEarlyResults(prompt, { window: WINDOW, budget: BUDGET_64K }),
    ).toBe(prompt);
  });

  test("重放确定、缓存前缀稳定：下一步只在末尾添加，已折的部分逐字节不变", () => {
    const at12 = twelve(12, shot(blob));
    const foldedAt12 = foldEarlyResults(at12, { window: WINDOW });
    // 同一个提示折两次，结果一样。
    expect(JSON.stringify(foldEarlyResults(at12, { window: WINDOW }))).toBe(
      JSON.stringify(foldedAt12),
    );
    // 后面又来了两步：前面十二步的部分和上一步折出来的逐字节相同。
    const at14 = promptOf([
      ...Array.from({ length: 11 }, (_, i) => note(i + 1)),
      shot(blob),
      note(13),
      note(14),
    ]);
    const foldedAt14 = foldEarlyResults(at14, { window: WINDOW });
    expect(JSON.stringify(foldedAt14.slice(0, foldedAt12.length))).toBe(
      JSON.stringify(foldedAt12),
    );
  });
});
