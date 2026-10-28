/** Probe format assertion only; runner state remains the authority for handles. */
export function runnerProbeHandleHasToken(ref: string): boolean {
  // Preserve the probe's existing suffix constraint; include both run and profile tokens.
  return /^[0-9a-f]{8}-[0-9a-f]{8}:[ex\d]+$/.test(ref);
}
