import { shortName } from "@/lib/brand";
/**
 * The words for Isolated Bots, said the same way in the New Bot sheet and on a Bot's Setup row.
 *
 * Kept together because they answer one question from two places, and a reader who meets the
 * tooltip when making a Bot should meet the same sentence when they come back to change it.
 */

/** What Isolated means. */
export const ISOLATED_EXPLAINED =
  "在自己独立的电脑上运行。它做的任何事都碰不到你其他员工的文件和登录状态。运行成本更高。";

/** Added for a public Bot, whose one computer is everybody's. */
export const ISOLATED_PUBLIC = "用这位员工的所有人共用那台电脑。";

/**
 * Said on an isolated Bot's Visibility row. Its one computer is shared by everybody who uses it, so a public one shares
 * whatever anybody signed in to there with everybody else, as a shared Bot's computer does across the industry. Said
 * before it is made public, and while it is.
 */
export const ISOLATED_PUBLIC_SHARES_LOGINS =
  "用它的所有人共用它的电脑，所以在那里登录的任何账号，大家也都能用。";

/** The same, said to the owner of a private isolated Bot before they make it public. */
export const ISOLATED_MAKING_PUBLIC =
  "设为公开后，它的电脑和在那里登录的任何账号，都会与所有用它的人共享。";

/** Why it cannot be ticked on this deployment. */
export const ISOLATION_UNAVAILABLE = `这个${shortName()}没法给员工分配独立的电脑。`;

/** Why it cannot be ticked by this person. */
export const ISOLATION_NOT_ALLOWED = "管理员为你关闭了独立运行的员工。";

/** An isolated Bot whose owner lost the switch, which keeps running on their shared computer. */
export const ISOLATION_WITHDRAWN =
  "管理员关闭了独立运行的员工，所以这位员工在你的电脑上运行。";

/** An isolated Bot on a deployment that can no longer make it a computer of its own. */
export const ISOLATION_GONE = `这个${shortName()}没法给员工分配独立的电脑，所以这位员工在你的电脑上运行。`;

/** The whole explanation for a Bot of this visibility. */
export function isolatedExplained(isPublic: boolean): string {
  return isPublic
    ? `${ISOLATED_EXPLAINED}${ISOLATED_PUBLIC}`
    : ISOLATED_EXPLAINED;
}
