export type LinkedNotice = { tone: "success" | "error"; text: string };

/**
 * What the connected accounts page says about the `?linked=` the GitHub callback redirected back
 * with. Only the three values the callback sends have a sentence; anything else says nothing.
 */
export function linkedNotice(value: string | undefined): LinkedNotice | null {
  if (value === "github") {
    return { tone: "success", text: "你的 GitHub 账号已关联。" };
  }
  if (value === "failed") {
    return {
      tone: "error",
      text: "GitHub 账号没能关联，请再试一次。",
    };
  }
  if (value === "github-taken") {
    return {
      tone: "error",
      text: "这个 GitHub 账号已经关联到另一位熊宝用户。请在 GitHub 换一个账号登录后再连接，或联系熊宝管理员。",
    };
  }
  return null;
}

/**
 * The notice to draw right now, given the person's current linked accounts.
 *
 * A success notice is a claim about the list below it, so it holds only while that list agrees: the
 * only success `linkedNotice` produces is for GitHub, and once that link is gone (the person
 * disconnected it on this very page) the sentence would contradict the card under it. Until the list
 * has loaded (`links` undefined) it stays hidden, which beats flashing a claim that may be wrong.
 * Error notices describe an attempt, not the list, so they are never withheld.
 */
export function visibleLinkedNotice(
  notice: LinkedNotice | null,
  links: ReadonlyArray<{ provider: string }> | undefined,
): LinkedNotice | null {
  if (!notice || notice.tone === "error") return notice;
  return links?.some((link) => link.provider === "github") ? notice : null;
}
