import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The client for a crew's pipelines (ticket 021, spec D10 / I1-I5).
 *
 * Two reads, and the second one is the only place in this app that polls on purpose: a run advances
 * inside the server, so the screen's job is to keep asking where the cursor got to rather than to
 * pretend it knows. The board already shows each step as a card under the parent; this is the answer to
 * the question the board cannot say, which step is next and what the earlier ones produced.
 */

export type PipelineStep = { id: string; agentId: string; instruction: string };

/**
 * A step as the editor holds it.
 *
 * The same shape as a saved step, because the editor writes the whole list in one request and the
 * server is the one that decides whether any of it is allowed — a draft type that differed from the
 * saved one would be a second thing to keep in step with the first.
 */
export type StepDraft = PipelineStep;

export type PipelineTemplate = {
  id: string;
  groupId: string;
  name: string;
  steps: PipelineStep[];
  createdAt: string;
};

/** `pending` until the cursor reaches it, then what actually happened to the step. */
export type PipelineRunStep = PipelineStep & {
  state:
    | "pending"
    | "running"
    | "awaiting_action"
    | "done"
    | "failed"
    | "skipped"
    | "aborted";
  taskId?: string;
  runRef?: string;
  approvalId?: string;
  output?: string;
  error?: string;
};

export type PipelineRun = {
  status: string;
  cursor: number;
  steps: PipelineRunStep[];
  parentTaskId: string | null;
};

export const pipelineKeys = {
  all: ["group-pipelines"] as const,
  templates: (groupId?: string) =>
    groupId
      ? (["group-pipelines", "templates", groupId] as const)
      : (["group-pipelines", "templates"] as const),
  run: (runId: string) => ["group-pipelines", "run", runId] as const,
};

export function pipelineTemplatesQueryOptions(groupId?: string) {
  return queryOptions({
    queryKey: pipelineKeys.templates(groupId),
    queryFn: () =>
      client<PipelineTemplate[]>(
        `/api/group-pipelines/templates${groupId ? `?groupId=${groupId}` : ""}`,
        "templates",
        { fallback: "小组的流程读不出来。" },
      ),
  });
}

/**
 * One run, asked again every few seconds while it is still going.
 *
 * `refetchInterval` is a function rather than a constant because a finished run has nothing left to
 * report: the screen keeps the last answer on screen and stops asking, so a tab left open over a done
 * crew is not a quiet loop of requests. A parked run is polled too -- the person may answer the
 * approval in another tab, and this is the only place that will notice.
 */
export function pipelineRunQueryOptions(runId: string | null) {
  return queryOptions({
    queryKey: pipelineKeys.run(runId ?? "none"),
    enabled: Boolean(runId),
    queryFn: () =>
      client<PipelineRun>(`/api/group-pipelines/runs/${runId}`, "run", {
        fallback: "这次运行的状态读不出来。",
      }),
    refetchInterval: (query) =>
      query.state.data &&
      query.state.data.status !== "running" &&
      query.state.data.status !== "awaiting_action"
        ? false
        : 4_000,
  });
}
