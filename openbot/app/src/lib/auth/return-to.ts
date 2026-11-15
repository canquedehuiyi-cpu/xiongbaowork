/**
 * 登录前想去的那一页（`/sign?redirect=/tasks/…`）：没登录时打开一张卡、清点页或任何站内地址，被送去登录，
 * 登录完回到那里，而不是首页（App 的推送深链打开网页也靠它）。
 *
 * 这个值来自地址栏，是别人能填的，所以只认本站的相对路径：以一个 `/` 开头，不以 `//` 或 `/\` 开头（浏览器
 * 会把它们当成另一个站），不带协议、控制字符和反斜杠，解析出来还在本站。不认的一律当没有，回首页，不会
 * 把人送到别的站去（防开放跳转）。
 */

/** 地址长到这里就不认：正常的站内地址远到不了，造出来的超长链接当没有。 */
const MAX_RETURN_LENGTH = 2048;

/** 一个可以登录后回去的站内路径，或者 null。 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (
    path.length === 0 ||
    path.length > MAX_RETURN_LENGTH ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    // 反斜杠、空白和控制字符：浏览器会把 `/\evil.example` 读成 `//evil.example`。
    /[\\\s]/.test(path) ||
    [...path].some((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  )
    return null;
  const base = "https://return.invalid";
  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    return null;
  }
  if (url.origin !== base) return null;
  // 回到登录页本身没有意义，还会绕圈。
  if (url.pathname === "/sign" || url.pathname.startsWith("/sign/"))
    return null;
  // 首页就是不带的默认去处。
  if (url.pathname === "/" && !url.search && !url.hash) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
