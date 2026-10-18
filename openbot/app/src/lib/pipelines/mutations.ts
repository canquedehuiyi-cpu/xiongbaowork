import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
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
 * Hand the crew a task and get its run id.
 *
 * The response is the run's first two ids rather than its outcome, and that is deliberate: the press
 * answers as soon as the parent card is on the board, and the steps arrive as the crew works. The
 * screen follows the run from here on, not this response.
 */
export function startRunMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { templateId: string; task: string }) =>
      client<{ runId: string; parentTaskId: string }>(
        `/api/group-pipelines/templates/${input.templateId}/runs`,
        "run",
        {
          method: "POST",
          body: { task: input.task },
          fallback: "小组没能接下这个任务。",
        },
      ),
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
