export const NEW_PREFIX = "XIONGBAO_";
// legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，settings written before the rename
export const LEGACY_PREFIX = "OPENBOT_";

/**
 * What follows the old prefix in names that are not aliased: a platform model key's variable is
 * named by its database row (`platform_model_pool.api_key_env`), so the server keeps reading it under
 * the name stored there until that row is renamed with it.
 */
const STORED_SUFFIXES = ["POOL_"];

/**
 * Lets a deployment written before the rename keep its settings under {@link LEGACY_PREFIX} while
 * the code reads each under {@link NEW_PREFIX}.
 *
 * Copying the old name onto the new one before any config is read means every read is of the new
 * name, and a deployment that only knows the old names behaves exactly as before. New wins when both
 * are set, because whoever wrote the new name did it on purpose; the clash is returned so the caller
 * can say so. An empty new value counts as unset, as an image's unset build argument leaves it, so
 * it never hides a value the deployment gave under the old name. The old name is left in place,
 * and nothing is ever copied the other way: a new-only deployment does not grow old names.
 *
 * `legacy` is every old name whose value is the one in effect (copied, or equal to the new one), so
 * the caller can tell the operator which lines to rename. Both lists are sorted.
 */
export function applyEnvironmentAliases(
  environment: Record<string, string | undefined>,
): {
  conflicts: string[];
  legacy: string[];
} {
  const conflicts: string[] = [];
  const legacy: string[] = [];
  for (const name of Object.keys(environment).sort()) {
    if (!name.startsWith(LEGACY_PREFIX) || name.length === LEGACY_PREFIX.length)
      continue;
    const suffix = name.slice(LEGACY_PREFIX.length);
    if (STORED_SUFFIXES.some((stored) => suffix.startsWith(stored))) continue;
    const value = environment[name];
    if (value === undefined || value === "") continue;
    const renamed = NEW_PREFIX + suffix;
    const current = environment[renamed];
    if (current === undefined || current === "") {
      environment[renamed] = value;
      legacy.push(name);
    } else if (current === value) legacy.push(name);
    else conflicts.push(name);
  }
  return { conflicts, legacy };
}

/** The names already reported by this process: the alias step runs at the entry and again in `loadConfig`. */
const reported = new Set<string>();

/**
 * Says what {@link applyEnvironmentAliases} found, by name only: a line for each old name a new one
 * overrides, and one line listing the old names in use. Never a value. A name this process has
 * already reported is left out, so running the alias step twice warns once.
 */
export function reportEnvironmentAliases(
  result: { conflicts: string[]; legacy: string[] },
  warn: (line: string) => void = console.warn,
  seen: Set<string> = reported,
): void {
  for (const name of result.conflicts) {
    if (seen.has(name)) continue;
    seen.add(name);
    const renamed = NEW_PREFIX + name.slice(LEGACY_PREFIX.length);
    warn(`${name} and ${renamed} are both set and differ; using ${renamed}.`);
  }
  const fresh = result.legacy.filter((name) => !seen.has(name));
  if (fresh.length === 0) return;
  for (const name of fresh) seen.add(name);
  warn(
    `These settings still use the old ${LEGACY_PREFIX} prefix, which keeps working for now; rename each to its ${NEW_PREFIX} name: ${fresh.join(", ")}.`,
  );
}

/**
 * The name a message shows for a setting: `envName("PUBLIC_URL")` is `XIONGBAO_PUBLIC_URL`.
 *
 * Every sentence that tells an operator which variable to set goes through here, so a deployment
 * that spells it either way is told the new name. The old name keeps working
 * ({@link applyEnvironmentAliases}); it is just never advertised.
 */
export function envName(suffix: string): string {
  return `${NEW_PREFIX}${suffix}`;
}
