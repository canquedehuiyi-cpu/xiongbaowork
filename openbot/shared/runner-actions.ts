import { createHash } from "node:crypto";

/** JSON object order does not change the identity of an action. */
export function actionFingerprint(action: string, payload: unknown): string {
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, ordered(child)]),
      );
    return value;
  };
  return createHash("sha256")
    .update(
      JSON.stringify([
        action,
        ordered(JSON.parse(JSON.stringify(payload ?? null))),
      ]),
    )
    .digest("hex");
}
