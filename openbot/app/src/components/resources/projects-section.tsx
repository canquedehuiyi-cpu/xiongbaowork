import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { LabeledSelect } from "@/components/layout/labeled-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import {
  devicesQueryOptions,
  type RegisteredDevice,
} from "@/lib/devices/queries";
import {
  createProjectMutationOptions,
  gitBranchProblem,
  gitUrlProblem,
  listBranchesMutationOptions,
  type NewProject,
  PROJECT_DESCRIPTION_LIMIT,
  PROJECT_LIMIT_PER_DEVICE,
  PROJECT_NAME_LIMIT,
  type Project,
  projectsQueryOptions,
  removeProjectMutationOptions,
  sourceSummary,
  syncProjectMutationOptions,
} from "@/lib/projects/queries";
import { cn } from "@/lib/utils";
import { CARD_FACE, TabEmpty, TabHeader, Tag } from "./resource-kit";

/**
 * 能力与资源 › 项目 (story RES2, spec §5 RES2-3): the projects on one of the person's paired machines.
 *
 * A machine is picked first, and only its projects are shown: a project belongs to one machine.
 * A new project is either a folder the machine's owner registered there (本地目录, listed by the name
 * given on the machine, never a path) or a Git repository and branch, which the machine clones
 * itself (Git 仓库). A folder registered read-only on the machine cannot be made writable here
 * (decision D3). 公开 projects are offered to every coworker on the machine; 员工专属 to the one
 * picked, and picking one is required.
 *
 * 同步 and 列出分支 are asked of the machine, so both wait for it to be online and say so.
 */

/** A folder as the device list reports it, with the mode the machine registered it in (D3). */
type Folder = { ref: string; name: string; mode?: "read" | "write" };

const foldersOf = (device: RegisteredDevice | undefined): Folder[] =>
  (device?.roots ?? []) as Folder[];

const OFFLINE_REASON =
  "设备离线，无法同步或列出分支。请在设备上打开熊宝设备端后再试。";

const characters = (value: string) => [...value].length;

/** The form's native selects, drawn as the workbench's 30px dark field. */
const NATIVE_SELECT =
  "ml-2 h-[30px] rounded-[9px] border border-border bg-muted px-2 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60 dark:bg-[oklch(0.196_0.002_286.2)]";

export function ProjectsSection() {
  const devices = useQuery(devicesQueryOptions());
  const list = devices.data ?? [];
  const [chosen, setChosen] = React.useState<string>("");
  const deviceId = chosen || list[0]?.id || "";
  const device = list.find((entry) => entry.id === deviceId);

  return (
    <>
      <TabHeader
        description="员工在你的电脑上干活时所在的目录：一个本地目录，或者由设备拉取的 Git 仓库。公开项目这台设备上的所有员工都能选用，员工专属项目只有那位员工能选用。"
        search={
          list.length > 0 ? (
            // docs/design/ios-studio's toolbar filter: 「设备 名称 ▾」, a native select underneath.
            <LabeledSelect
              label="设备"
              onValueChange={setChosen}
              options={list.map((entry) => ({
                value: entry.id,
                label: `${entry.name}${entry.online ? "" : "（离线）"}`,
              }))}
              value={deviceId}
            />
          ) : null
        }
      />
      {devices.isPending ? (
        <Skeleton
          aria-label="正在读取设备"
          className="mt-[12px] h-[104px] rounded-[13px]"
          role="status"
        />
      ) : devices.isError ? (
        <p className="mt-[12px] text-destructive text-sm" role="alert">
          读不到设备。
        </p>
      ) : list.length === 0 ? (
        <TabEmpty
          description="项目放在你自己的电脑上，请先在「我的设备」里配对一台电脑。"
          title="还没有配对的设备。"
        />
      ) : device ? (
        <DeviceProjects device={device} key={device.id} />
      ) : null}
    </>
  );
}

