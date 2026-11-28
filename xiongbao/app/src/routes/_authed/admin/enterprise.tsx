import {
  IconChartBar,
  IconChevronRight,
  IconFingerprint,
  IconKey,
  IconPlug,
  IconShieldLock,
  IconTerminal2,
  IconToggleRight,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  setCapabilityMutationOptions,
  setEnterpriseSettingMutationOptions,
} from "@/lib/enterprise/mutations";
import {
  actionRecordsQueryOptions,
  type CapabilitySetting,
  type EnterpriseOverview,
  enterpriseOverviewQueryOptions,
  isMcpServerApproved,
  modelUsageQueryOptions,
  withMcpServerApproval,
} from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";

// M4: 待接入 上游已把本页各分区拆到 权限/模型提供方/身份提供方/电脑/插件/自动学习/审计 页，并把 /admin/enterprise 重定向到 /admin；fork 保留本页，与新页有重复的设置项（网络与闲置电脑已搬到 设置 › 电脑与设备）
export const Route = createFileRoute("/_authed/admin/enterprise")({
  component: EnterprisePage,
});

function EnterprisePage() {
  const overview = useQuery(enterpriseOverviewQueryOptions());
  const setCapability = useMutation(setCapabilityMutationOptions(queryClient));
  const setSetting = useMutation(
    setEnterpriseSettingMutationOptions(queryClient),
  );
  const failure = setCapability.error ?? setSetting.error;

  return (
    <PageShell
      description="成员能用什么，以及会记录哪些内容。每次改动都会进入审计记录。"
      title="企业管控"
    >
      {failure ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}
      {overview.isPending ? null : overview.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          读不到企业管控设置。
        </p>
      ) : (
        <EnterpriseSections
          data={overview.data}
          onCapability={(capability, allowed) =>
            setCapability.mutate({
              scopeKind: "organization",
              scopeId: "",
              capability,
              allowed,
            })
          }
          onSetting={(key, value) => setSetting.mutate({ key, value })}
          saving={setCapability.isPending || setSetting.isPending}
        />
      )}
    </PageShell>
  );
}

