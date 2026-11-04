import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as React from "react";
import { devicesQueryOptions } from "@/lib/devices/queries";
import {
  chooseProjectMutationOptions,
  projectsQueryOptions,
  sourceSummary,
} from "@/lib/projects/queries";

/**
 * Which project a coworker works in (story RES2, §3.5): the one picker the conversation and the
 * coworker's detail page share.
 *
 * A project belongs to one machine, so the picker asks per machine: with more than one paired, the
 * machine is picked first. Offered are the projects this coworker may use there (公开 ones and its
 * own); another coworker's own project is never listed, and a project on another machine is shown
 * greyed with where it is, so a person looking for it learns why it cannot be picked here. "不使用项目"
 * clears the choice and the coworker works in its own workspace, as before.
 *
 * Only a person picks (decision D8): this writes `PUT /api/projects/current` from the person's
 * session, and no coworker has a tool that does.
 *
 * `compact` is the conversation's form: one line, and nothing at all when the person has no machine
 * with a project the coworker could use, so a chat with no projects looks as it always did.
 */
export function ProjectPicker({
  agentId,
  compact = false,
}: {
  agentId: string;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const devices = useQuery(devicesQueryOptions());
  const machines = devices.data ?? [];
  const [chosen, setChosen] = React.useState("");
  const deviceId = chosen || machines[0]?.id || "";
  const lists = useQueries({
    queries: machines.map((machine) => ({
      ...projectsQueryOptions(machine.id, agentId),
      enabled: Boolean(agentId),
    })),
  });
  const choose = useMutation(chooseProjectMutationOptions(queryClient));
  const index = machines.findIndex((machine) => machine.id === deviceId);
  const here = index >= 0 ? lists[index]?.data : undefined;
  const elsewhere = machines.flatMap((machine, at) =>
    at === index
      ? []
      : (lists[at]?.data?.projects ?? []).map((project) => ({
          project,
          machine,
        })),
  );
  const offered = here?.projects ?? [];
  const current = here?.currentProjectId ?? null;
  const currentProject = offered.find((project) => project.id === current);

  if (devices.isPending || devices.isError || machines.length === 0)
    return compact ? null : (
      <p className="text-muted-foreground text-sm">
        {devices.isPending
          ? "正在读取设备…"
          : devices.isError
            ? "读不到设备。"
            : "还没有配对的设备，所以没有可选的项目。"}
      </p>
    );
  if (compact && offered.length === 0 && elsewhere.length === 0) return null;

  return (
    <div
      className={
        compact
          ? "flex flex-wrap items-center gap-2 px-1 text-xs"
          : "space-y-2 text-sm"
      }
    >
      {machines.length > 1 ? (
        <label>
          设备
          <select
            aria-label="项目所在设备"
            className="ml-1 rounded border p-1"
            onChange={(event) => setChosen(event.target.value)}
            value={deviceId}
          >
            {machines.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {machine.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label>
        当前项目
        <select
          aria-label="当前项目"
          className="ml-1 rounded border p-1"
          disabled={choose.isPending || !here}
          onChange={(event) =>
            choose.mutate({
              deviceId,
              agentId,
              projectId: event.target.value || null,
            })
          }
          value={current ?? ""}
        >
          <option value="">不使用项目（在员工自己的工作区里）</option>
          {offered.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
              {project.scope === "agent" ? "（专属）" : ""}
            </option>
          ))}
          {elsewhere.map(({ project, machine }) => (
            <option disabled key={project.id} value={project.id}>
              {project.name}（在另一台设备上：{machine.name}）
            </option>
          ))}
        </select>
      </label>
      {!compact && currentProject ? (
        <p className="text-muted-foreground">
          {sourceSummary(currentProject.source)}
          。派活时文件和命令默认在这个项目里执行。
        </p>
      ) : null}
      {choose.error ? (
        <p className="text-destructive" role="alert">
          {choose.error.message}
        </p>
      ) : null}
    </div>
  );
}
