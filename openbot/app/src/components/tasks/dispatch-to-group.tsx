import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  PipelineDispatchRefused,
  type RefusedStep,
  startRunMutationOptions,
} from "@/lib/pipelines/mutations";
import {
  type PipelineTemplate,
  pipelineKeys,
  pipelineTemplatesQueryOptions,
} from "@/lib/pipelines/queries";
import {
  type WakerGroup,
  wakerGroupsQueryOptions,
} from "@/lib/waker-groups/queries";

/** One flow a person can hand a task to, named the way the group chat's `@` list names it. */
export type GroupFlowOption = {
  templateId: string;
  label: string;
  steps: number;
};

/**
 * One option per template rather than per crew: a crew with two flows is two different answers to
 * "派给这个群组", and picking one should not be a guess. The flow's name rides along only when its crew
 * has more than one, so the common single-flow crew reads as just the crew. A template whose crew this
 * person cannot see is not offered -- the server would refuse it, and the list should not promise it.
 */
export function groupFlowOptions(
  templates: PipelineTemplate[],
  crews: WakerGroup[],
): GroupFlowOption[] {
  return templates.flatMap((template) => {
    const crew = crews.find((entry) => entry.id === template.groupId);
    if (!crew) return [];
    const siblings = templates.filter(
      (other) => other.groupId === template.groupId,
    ).length;
    return [
      {
        templateId: template.id,
        label: siblings > 1 ? `${crew.name} · ${template.name}` : crew.name,
        steps: template.steps.length,
      },
    ];
  });
}

/**
 * 派给群组 on the board (spec I2): hand a crew's flow a task without leaving the board.
 *
 * The press goes through the same `startRunMutationOptions` the template page and the group chat use,
 * so the server's pre-dispatch check (spec I6) answers here exactly as it does there: a 403 naming the
 * steps whose coworkers this person may not use is listed step by step, and nothing was started. On
 * success the board's reads are refreshed -- the parent card is already on the server -- and the dialog
 * says where the run can be followed instead of closing on a silence that reads like a lost task.
 */
export function DispatchToGroup() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const templates = useQuery({
    ...pipelineTemplatesQueryOptions(),
    enabled: open,
  });
  const crews = useQuery({ ...wakerGroupsQueryOptions(), enabled: open });
  const coworkers = useQuery({ ...agentListQueryOptions(), enabled: open });
  const start = useMutation({
    ...startRunMutationOptions(queryClient),
    retry: false,
    onSuccess: () => {
      /*
       * The run's own reads, and both of the board's: the list and the bar each have a key family of
       * their own (`["tasks"]` does not prefix `["tasks-summary"]`), and the new parent card belongs
       * in both. Not awaited: the dialog's answer is the run id, not the refetch after it.
       */
      void queryClient.invalidateQueries({ queryKey: pipelineKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["tasks-summary"] });
    },
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [refused, setRefused] = useState<RefusedStep[] | null>(null);
  const [started, setStarted] = useState<{
    runId: string;
    label: string;
  } | null>(null);

  const options = groupFlowOptions(templates.data ?? [], crews.data ?? []);
  const templateId =
    chosen && options.some((option) => option.templateId === chosen)
      ? chosen
      : (options[0]?.templateId ?? "");
  const selected = options.find((option) => option.templateId === templateId);
  const names = new Map(
    (coworkers.data ?? []).map((agent) => [agent.id, agent.name]),
  );
  const loading = templates.isPending || crews.isPending;
  /*
   * The templates read already falls back to a Chinese sentence; the crews read's own fallback is
   * English, so its failure is said here in the product's language instead.
   */
  const readError =
    templates.error?.message ??
    (crews.error ? "群组读不出来，请稍后重试。" : null);
  const canSend =
    Boolean(selected) && task.trim().length > 0 && !start.isPending;

  const reset = () => {
    setProblem(null);
    setRefused(null);
    setStarted(null);
    start.reset();
  };

  const send = () => {
    if (!selected || !canSend) return;
    const label = selected.label;
    start.mutate(
      { templateId: selected.templateId, task: task.trim() },
      {
        onError: (thrown: Error) => {
          setProblem(thrown.message);
          setRefused(
            thrown instanceof PipelineDispatchRefused ? thrown.refused : null,
          );
        },
        onSuccess: (run) => {
          setTask("");
          setProblem(null);
          setRefused(null);
          setStarted({ runId: run.runId, label });
        },
      },
    );
  };

  return (
    <>
      <Button
        onClick={() => {
          reset();
          setOpen(true);
        }}
        size="sm"
        variant="outline"
      >
        派给群组
      </Button>
      <Dialog
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        open={open}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>派给群组</DialogTitle>
            <DialogDescription>
              选一个群组流程，写下任务。群组会按流程逐步执行，每一步都会作为子任务出现在看板上。
            </DialogDescription>
          </DialogHeader>
          {started ? (
            <DialogBody>
              <p role="status">
                {`已派给「${started.label}」，父任务已登记到看板。`}
              </p>
              <Link
                className="text-sm underline"
                search={{ run: started.runId }}
                to="/pipelines"
              >
                查看这次运行
              </Link>
            </DialogBody>
          ) : (
            <DialogBody>
              {readError ? (
                <p className="text-destructive text-sm" role="alert">
                  {readError}
                </p>
              ) : loading ? (
                <p className="text-muted-foreground text-sm">
                  正在读取群组流程…
                </p>
              ) : options.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  还没有可以派活的群组流程。
                  <Link className="underline" to="/pipelines">
                    去建一个
                  </Link>
                </p>
              ) : (
                <>
                  <select
                    aria-label="群组流程"
                    className="rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    onChange={(event) => {
                      setChosen(event.target.value);
                      setProblem(null);
                      setRefused(null);
                    }}
                    value={templateId}
                  >
                    {options.map((option) => (
                      <option key={option.templateId} value={option.templateId}>
                        {`${option.label}（${option.steps} 步）`}
                      </option>
                    ))}
                  </select>
                  <Textarea
                    aria-label="任务内容"
                    onChange={(event) => setTask(event.target.value)}
                    placeholder="要群组完成什么？"
                    value={task}
                  />
                </>
              )}
              {refused ? (
                <div className="text-destructive text-sm" role="alert">
                  <p>
                    这次没有派出去：下面这些步骤的员工你还没有使用权。先给他们开通使用权，或把这几步换成你能用的员工，再派一次。
                  </p>
                  <ul aria-label="没有派出去的步骤" className="list-disc pl-5">
                    {refused.map((step) => (
                      <li key={`${step.index}-${step.stepId}`}>
                        {`第 ${step.index + 1} 步：${names.get(step.agentId) ?? step.agentId}`}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : problem ? (
                <p className="text-destructive text-sm" role="alert">
                  {problem}
                </p>
              ) : null}
            </DialogBody>
          )}
          <DialogFooter>
            {started ? (
              <Button onClick={() => setOpen(false)} size="sm">
                完成
              </Button>
            ) : (
              <>
                <Button
                  onClick={() => setOpen(false)}
                  size="sm"
                  variant="ghost"
                >
                  取消
                </Button>
                <Button disabled={!canSend} onClick={send} size="sm">
                  {start.isPending ? "正在派出…" : "派出去"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
