/** Probe format assertion only; runner state remains the authority for handles. */
export function runnerProbeHandleHasToken(ref: string): boolean {
  // Retain legacy refs and accept pinned Playwright's numeric frame-prefixed element refs.
  return /^[0-9a-f]{8}-[0-9a-f]{8}:(?:[ex\d]+|f\d+e\d+)$/.test(ref);
}
