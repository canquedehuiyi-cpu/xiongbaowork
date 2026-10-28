export type RunnerProbePendingAction = Readonly<{
  pending: Promise<Record<string, unknown>>;
  key: string;
}>;
export type RunnerProbeResultInput = RunnerProbePendingAction | Promise<Record<string, unknown>>;

/** Await the action result, not the request's cancellation-key wrapper. */
export async function settleRunnerProbeAction(
  input: RunnerProbeResultInput,
): Promise<Record<string, unknown>> {
  const result = await ("pending" in input ? input.pending : input);
  if (result.type !== "result") throw new Error("the runner answered nothing");
  return result;
}
