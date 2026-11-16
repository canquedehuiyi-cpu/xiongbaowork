import { homedir } from "node:os";

/**
 * Taking file paths and the account's name out of text that leaves the device in an error message
 * (phase 1's helper stderr tails, agent-desktop's error details).
 */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The names this account goes by on this machine: its user name and its home folder's last segment. */
function accountNames(): string[] {
  const names = new Set<string>();
  const add = (value: string | undefined) => {
    const name = value?.trim();
    if (name && name.length >= 2) names.add(name);
  };
  add(process.env.USERNAME);
  add(process.env.USER);
  for (const home of [process.env.HOME, process.env.USERPROFILE]) {
    add(home?.split(/[\\/]/).filter(Boolean).pop());
  }
  try {
    add(homedir().split(/[\\/]/).filter(Boolean).pop());
  } catch {
    // No home folder to learn a name from.
  }
  return [...names];
}

/**
 * The helper's stderr tail with every file path and the account's name taken out, so neither leaves
 * the device in an error message.
 */
export function scrub(text: string): string {
  let out = text
    // C:\dir\sub dir\file (folders may hold spaces; the last part ends at whitespace).
    .replace(
      /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\s\\/:*?"<>|]*/g,
      "<路径>",
    )
    // \\server\share\file
    .replace(/\\\\[^\s"'<>|]+/g, "<路径>")
    // /home/x/y, ~/x
    .replace(/(?<![\w.:])(?:~|\/)(?:[^\s/"'<>|:]+\/)*[^\s/"'<>|:]*/g, (hit) =>
      hit === "/" || hit === "~" ? hit : "<路径>",
    );
  for (const name of accountNames())
    out = out.replace(new RegExp(escapeRegExp(name), "gi"), "<用户>");
  return out;
}
