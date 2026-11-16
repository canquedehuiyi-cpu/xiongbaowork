/**
 * The providers whose apps this deployment reaches through a broker, by the `provenance` the server
 * writes on an app's row: Composio, and Arcade since X5 (`BROKERED_PROFILE` in
 * `server/src/plugins/access.ts`). One deployment uses one of them at a time.
 */
export const BROKER_PROVENANCES: readonly string[] = ["composio", "arcade"];

/**
 * Whether a row is a broker's app: each person connects their own account at the broker, and the
 * deployment holds no token for it. Asked of the row, never of the app's name.
 */
export function isBrokeredProvenance(provenance: string | null | undefined) {
  return provenance != null && BROKER_PROVENANCES.includes(provenance);
}
