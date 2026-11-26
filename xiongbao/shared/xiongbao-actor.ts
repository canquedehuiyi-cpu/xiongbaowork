/**
 * Whether a configuration row's `actor` is XiongBao itself, for a change nobody made.
 *
 * XiongBao names itself two ways: `deployment` for a refresh of an app's tools it ran on its own, and
 * a reserved prefix on the actor for what it gives every Bot by itself (Routines' tools at every start, and in the
 * personal edition every app's tools and every skill). The server records those rows as started by
 * XiongBao. Rows written before it did say a person started them, and Activity reads them by this
 * rule too, since the trail cannot be rewritten.
 */
export function isXiongBaoActor(actor: unknown): boolean {
  return (
    typeof actor === "string" &&
    (actor === "deployment" || isSystemMarker(actor))
  );
}

/** The reserved prefix XiongBao writes on an actor, `granted_by` or `updated_by` for its own changes. */
export const SYSTEM_MARKER_PREFIX = "xiongbao:";

/**
 * Whether a stored actor or `granted_by` is one of XiongBao's own markers, under either prefix: the
 * rename migration (0240) rewrote the prefix before v0.2.16 in every table but the audit trail, which is
 * append-only and keeps it as written. Kept for good: the activity page reads those audit rows for as
 * long as they are kept.
 */
export function isSystemMarker(actor: string): boolean {
  return actor.startsWith(SYSTEM_MARKER_PREFIX) || actor.startsWith("openbot:");
}