function EnterpriseSections({
  data,
  onCapability,
  onSetting,
  saving,
}: {
  data: EnterpriseOverview;
  onCapability: (
    capability: CapabilitySetting["capability"],
    allowed: boolean,
  ) => void;
  onSetting: (
    key: keyof EnterpriseOverview["settings"],
    value: unknown,
  ) => void;
  saving: boolean;
}) {
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const { settings } = data;
  const overrideCount = data.capabilities.reduce(
    (count, capability) =>
      count +
      Object.keys(capability.roles).length +
      Object.keys(capability.groups).length,
    0,
  );

  return (
    <>
      <PageSection
        description="INITIAL_ADMIN_EMAILS 里的地址仍可用社交账号登录，作为紧急入口；每次这样的登录都会被审计。"
        title="登录"
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconShieldLock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>强制 SSO</ItemTitle>
              <ItemDescription>
                {settings.ssoRequired
                  ? "只有已登记的 SAML 或 OpenID Connect 身份提供方能让人登录。"
                  : "成员也可以用 Google、Microsoft 或 Okta 登录。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="强制 SSO"
                checked={settings.ssoRequired}
                disabled={saving}
                onCheckedChange={(checked) => onSetting("ssoRequired", checked)}
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconFingerprint />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>SCIM 自动开通</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {data.scim.configured
                  ? `目录基础地址 ${data.scim.baseUrl ?? "（请设置 BETTER_AUTH_URL）"}，使用 SCIM_BEARER_TOKEN 作为 Bearer 令牌。注销开通会结束会话、把地址加入拒绝名单、停用连接器凭据并停掉他们的电脑。`
                  : "已关闭。设置 SCIM_BEARER_TOKEN 后，可以接受来自 Okta、Entra 或其他目录的自动开通。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {data.scim.configured ? "开" : "关"}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection
        description="开关作用于整个组织。可以给角色设不同的答案，也可以给目录分组授予组织层面关掉的能力。"
        title="能力"
      >
        <PageRows>
          {data.capabilities.map((capability) => {
            const effective = capability.organization ?? capability.default;
            return (
              <div key={capability.capability}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconToggleRight />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{capability.title}</ItemTitle>
                    <ItemDescription>
                      {effective
                        ? capability.description
                        : "除非角色或分组授予，否则谁都不能用。"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      aria-label={capability.title}
                      checked={effective}
                      disabled={saving}
                      onCheckedChange={(checked) =>
                        onCapability(capability.capability, checked)
                      }
                    />
                  </ItemActions>
                </Item>
                <Separator />
              </div>
            );
          })}
          <Item
            render={
              <button onClick={() => setOverridesOpen(true)} type="button" />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconUsersGroup />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>按角色和分组覆盖</ItemTitle>
              <ItemDescription>
                {overrideCount === 0
                  ? "无：所有人都按上面的开关"
                  : `已设置 ${overrideCount} 项`}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection
        description="开启白名单后，员工只能调用这里批准过的 MCP 服务器上的工具，其他服务器的调用都会被拒绝。"
        title="MCP 服务器"
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconPlug />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>只用已批准的服务器</ItemTitle>
              <ItemDescription>
                {settings.mcpAllowlist.enabled
                  ? `已批准 ${settings.mcpAllowlist.servers.length} 个`
                  : "已关闭：每个已登记的服务器都可以按授权使用。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="只用已批准的 MCP 服务器"
                checked={settings.mcpAllowlist.enabled}
                disabled={saving}
                onCheckedChange={(enabled) =>
                  onSetting("mcpAllowlist", {
                    ...settings.mcpAllowlist,
                    enabled,
                  })
                }
              />
            </ItemActions>
          </Item>
          {data.mcpServers.map((server) => {
            const approved = isMcpServerApproved(
              settings.mcpAllowlist.servers,
              server,
            );
            return (
              <div key={server.id}>
                <Separator />
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{server.title}</ItemTitle>
                    <ItemDescription>{server.url}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      aria-label={`批准 ${server.title}`}
                      checked={approved}
                      disabled={saving}
                      onCheckedChange={(checked) =>
                        onSetting("mcpAllowlist", {
                          ...settings.mcpAllowlist,
                          servers: withMcpServerApproval(
                            settings.mcpAllowlist.servers,
                            server,
                            checked,
                          ),
                        })
                      }
                    />
                  </ItemActions>
                </Item>
              </div>
            );
          })}
        </PageRows>
      </PageSection>

      <PageSection
        description={`内置员工使用 ${data.builtInModel ?? "部署配置的模型"}。远程员工自己选择模型；它的流里报出的模型名会被记录。`}
        title="模型"
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconShieldLock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>模型白名单</ItemTitle>
              <ItemDescription>
                {settings.modelAllowlist.enabled
                  ? "使用未列出模型的内置员工会在运行前被拒绝。"
                  : "已关闭：任何模型都可以执行运行。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="模型白名单"
                checked={settings.modelAllowlist.enabled}
                disabled={saving}
                onCheckedChange={(enabled) =>
                  onSetting("modelAllowlist", {
                    ...settings.modelAllowlist,
                    enabled,
                  })
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item
            render={
              <button onClick={() => setModelsOpen(true)} type="button" />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconKey />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>允许的模型</ItemTitle>
              <ItemDescription>
                {settings.modelAllowlist.models.length === 0
                  ? "未列出任何模型"
                  : settings.modelAllowlist.models.join(", ")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
        <ModelUsage />
      </PageSection>

      <PageSection
        description="设置 OTEL_EXPORTER_OTLP_ENDPOINT 后，审计事件和员工动作会推送到你的 OpenTelemetry 收集器或 SIEM，并带上 xiongbao.surface 标签。"
        title="记录与导出"
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconTerminal2 />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>操作录制</ItemTitle>
              <ItemDescription>
                {settings.actionRecording
                  ? `员工执行的 Shell 命令会在去除密钥后记录，保留 ${data.actionRecordRetentionDays} 天。`
                  : "已关闭：命令只出现在审计记录里。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="操作录制"
                checked={settings.actionRecording}
                disabled={saving}
                onCheckedChange={(checked) =>
                  onSetting("actionRecording", checked)
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconChartBar />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>OpenTelemetry 导出</ItemTitle>
              <ItemDescription>
                {data.otel.configured
                  ? "正在通过 OTLP/HTTP 导出。"
                  : "未配置。请在服务器上设置 OTEL_EXPORTER_OTLP_ENDPOINT。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {data.otel.configured ? "开" : "关"}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
        {settings.actionRecording ? <RecordedActions /> : null}
      </PageSection>

      <OverridesDialog
        data={data}
        onOpenChange={setOverridesOpen}
        open={overridesOpen}
      />
      <ListDialog
        description="每行一个模型，格式为 提供方/模型，例如 openai/gpt-5.6-terra。"
        initial={settings.modelAllowlist.models}
        onClose={() => setModelsOpen(false)}
        onSave={(models) =>
          onSetting("modelAllowlist", { ...settings.modelAllowlist, models })
        }
        open={modelsOpen}
        title="允许的模型"
      />
    </>
  );
}

function ModelUsage() {
  const usage = useQuery(modelUsageQueryOptions(30));
  if (usage.isPending) return null;
  if (usage.error)
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        读不到模型用量。
      </p>
    );
  if (usage.data.summary.length === 0)
    return <PageEmpty>最近 30 天没有记录到员工运行。</PageEmpty>;
  return (
    <PageRows>
      {usage.data.summary.map((row, index) => (
        <div key={`${row.model}-${row.source}`}>
          {index > 0 ? <Separator /> : null}
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconChartBar />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{row.model}</ItemTitle>
              <ItemDescription>
                30 天内 {row.people} 人运行了 {row.runs} 次
                {row.refused > 0 ? ` · ${row.refused} 次不在白名单内` : ""} ·{" "}
                {MODEL_SOURCES[row.source] ?? row.source}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {new Date(row.lastUsedAt).toLocaleDateString("zh-CN")}
              </span>
            </ItemActions>
          </Item>
        </div>
      ))}
    </PageRows>
  );
}

/** Where a model name came from, in words; an unlisted value is shown as the server wrote it. */
const MODEL_SOURCES: Record<string, string> = {
  configured: "部署配置",
  observed: "运行中报出",
  unknown: "来源未知",
};

/** A recorded command's outcome, in words; an unlisted value is shown as the server wrote it. */
const ACTION_OUTCOMES: Record<string, string> = {
  allowed: "已放行",
  refused: "已拦截",
  denied: "已拦截",
  failed: "执行失败",
};

function RecordedActions() {
  const actions = useQuery(actionRecordsQueryOptions());
  if (actions.isPending) return null;
  if (actions.error)
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        读不到录制的操作。
      </p>
    );
  if (actions.data.length === 0)
    return <PageEmpty>还没有录制到命令。</PageEmpty>;
  return (
    <PageRows>
      {actions.data.map((action, index) => (
        <div key={action.id}>
          {index > 0 ? <Separator /> : null}
          <Item size="sm">
            <ItemContent>
              <ItemTitle className="font-mono text-xs">
                {action.command}
              </ItemTitle>
              <ItemDescription>
                {action.surface === "local"
                  ? "成员自己的电脑"
                  : `员工 ${action.botId ?? "?"}`}{" "}
                · {ACTION_OUTCOMES[action.outcome] ?? action.outcome} ·{" "}
                {new Date(action.createdAt).toLocaleString("zh-CN")}
              </ItemDescription>
            </ItemContent>
          </Item>
        </div>
      ))}
    </PageRows>
  );
}

type Tri = "inherit" | "on" | "off";

function OverridesDialog({
  data,
  open,
  onOpenChange,
}: {
  data: EnterpriseOverview;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setCapability = useMutation(setCapabilityMutationOptions(queryClient));
  const scopes: { kind: "role" | "group"; id: string; label: string }[] = [
    { kind: "role", id: "admin", label: "管理员" },
    { kind: "role", id: "user", label: "成员" },
    ...data.groups.map((group) => ({
      kind: "group" as const,
      id: group,
      label: `分组：${group}`,
    })),
  ];
  const [scopeIndex, setScopeIndex] = useState(0);
  const scope = scopes[scopeIndex] ?? scopes[0];

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>按角色和分组覆盖</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-4 overflow-y-auto">
          <Select
            onValueChange={(value) => setScopeIndex(Number(value))}
            value={String(scopeIndex)}
          >
            <SelectTrigger aria-label="范围">
              <SelectValue>{scope?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {scopes.map((candidate, index) => (
                  <SelectItem
                    key={`${candidate.kind}:${candidate.id}`}
                    value={String(index)}
                  >
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            {scope?.kind === "group"
              ? "分组只能放宽：“授予”会让分组成员获得这项能力，即使组织层面关掉了。"
              : "角色的设置会替换组织开关，对拥有该角色的所有人生效。"}
          </p>
          {scope
            ? data.capabilities.map((capability) => {
                const stored =
                  scope.kind === "role"
                    ? capability.roles[scope.id as "admin" | "user"]
                    : capability.groups[scope.id];
                const value: Tri =
                  stored === undefined ? "inherit" : stored ? "on" : "off";
                return (
                  <div
                    className="flex items-center justify-between gap-4"
                    key={capability.capability}
                  >
                    <Label>{capability.title}</Label>
                    <Select
                      onValueChange={(next) =>
                        setCapability.mutate({
                          scopeKind: scope.kind,
                          scopeId: scope.id,
                          capability: capability.capability,
                          allowed: next === "inherit" ? null : next === "on",
                        })
                      }
                      value={value}
                    >
                      <SelectTrigger
                        aria-label={`${scope.label}的${capability.title}`}
                        className="w-36"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="inherit">继承</SelectItem>
                          <SelectItem value="on">
                            {scope.kind === "group" ? "授予" : "开"}
                          </SelectItem>
                          {scope.kind === "role" ? (
                            <SelectItem value="off">关</SelectItem>
                          ) : null}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                );
              })
            : null}
          {setCapability.error ? (
            <p className="text-destructive text-sm" role="alert">
              {setCapability.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} size="sm" type="button">
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ListDialog({
  open,
  title,
  description,
  initial,
  onSave,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  initial: string[];
  onSave: (values: string[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial.join("\n"));
  return (
    <Dialog
      onOpenChange={(next) => (next ? setText(initial.join("\n")) : onClose())}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-2 overflow-y-auto">
          <Textarea
            className="font-mono text-xs"
            onChange={(event) => setText(event.target.value)}
            rows={8}
            value={text}
          />
          <p className="text-muted-foreground text-xs">{description}</p>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            取消
          </Button>
          <Button
            onClick={() => {
              onSave(
                text
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              );
              onClose();
            }}
            size="sm"
            type="button"
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
