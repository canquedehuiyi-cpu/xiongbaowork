import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client, RequestError, tryClient } from "@/lib/client";
import { type PipelineStep, pipelineKeys } from "./queries";

/**
 * Writing a crew's plan, and pressing it.
 *
 * Every one of these invalidates the templates or the run it touched rather than patching the cache
 * with what it sent: the server is the one that decides whether a step is allowed to run at all, so a
 * screen that assumed its own edit landed would be showing a plan that was refused.
 */

/** One step as the editor holds it: the coworker's id is a uuid only once it is saved. */
export type StepDraft = { id: string; agentId: string; instruction: string };

export function createTemplateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      groupId: string;
      name: string;
      steps: StepDraft[];
    }) =>
      client<{ templateId: string }>(
        "/api/group-pipelines/templates",
        "templateId",
        {
          method: "POST",
          body: input,
          fallback: "这条流程没能保存。",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pipelineKeys.all }),
  });
}

/**
 * Rewrite a saved template's name and steps (spec I1).
 *
 * No crew in the body: the crew a plan was written for is fixed, and the server reads it from the
 * stored row. Runs already started keep the steps they started with, so nothing here touches a run.
 */
export function updateTemplateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      templateId: string;
      name: string;
      steps: StepDraft[];
    }) =>
      client<string>(
        `/api/group-pipelines/templates/${input.templateId}`,
        "templateId",
        {
          method: "PUT",
          body: { name: input.name, steps: input.steps },
          fallback: "这条流程的修改没能保存。",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pipelineKeys.all }),
  });
}

/** Throw a template away. Its runs stay on record, and one still going finishes from its own copy. */
export function deleteTemplateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (templateId: string) =>
      client<string>(
        `/api/group-pipelines/templates/${templateId}`,
        "templateId",
        {
          method: "DELETE",
          fallback: "这条流程没能删掉。",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pipelineKeys.all }),
  });
}

/** One step the person may not use, as the server names it: `index` is the step's 0-based position. */
export type RefusedStep = { index: number; stepId: string; agentId: string };

/**
 * The server refused the whole dispatch because some steps' coworkers are not the person's to use
 * (spec I6, a 403). Nothing was started; `refused` is every step that stopped it, so the screen can
 * list them instead of a bare "no".
 */
export class PipelineDispatchRefused extends RequestError {
  readonly refused: RefusedStep[];
  constructor(message: string, refused: RefusedStep[]) {
    super(message, 403);
    this.refused = refused;
  }
}

/** The `refused` list of a 403 body, or undefined when the body is not that shape. */
function refusedSteps(body: unknown): RefusedStep[] | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const list = (body as { refused?: unknown }).refused;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const steps: RefusedStep[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") return undefined;
    const { index, stepId, agentId } = entry as Record<string, unknown>;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      typeof stepId !== "string" ||
      typeof agentId !== "string"
    ) {
      return undefined;
    }
    steps.push({ index, stepId, agentId });
  }
  return steps;
}

/**
 * Hand the crew a task and get its run id.
 *
 * The response is the run's first two ids rather than its outcome, and that is deliberate: the press
 * answers as soon as the parent card is on the board, and the steps arrive as the crew works. The
 * screen follows the run from here on, not this response.
 *
 * Read through `tryClient` rather than `client` because a refusal here carries more than a sentence:
 * a 403 names the steps whose coworkers the person may not use, and that list is what the screen shows.
 * Every other failure is the same `RequestError` the shared client would have thrown.
 */
export function startRunMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      templateId: string;
      task: string;
    }): Promise<{ runId: string; parentTaskId: string }> => {
      const fallback = "小组没能接下这个任务。";
      const response = await tryClient(
        `/api/group-pipelines/templates/${input.templateId}/runs`,
        { method: "POST", body: { task: input.task } },
      );
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const said =
          body !== null &&
          typeof body === "object" &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : undefined;
        const refused =
          response.status === 403 ? refusedSteps(body) : undefined;
        if (refused) {
          throw new PipelineDispatchRefused(said ?? fallback, refused);
        }
        throw new RequestError(said ?? fallback, response.status, body);
      }
      const run =
        body !== null && typeof body === "object" && !Array.isArray(body)
          ? (body as { run?: unknown }).run
          : undefined;
      if (
        run === null ||
        typeof run !== "object" ||
        typeof (run as { runId?: unknown }).runId !== "string"
      ) {
        throw new Error(fallback);
      }
      return run as { runId: string; parentTaskId: string };
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pipelineKeys.all }),
  });
}

/** Skip a step without running it (spec I4). */
export function skipStepMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { runId: string; stepId: string }) =>
      client<string>(
        `/api/group-pipelines/runs/${input.runId}/skip`,
        "status",
        {
          method: "POST",
          body: { stepId: input.stepId },
          fallback: "这一步没有跳过。",
        },
      ),
    onSuccess: (_done, input) =>
      queryClient.invalidateQueries({
        queryKey: pipelineKeys.run(input.runId),
      }),
  });
}

/** Stop the run (spec I4). Everything still open is closed as failed, server-side. */
export function abortRunMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (runId: string) =>
      client<string>(`/api/group-pipelines/runs/${runId}/abort`, "status", {
        method: "POST",
        fallback: "这次运行没有停下。",
      }),
    onSuccess: (_done, runId) =>
      queryClient.invalidateQueries({ queryKey: pipelineKeys.run(runId) }),
  });
}

/**
 * Tell a parked step what came of the answer.
 *
 * Only the approval machinery's own resume path should send this in production (it has the resumed
 * turn's reply in hand); the screen offers it because the person is the one who knows they answered.
 * The step is not run again -- see `pipeline/store.ts`'s `resume`.
 */
export function resumeRunMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      runId: string;
      output?: string;
      error?: string;
    }) =>
      client<string>(
        `/api/group-pipelines/runs/${input.runId}/resume`,
        "status",
        {
          method: "POST",
          body: {
            ...(input.output === undefined ? {} : { output: input.output }),
            ...(input.error === undefined ? {} : { error: input.error }),
          },
          fallback: "小组没有接着这一步跑下去。",
        },
      ),
    onSuccess: (_done, input) =>
      queryClient.invalidateQueries({
        queryKey: pipelineKeys.run(input.runId),
      }),
  });
}

export type { PipelineStep };
