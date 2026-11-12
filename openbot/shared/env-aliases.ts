const NEW_PREFIX = "XIONGBAO_";
const LEGACY_PREFIX = "OPENBOT_";

/**
 * Lets a deployment spell its settings `XIONGBAO_<X>` while the code keeps reading `OPENBOT_<X>`.
 *
 * Copying the new name onto the old one before any config is read means the hundreds of existing
 * reads stay as they are, and a deployment that only knows the old names behaves exactly as before.
 * New wins when both are set, because whoever wrote the new name did it on purpose; the clash is
 * returned so the caller can say so. Never copies the other way: an old-only deployment must not
 * grow new-named variables it did not ask for.
 */
export function applyEnvironmentAliases(
  environment: Record<string, string | undefined>,
): {
  conflicts: string[];
} {
  const conflicts: string[] = [];
  for (const name of Object.keys(environment)) {
    if (!name.startsWith(NEW_PREFIX) || name.length === NEW_PREFIX.length)
      continue;
    const value = environment[name];
    if (value === undefined) continue;
    const legacy = LEGACY_PREFIX + name.slice(NEW_PREFIX.length);
    const existing = environment[legacy];
    if (existing !== undefined && existing !== value) conflicts.push(legacy);
    environment[legacy] = value;
  }
  return { conflicts };
}