function DeviceProjects({ device }: { device: RegisteredDevice }) {
  const queryClient = useQueryClient();
  const projects = useQuery(projectsQueryOptions(device.id));
  const agents = useQuery(agentListQueryOptions());
  const remove = useMutation(removeProjectMutationOptions(queryClient));
  const sync = useMutation(syncProjectMutationOptions(queryClient));
  const [adding, setAdding] = React.useState(false);
  const rows = projects.data?.projects ?? [];
  const nameOf = (agentId: string | null) =>
    agents.data?.find((agent) => agent.id === agentId)?.name ?? "一位员工";

  return (
    <div className="mt-[12px]">
      {projects.isPending ? (
        <Skeleton
          aria-label="正在读取项目"
          className="h-[104px] rounded-[13px]"
          role="status"
        />
      ) : projects.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {projects.error.message}
        </p>
      ) : rows.length === 0 ? (
        <p className="flex min-h-[86px] items-center justify-center rounded-[13px] border border-border border-dashed px-4 text-center text-[13px] text-muted-foreground">
          这台设备上还没有项目。
        </p>
      ) : (
        <ItemGroup
          aria-label="这台设备上的项目"
          className="grid grid-cols-1 gap-[9px] lg:grid-cols-2"
          role="list"
        >
          {rows.map((project) => (
            <Item
              className={cn(
                CARD_FACE,
                "min-h-[86px] items-start gap-[10px] px-[11px] py-[10px] dark:border-border",
              )}
              key={project.id}
              role="listitem"
              size="sm"
              variant="outline"
            >
              <ItemContent className="min-w-0">
                <ItemTitle className="flex-wrap font-bold text-[13px]">
                  {project.name}
                  <Tag>
                    {project.scope === "public"
                      ? "公开"
                      : `员工专属 · ${nameOf(project.agentId)}`}
                  </Tag>
                </ItemTitle>
                <ItemDescription className="text-[12px]">
                  {sourceSummary(project.source)}
                </ItemDescription>
                {project.description ? (
                  <ItemDescription className="text-[12px]">
                    {project.description}
                  </ItemDescription>
                ) : null}
              </ItemContent>
              <ItemActions className="shrink-0 flex-wrap justify-end">
                {project.source.kind === "git" ? (
                  <SyncButton
                    device={device}
                    onSync={() => sync.mutate(project.id)}
                    pending={sync.isPending && sync.variables === project.id}
                    project={project}
                  />
                ) : null}
                <Button
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(project.id)}
                  size="sm"
                  variant="outline"
                >
                  删除
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
      {sync.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {sync.error.message}
        </p>
      ) : null}
      {remove.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {remove.error.message}
        </p>
      ) : null}
      {adding ? (
        <NewProjectForm
          agents={agents.data ?? []}
          device={device}
          onDone={() => setAdding(false)}
        />
      ) : (
        <Button
          className="mt-[12px]"
          disabled={rows.length >= PROJECT_LIMIT_PER_DEVICE}
          onClick={() => setAdding(true)}
          variant="outline"
        >
          <IconPlus />
          新建项目
        </Button>
      )}
      {rows.length >= PROJECT_LIMIT_PER_DEVICE ? (
        <p className="mt-2 text-muted-foreground text-sm">
          每台设备最多 {PROJECT_LIMIT_PER_DEVICE} 个项目。
        </p>
      ) : null}
    </div>
  );
}

function SyncButton({
  device,
  project,
  pending,
  onSync,
}: {
  device: RegisteredDevice;
  project: Project;
  pending: boolean;
  onSync: () => void;
}) {
  return (
    <span className="flex items-center gap-2">
      {device.online ? null : (
        <span className="text-muted-foreground text-xs">{OFFLINE_REASON}</span>
      )}
      <Button
        aria-label={`同步 ${project.name}`}
        disabled={!device.online || pending}
        onClick={onSync}
        size="sm"
        variant="outline"
      >
        {pending ? "正在同步…" : "同步"}
      </Button>
    </span>
  );
}

/** Why a draft cannot be saved as it stands, or null. Said before a request is sent. */
function draftProblem(draft: {
  name: string;
  description: string;
  kind: "local" | "git";
  rootRef: string;
  url: string;
  branch: string;
  scope: "public" | "agent";
  agentId: string;
}): string | null {
  if (!draft.name.trim()) return "请给项目起个名字。";
  if (characters(draft.name.trim()) > PROJECT_NAME_LIMIT)
    return `项目名称最多 ${PROJECT_NAME_LIMIT} 个字。`;
  if (characters(draft.description.trim()) > PROJECT_DESCRIPTION_LIMIT)
    return `项目简介最多 ${PROJECT_DESCRIPTION_LIMIT} 个字。`;
  if (draft.kind === "local" && !draft.rootRef)
    return "请选择设备上已登记的本地目录。";
  if (draft.kind === "git") {
    const problem = gitUrlProblem(draft.url) ?? gitBranchProblem(draft.branch);
    if (problem) return problem;
  }
  if (draft.scope === "agent" && !draft.agentId)
    return "员工专属项目需要选择一位员工。";
  return null;
}

function NewProjectForm({
  device,
  agents,
  onDone,
}: {
  device: RegisteredDevice;
  agents: AgentProfile[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const formId = React.useId();
  const create = useMutation(createProjectMutationOptions(queryClient));
  const branches = useMutation(listBranchesMutationOptions());
  const folders = foldersOf(device);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [kind, setKind] = React.useState<"local" | "git">("local");
  const [rootRef, setRootRef] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [branch, setBranch] = React.useState("main");
  const [writable, setWritable] = React.useState(false);
  const [scope, setScope] = React.useState<"public" | "agent">("public");
  const [agentId, setAgentId] = React.useState("");
  const [tried, setTried] = React.useState(false);
  const folder = folders.find((entry) => entry.ref === rootRef);
  const folderWritable = folder?.mode === "write";
  const mine = agents.filter((agent) => agent.canManage);

  const draft = {
    name,
    description,
    kind,
    rootRef,
    url,
    branch,
    scope,
    agentId,
  };
  const problem = draftProblem(draft);

  const save = () => {
    setTried(true);
    if (problem) return;
    const input: NewProject = {
      deviceId: device.id,
      name: name.trim(),
      description: description.trim(),
      scope,
      agentId: scope === "agent" ? agentId : null,
      source:
        kind === "local"
          ? { kind, rootRef, writable: writable && folderWritable }
          : { kind, url: url.trim(), branch: branch.trim(), writable },
    };
    create.mutate(input, { onSuccess: onDone });
  };

  return (
    <form
      aria-label="新建项目"
      className={cn(CARD_FACE, "mt-[12px] space-y-3 p-[14px] text-[13px]")}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label className="block text-sm" htmlFor={`${formId}-name`}>
        项目名称
        <Input
          id={`${formId}-name`}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </label>
      <label className="block text-sm" htmlFor={`${formId}-description`}>
        项目简介（可选）
        <Textarea
          id={`${formId}-description`}
          onChange={(event) => setDescription(event.target.value)}
          value={description}
        />
      </label>

      <fieldset className="text-sm">
        <legend>项目来源</legend>
        <label className="mr-4">
          <input
            checked={kind === "local"}
            name="project-kind"
            onChange={() => {
              setKind("local");
              setWritable(false);
            }}
            type="radio"
          />{" "}
          本地目录
        </label>
        <label>
          <input
            checked={kind === "git"}
            name="project-kind"
            onChange={() => {
              setKind("git");
              setWritable(true);
            }}
            type="radio"
          />{" "}
          Git 仓库
        </label>
      </fieldset>

      {kind === "local" ? (
        folders.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            这台设备还没有登记本地目录。请在设备端添加文件夹（如需让员工修改，登记时选择“读写”）。
          </p>
        ) : (
          <fieldset className="text-sm">
            <legend>选择设备上已登记的目录</legend>
            {folders.map((entry) => (
              <label className="block" key={entry.ref}>
                <input
                  checked={rootRef === entry.ref}
                  name="project-folder"
                  onChange={() => {
                    setRootRef(entry.ref);
                    if (entry.mode !== "write") setWritable(false);
                  }}
                  type="radio"
                />{" "}
                {entry.name}
                <span className="text-muted-foreground">
                  {" "}
                  ·{" "}
                  {entry.mode === "write"
                    ? "设备上登记为读写"
                    : "设备上登记为只读"}
                </span>
              </label>
            ))}
          </fieldset>
        )
      ) : (
        <>
          <label className="block text-sm" htmlFor={`${formId}-url`}>
            仓库地址
            <Input
              id={`${formId}-url`}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://… 或 git@主机:路径"
              value={url}
            />
          </label>
          <p className="text-muted-foreground text-xs">
            地址里不要带密码或令牌。私有仓库请在这台设备上配置 SSH
            密钥或凭据，代码由设备拉取，服务器不会连接仓库。
          </p>
          <label className="block text-sm" htmlFor={`${formId}-branch`}>
            分支
            <Input
              id={`${formId}-branch`}
              onChange={(event) => setBranch(event.target.value)}
              value={branch}
            />
          </label>
          <span className="flex items-center gap-2">
            <Button
              disabled={
                !device.online ||
                branches.isPending ||
                Boolean(gitUrlProblem(url))
              }
              onClick={() =>
                branches.mutate({ deviceId: device.id, url: url.trim() })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              列出分支
            </Button>
            {device.online ? null : (
              <span className="text-muted-foreground text-xs">
                {OFFLINE_REASON}
              </span>
            )}
          </span>
          {branches.data?.length ? (
            <label className="block text-sm">
              选择分支
              <select
                aria-label="选择分支"
                className={NATIVE_SELECT}
                onChange={(event) => setBranch(event.target.value)}
                value={branches.data.includes(branch) ? branch : ""}
              >
                <option disabled value="">
                  选择一个分支
                </option>
                {branches.data.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {branches.error ? (
            <p className="text-destructive text-sm" role="alert">
              {branches.error.message}
            </p>
          ) : null}
        </>
      )}

      <label
        className="flex items-center gap-2 text-sm"
        htmlFor={`${device.id}-project-writable`}
      >
        <Checkbox
          checked={writable}
          id={`${device.id}-project-writable`}
          disabled={kind === "local" && !folderWritable}
          onCheckedChange={(value) => setWritable(value === true)}
        />
        允许员工修改项目里的文件
      </label>
      {kind === "local" && folder && !folderWritable ? (
        <p className="text-muted-foreground text-xs">
          这个目录在设备上登记为只读，所以项目只能只读。如需写入，请在设备上把它登记为读写。
        </p>
      ) : null}

      <fieldset className="text-sm">
        <legend>范围</legend>
        <label className="mr-4">
          <input
            checked={scope === "public"}
            name="project-scope"
            onChange={() => setScope("public")}
            type="radio"
          />{" "}
          公开（这台设备上的所有员工）
        </label>
        <label>
          <input
            checked={scope === "agent"}
            name="project-scope"
            onChange={() => setScope("agent")}
            type="radio"
          />{" "}
          员工专属
        </label>
      </fieldset>
      {scope === "agent" ? (
        <label className="block text-sm">
          员工
          <select
            aria-label="员工"
            className={NATIVE_SELECT}
            onChange={(event) => setAgentId(event.target.value)}
            value={agentId}
          >
            <option value="">选择一位员工</option>
            {mine.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {tried && problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
      {create.error ? (
        <p className="text-destructive text-sm" role="alert">
          {create.error.message}
        </p>
      ) : null}
      <span className="flex gap-2">
        <Button disabled={create.isPending} size="sm" type="submit">
          保存项目
        </Button>
        <Button onClick={onDone} size="sm" type="button" variant="outline">
          取消
        </Button>
      </span>
    </form>
  );
}
