/** The prefix of the product's own settings: `XIONGBAO_PUBLIC_URL`, `XIONGBAO_RLS_ENFORCE`, … */
export const NEW_PREFIX = "XIONGBAO_";

/**
 * The prefix the same settings had before v0.2.16. Read only to refuse it: v0.2.16 read both and its
 * upgrade sheet renamed every line, and this release reads the new names alone, so a setting still under
 * the old one would be silently ignored rather than refused.
 */
export const OLD_PREFIX = "OPENBOT_";

/**
 * The old-prefix settings with a value whose new name is unset or empty, sorted: the ones a deployment
 * that skipped v0.2.16 still relies on. A setting under both names is not one of them (the new one is in
 * effect, as it was in v0.2.16).
 */
export function settingsUnderOldNamesOnly(
  environment: Record<string, string | undefined>,
): string[] {
  return Object.keys(environment)
    .filter(
      (name) =>
        name.startsWith(OLD_PREFIX) &&
        name.length > OLD_PREFIX.length &&
        (environment[name] ?? "") !== "" &&
        (environment[NEW_PREFIX + name.slice(OLD_PREFIX.length)] ?? "") === "",
    )
    .sort();
}

/** What a process that refuses those settings says: by name only, never a value. */
export function oldSettingsRefusal(names: readonly string[]): string {
  const renamed = names.map(
    (name) => NEW_PREFIX + name.slice(OLD_PREFIX.length),
  );
  return `这些设置还是 v0.2.16 之前的旧名，这个版本不再读取，不启动：${names.join(", ")}。这个版本只能从 v0.2.16 升级上来：请先升级到 v0.2.16（按它的升级单把旧名改成新名），或者把每一行改成对应的新名（${renamed.join(", ")}）后再启动。`;
}

/** Throws {@link oldSettingsRefusal} when {@link settingsUnderOldNamesOnly} finds any. */
export function refuseOldSettingNames(
  environment: Record<string, string | undefined>,
): void {
  const names = settingsUnderOldNamesOnly(environment);
  if (names.length > 0) throw new Error(oldSettingsRefusal(names));
}

/**
 * The name a message shows for a setting: `envName("PUBLIC_URL")` is `XIONGBAO_PUBLIC_URL`.
 *
 * Every sentence that tells an operator which variable to set goes through here, so the name it gives
 * is the one this release reads.
 */
export function envName(suffix: string): string {
  return `${NEW_PREFIX}${suffix}`;
}
