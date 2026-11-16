/** Observe a dispatched action's effect without dispatching that action again. */
export async function observeRunnerProbeRead<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  options: Readonly<{ maxReads?: number; delayMs?: number }> = {},
): Promise<T> {
  const maxReads = options.maxReads ?? 20;
  const delayMs = options.delayMs ?? 50;
  if (!Number.isSafeInteger(maxReads) || maxReads < 1 || maxReads > 20 ||
      !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 50) {
    throw new Error("probe observation bounds rejected");
  }
  let value = await read();
  for (let count = 1; !accept(value) && count < maxReads; count++) {
    await Bun.sleep(delayMs);
    value = await read();
  }
  return value;
}
