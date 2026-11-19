/**
 * The AG-UI `CUSTOM` event a person's run sends when it used up every step it was allowed, and its
 * model was made to answer with its tools off.
 *
 * A run a person started that is still calling tools on its last step is given one more budget of
 * steps (`answersOnLastStep` in `toolkit/src/copilotkit/last-step.ts`). If it reaches the end of that
 * too, its last step answers without tools, and this event goes out in the run's own stream, just
 * before `RUN_FINISHED`, so the chat can offer to carry on (「已用完 N 步 · 继续」). Because it rides in
 * the run's stream, the runner stores it with the run's other events, and a reload replays it.
 *
 * Never sent for a run nobody is watching: a routine or a check-in has its own budget and nobody to
 * press "carry on".
 */
export const STEP_LIMIT_EVENT = "step-limit";

/** What {@link STEP_LIMIT_EVENT} carries. */
export type StepLimitPayload = {
  /** How many model steps the run took, its last (the one without tools) included. */
  steps: number;
};
