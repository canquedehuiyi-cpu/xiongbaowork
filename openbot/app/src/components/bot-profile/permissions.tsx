import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  BEHAVIOUR_LABELS,
  type EmployeePermissions,
  type EmployeeToolMode,
  employeePermissionsOptions,
  MODE_OF_BEHAVIOUR,
  setEmployeeSecurity,
  setEmployeeToolMode,
  TOOL_MODE_LABELS,
} from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";

/**
 * The tools every Bot has on its own computer, and on its owner's computer through host access,
 * and the one for handing work to another Bot. Granted connector tools are added from the Bot's
 * grants. Named the way the approval gate names them, so a mode set here is the rule it checks.
 */
const BUILT_IN_TOOLS: { ref: string; label: string }[] = [
  { ref: "computer_navigate", label: "打开网页" },
  { ref: "computer_click", label: "点击网页" },
  { ref: "computer_type", label: "在网页上输入" },
  { ref: "computer_key", label: "按键" },
  { ref: "computer_read_file", label: "读取文件" },
  { ref: "computer_write_file", label: "写入文件" },
  { ref: "computer_list_files", label: "列出文件" },
  { ref: "computer_download_file", label: "下载文件" },
  { ref: "computer_run_command", label: "运行命令" },
  { ref: "host/read_file", label: "读取你电脑上的文件" },
  { ref: "host/write_file", label: "写入你电脑上的文件" },
  { ref: "host/list_files", label: "列出你电脑上的文件" },
  { ref: "host/run_command", label: "在你电脑上运行命令" },
  { ref: "bot/message_bot", label: "把工作交给其他员工" },
];

const MODES = Object.keys(TOOL_MODE_LABELS) as EmployeeToolMode[];

/**
 * A Bot's 权限 section (SEC1 §4.5): each tool 直接 / 询问 / 禁用, the dangerous-command and
 * sensitive-file switches, and the sensitive path list. Only the Bot's owner changes them; the
 * owner's settings also bind everybody else who uses the Bot, which is said in so many words, and
 * somebody else sees them read-only. Team rules are locked rows.
 */
