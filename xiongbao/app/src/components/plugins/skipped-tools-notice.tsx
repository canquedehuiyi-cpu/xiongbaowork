import { appToolName } from "@openbot/shared/tool-name";

/**
 * The actions an app's last refresh left out because no model could be offered their names.
 *
 * A WARNING, NOT AN ERROR. The refresh stored every other action, so the app works; what is missing
 * is named here, on the app's own page, so nobody has to notice the gap for themselves. It used to
 * ride in `lastError`, which was drawn only when the app had no tools at all and turned the app's
 * row on the Plugins list red — for good, for a server that keeps listing the name.
 *
 * `serverId` says the actions in words, as the personal edition lists the rest of the app's tools
 * (`toolInWords`). Without it, Admin's notice names them as the app lists them.
 */
export function SkippedToolsNotice({
  names,
  serverId,
}: {
  names: readonly string[];
  serverId?: string;
}) {
  if (names.length === 0) return null;
  if (serverId !== undefined) {
    const words = names.map(
      (name) =>
        appToolName(serverId, name.replace(/[^A-Za-z0-9_-]+/g, "_")).label,
    );
    return (
      <p
        className="mt-4 text-amber-600 text-sm dark:text-amber-500"
        role="status"
      >
        {names.length === 1
          ? "这个应用列出的一个动作因为名字的写法，你的员工用不了："
          : `这个应用列出的 ${names.length} 个动作因为名字的写法，你的员工用不了：`}
        {words.join("、")}。
      </p>
    );
  }
  return (
    <p
      className="mt-4 text-amber-600 text-sm dark:text-amber-500"
      role="status"
    >
      {names.length === 1
        ? "这个应用列出的一个动作没有收进来，因为工具名只能用字母、数字、下划线和连字符："
        : `这个应用列出的 ${names.length} 个动作没有收进来，因为工具名只能用字母、数字、下划线和连字符：`}
      {names.map((name, index) => (
        <span key={name}>
          {index > 0 ? "、" : null}
          <code className="font-mono text-xs">{name}</code>
        </span>
      ))}
      。
    </p>
  );
}
