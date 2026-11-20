/**
 * 一个工具的答复是不是说它没做成。复盘（`retrospect.ts`）和本地学习（`local-learning/evidence.ts`）读工具轨迹时
 * 共用这一条规则：成败只看答复的形状，不看内容里写了什么。
 */
/** 一个工具的答复是不是说它没做成：`{ok:false}`、`isError`、「Refused.」、供应商报错，或开头就是出错的话。 */
export function answerFailed(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  if (/^(?:Refused\.|The vendor reported an error|Error\b|error:)/.test(text))
    return true;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const answer = parsed as {
        ok?: unknown;
        isError?: unknown;
        error?: unknown;
      };
      if (answer.ok === false || answer.isError === true) return true;
      if (
        answer.ok !== true &&
        typeof answer.error === "string" &&
        answer.error
      )
        return true;
    }
  } catch {
    // Not JSON: judged on its opening words above.
  }
  return /^(?:失败|出错|无法|没能|没有成功)/.test(text);
}