export function BotPermissions({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const permissions = useQuery(employeePermissionsOptions(agentId));
  const granted = useQuery(agentPluginsQueryOptions(agentId));
  const { data: me } = useQuery(currentUserQueryOptions());
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["approvals"] });
  const mode = useMutation({
    mutationFn: (input: {
      toolRef: string;
      mode: EmployeeToolMode | "default";
    }) => setEmployeeToolMode(agentId, input),
    onSuccess: refresh,
  });
  const security = useMutation({
    mutationFn: (input: Parameters<typeof setEmployeeSecurity>[1]) =>
      setEmployeeSecurity(agentId, input),
    onSuccess: refresh,
  });
  const [newPath, setNewPath] = useState("");
  const data = permissions.data;
  const error = permissions.error ?? mode.error ?? security.error;
  const tools = [
    ...BUILT_IN_TOOLS,
    ...(granted.data?.tools ?? []).map((tool) => ({
      ref: tool.ref,
      label: tool.toolName,
    })),
  ];
  const editable = data?.editable === true;
  const busy = mode.isPending || security.isPending;
  return (
    <PageSection title="权限">
      <div className="mt-4 space-y-6">
        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error.message}
          </p>
        ) : null}
        {data ? (
          <>
            <p className="text-muted-foreground text-sm">
              {data.ownedByAnother
                ? "这些是员工所有者设定的权限，你使用这位员工时同样适用，只有所有者可以修改。"
                : "你在这里的设定是员工所有者设定：其他人使用这位员工时同样适用。修改密码、安全设置和付款永远交给本人。"}
            </p>
            {me?.role === "admin" ? (
              <p className="text-sm">
                <Link className="underline" to="/admin/enterprise">
                  企业模式：前往企业管控
                </Link>
              </p>
            ) : null}
            <ToolModes
              busy={busy}
              data={data}
              editable={editable}
              onChange={(toolRef, next) =>
                mode.mutate({ toolRef, mode: next })
              }
              tools={tools}
            />
            <div className="space-y-3">
              <h3 className="font-medium">危险命令与敏感文件</h3>
              <label
                className="flex items-center justify-between gap-4 rounded-lg border p-4"
                htmlFor={`${agentId}-dangerous`}
              >
                <span>
                  <span className="block font-medium" id={`${agentId}-dangerous-title`}>
                    危险命令需审批
                  </span>
                  <span className="text-muted-foreground text-sm">
                    {data.enforceDangerousCommands
                      ? "团队已强制开启危险命令审批，这里关闭也仍需审批。"
                      : "删除大量文件、提权、强制推送这类命令，运行前先问。"}
                  </span>
                </span>
                <Switch
                  aria-labelledby={`${agentId}-dangerous-title`}
                  checked={
                    data.security.dangerousCommands === "ask" ||
                    data.enforceDangerousCommands
                  }
                  disabled={!editable || busy || data.enforceDangerousCommands}
                  id={`${agentId}-dangerous`}
                  onCheckedChange={(on) =>
                    security.mutate({ dangerousCommands: on ? "ask" : "off" })
                  }
                />
              </label>
              <label
                className="flex items-center justify-between gap-4 rounded-lg border p-4"
                htmlFor={`${agentId}-sensitive`}
              >
                <span>
                  <span className="block font-medium" id={`${agentId}-sensitive-title`}>
                    敏感文件需审批
                  </span>
                  <span className="text-muted-foreground text-sm">
                    读写下面这些文件之前先问。
                  </span>
                </span>
                <Switch
                  aria-labelledby={`${agentId}-sensitive-title`}
                  checked={data.security.sensitivePaths === "ask"}
                  disabled={!editable || busy}
                  id={`${agentId}-sensitive`}
                  onCheckedChange={(on) =>
                    security.mutate({ sensitivePaths: on ? "ask" : "off" })
                  }
                />
              </label>
              <ul className="space-y-2" aria-label="敏感文件路径">
                {data.defaultSensitivePaths.map((path) => {
                  const off = data.security.disabledDefaultPaths.includes(path);
                  return (
                    <li
                      className="flex items-center justify-between gap-4 rounded-md border px-3 py-2 text-sm"
                      key={path}
                    >
                      <span>
                        <code>{path}</code>
                        <span className="ml-2 text-muted-foreground">
                          默认{off ? "（已停用）" : ""}
                        </span>
                      </span>
                      <Switch
                        aria-label={`启用默认路径 ${path}`}
                        checked={!off}
                        disabled={!editable || busy}
                        onCheckedChange={(on) =>
                          security.mutate({
                            disabledDefaultPaths: on
                              ? data.security.disabledDefaultPaths.filter(
                                  (entry) => entry !== path,
                                )
                              : [...data.security.disabledDefaultPaths, path],
                          })
                        }
                      />
                    </li>
                  );
                })}
                {data.security.extraSensitivePaths.map((path) => (
                  <li
                    className="flex items-center justify-between gap-4 rounded-md border px-3 py-2 text-sm"
                    key={path}
                  >
                    <code>{path}</code>
                    {editable ? (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          security.mutate({
                            extraSensitivePaths:
                              data.security.extraSensitivePaths.filter(
                                (entry) => entry !== path,
                              ),
                          })
                        }
                        size="sm"
                        variant="outline"
                      >
                        删除
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {editable ? (
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const path = newPath.trim();
                    if (!path) return;
                    security.mutate({
                      extraSensitivePaths: [
                        ...data.security.extraSensitivePaths,
                        path,
                      ],
                    });
                    setNewPath("");
                  }}
                >
                  <input
                    aria-label="添加敏感路径"
                    className="h-9 flex-1 rounded-md border bg-background px-2 text-sm"
                    onChange={(event) => setNewPath(event.target.value)}
                    placeholder="例如 config/prod/** 或 *.p12"
                    value={newPath}
                  />
                  <Button disabled={busy || !newPath.trim()} type="submit">
                    添加
                  </Button>
                </form>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </PageSection>
  );
}

function ToolModes({
  tools,
  data,
  editable,
  busy,
  onChange,
}: {
  tools: { ref: string; label: string }[];
  data: EmployeePermissions;
  editable: boolean;
  busy: boolean;
  onChange: (toolRef: string, mode: EmployeeToolMode | "default") => void;
}) {
  return (
    <div className="space-y-2">
      <h3 className="font-medium">工具</h3>
      {data.teamRules.map((rule) => (
        <div
          className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm"
          key={rule.id}
        >
          <span>
            <code>{rule.toolRef}</code>
            <span className="ml-2 text-muted-foreground">管理员设定</span>
          </span>
          <span>
            {BEHAVIOUR_LABELS[rule.behaviour] ?? rule.behaviour}（已锁定）
          </span>
        </div>
      ))}
      {tools.map((tool) => {
        const saved = data.modes.find((entry) => entry.toolRef === tool.ref);
        const current = saved ? MODE_OF_BEHAVIOUR[saved.behaviour] : undefined;
        return (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            key={tool.ref}
          >
            <span className="text-sm">
              {tool.label}
              <span className="ml-2 text-muted-foreground">{tool.ref}</span>
              {saved && data.ownedByAnother ? (
                <span className="ml-2 text-muted-foreground">员工所有者设定</span>
              ) : null}
            </span>
            <div
              aria-label={`「${tool.label}」的权限`}
              className="flex gap-1"
              role="radiogroup"
            >
              {MODES.map((choice) => (
                <Button
                  aria-checked={current === choice}
                  disabled={!editable || busy}
                  key={choice}
                  onClick={() =>
                    onChange(tool.ref, current === choice ? "default" : choice)
                  }
                  role="radio"
                  size="sm"
                  variant={current === choice ? "default" : "outline"}
                >
                  {TOOL_MODE_LABELS[choice]}
                </Button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
