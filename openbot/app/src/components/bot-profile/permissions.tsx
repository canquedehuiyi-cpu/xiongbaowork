import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { IconLock } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { cn } from "@/lib/utils";
import { ProfileAlert, ProfilePanel, ProfileSection } from "./profile-kit";

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
  // Local apps (MCP) on the owner's paired machine (device MCP bridge §4.2).
  { ref: "computer_apps", label: "查看本机应用" },
  { ref: "computer_app_call", label: "使用本机应用" },
  { ref: "computer_app_enable", label: "启用本机应用" },
  // Looking at the owner's desktop, read only (device-side desktop viewing, Phase 1).
  { ref: "computer_desktop_windows", label: "列出桌面窗口" },
  { ref: "computer_desktop_snapshot", label: "查看桌面" },
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
    <ProfileSection
      description={
        data
          ? data.ownedByAnother
            ? "这些是员工所有者设定的权限，你使用这位员工时同样适用，只有所有者可以修改。"
            : "你在这里的设定是员工所有者设定：其他人使用这位员工时同样适用。修改密码、安全设置和付款永远交给本人。"
          : undefined
      }
      title="权限"
    >
      {error ? <ProfileAlert>{error.message}</ProfileAlert> : null}
      {data ? (
        <div className="mt-[10px] flex flex-col gap-[18px]">
          {me?.role === "admin" ? (
            <p className="text-[13px]">
              <Link
                className="text-foreground underline decoration-foreground/30 underline-offset-[3px] hover:decoration-foreground"
                to="/admin/enterprise"
              >
                企业模式：前往企业管控
              </Link>
            </p>
          ) : null}
          <ToolModes
            busy={busy}
            data={data}
            editable={editable}
            onChange={(toolRef, next) => mode.mutate({ toolRef, mode: next })}
            tools={tools}
          />
          <div>
            <h3 className={SUBHEAD}>危险命令与敏感文件</h3>
            <ProfilePanel>
              <label
                className={cn(ROW, "cursor-pointer")}
                htmlFor={`${agentId}-dangerous`}
              >
                <span className="min-w-0">
                  <span
                    className="block font-medium text-[13.5px]"
                    id={`${agentId}-dangerous-title`}
                  >
                    危险命令需审批
                  </span>
                  <span className="text-[12.5px] text-muted-foreground">
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
                className={cn(ROW, "cursor-pointer")}
                htmlFor={`${agentId}-sensitive`}
              >
                <span className="min-w-0">
                  <span
                    className="block font-medium text-[13.5px]"
                    id={`${agentId}-sensitive-title`}
                  >
                    敏感文件需审批
                  </span>
                  <span className="text-[12.5px] text-muted-foreground">
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
              <ul
                aria-label="敏感文件路径"
                className="divide-y divide-border empty:hidden"
              >
                {data.defaultSensitivePaths.map((path) => {
                  const off = data.security.disabledDefaultPaths.includes(path);
                  return (
                    <li className={cn(ROW, "py-[8px] pl-[28px]")} key={path}>
                      <span className="min-w-0 break-all text-[13px]">
                        <code className="font-mono text-[12px]">{path}</code>
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
                        size="sm"
                      />
                    </li>
                  );
                })}
                {data.security.extraSensitivePaths.map((path) => (
                  <li className={cn(ROW, "py-[8px] pl-[28px]")} key={path}>
                    <code className="min-w-0 break-all font-mono text-[12px]">
                      {path}
                    </code>
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
                  className={cn(ROW, "justify-start gap-[7px]")}
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
                  <Input
                    aria-label="添加敏感路径"
                    className="h-[32px] min-w-0 flex-1 font-mono text-[12px]"
                    onChange={(event) => setNewPath(event.target.value)}
                    placeholder="例如 config/prod/** 或 *.p12"
                    value={newPath}
                  />
                  <Button
                    disabled={busy || !newPath.trim()}
                    size="sm"
                    type="submit"
                  >
                    添加
                  </Button>
                </form>
              ) : null}
            </ProfilePanel>
          </div>
        </div>
      ) : null}
    </ProfileSection>
  );
}

/** A row in a permissions panel: what it is on the left, its control on the right. */
const ROW = "flex items-center justify-between gap-[12px] px-[14px] py-[11px]";

/** A group's small heading inside the 权限 section. */
const SUBHEAD = "font-semibold text-[13px] text-foreground/90";

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
    <div>
      <h3 className={SUBHEAD}>工具</h3>
      <ProfilePanel>
        {data.teamRules.map((rule) => (
          <div className={cn(ROW, "text-[13px]")} key={rule.id}>
            <span className="min-w-0 break-all">
              <code className="font-mono text-[12px]">{rule.toolRef}</code>
              <span className="ml-2 text-muted-foreground">管理员设定</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-[5px] text-muted-foreground">
              <IconLock aria-hidden="true" className="size-[13px]" />
              <span>
                {BEHAVIOUR_LABELS[rule.behaviour] ?? rule.behaviour}（已锁定）
              </span>
            </span>
          </div>
        ))}
        {tools.map((tool) => {
          const saved = data.modes.find((entry) => entry.toolRef === tool.ref);
          const current = saved
            ? MODE_OF_BEHAVIOUR[saved.behaviour]
            : undefined;
          return (
            <div
              className={cn(ROW, "flex-wrap gap-y-[7px] py-[9px]")}
              key={tool.ref}
            >
              <span className="min-w-0 text-[13px]">
                <span className="font-medium">{tool.label}</span>
                <span className="ml-2 break-all font-mono text-[11px] text-muted-foreground">
                  {tool.ref}
                </span>
                {saved && data.ownedByAnother ? (
                  <span className="ml-2 text-muted-foreground">
                    员工所有者设定
                  </span>
                ) : null}
              </span>
              {/*
               * The three modes as one segmented control (theme.css `.segmented`): the chosen one
               * filled white, the others quiet; choosing the chosen one again goes back to the
               * default, as before.
               */}
              <div
                aria-label={`「${tool.label}」的权限`}
                className="inline-flex shrink-0 gap-[2px] rounded-[10px] border border-border bg-background/60 p-[2px]"
                role="radiogroup"
              >
                {MODES.map((choice) => (
                  <Button
                    aria-checked={current === choice}
                    className={cn(
                      "h-[26px] rounded-[8px] px-[10px] text-[12px]",
                      current === choice ? null : "text-muted-foreground",
                    )}
                    disabled={!editable || busy}
                    key={choice}
                    onClick={() =>
                      onChange(
                        tool.ref,
                        current === choice ? "default" : choice,
                      )
                    }
                    role="radio"
                    size="sm"
                    type="button"
                    variant={current === choice ? "default" : "ghost"}
                  >
                    {TOOL_MODE_LABELS[choice]}
                  </Button>
                ))}
              </div>
            </div>
          );
        })}
      </ProfilePanel>
    </div>
  );
}
