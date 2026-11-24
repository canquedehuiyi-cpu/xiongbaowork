/**
 * The headers the server sends this computer: which Bot, which person, the computer's secret, and
 * the one the egress filter puts on a refusal.
 *
 * The names live in `shared/wire-headers.ts`, where the server and this side read them from.
 */

import { HEADER, type WireHeader } from "../../shared/wire-headers";

export { HEADER, type WireHeader };

/** The header's value, trimmed, or undefined when it is absent or blank. */
export function readWireHeader(
  headers: Headers,
  name: WireHeader,
): string | undefined {
  return headers.get(HEADER[name])?.trim() || undefined;
}
