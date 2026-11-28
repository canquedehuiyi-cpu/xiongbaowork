import { IconChevronRight, IconNetwork, IconWorld } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageRows } from "@/components/layout/page-shell";
import { SettingsSection } from "@/components/settings/settings-section";
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
  removeNetworkPolicyMutationOptions,
  setNetworkPolicyMutationOptions,
} from "@/lib/enterprise/mutations";
import {
  type EgressRule,
  type EnterpriseOverview,
  enterpriseOverviewQueryOptions,
  type NetworkMode,
  type NetworkPolicy,
} from "@/lib/enterprise/queries";

const MODE_NAMES: Record<NetworkMode, string> = {
  allow_all: "允许所有网络访问",
  defaults_plus_allowlist: "默认目的地加团队白名单",
  allowlist_only: "只允许团队白名单",
};

/** One rule per line: `example.com`, `*.corp.example`, or `10.0.0.0/8 443,8443`. */
function rulesFromText(text: string): EgressRule[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value = "", ports] = line.split(/\s+/, 2);
      return /^[\d.:a-fA-F]+(\/\d+)?$/.test(value) &&
        /[\d]/.test(value) &&
        /[.:]/.test(value)
        ? { type: "cidr" as const, value, ...(ports ? { ports } : {}) }
        : { type: "domain" as const, value };
    });
}

function rulesToText(rules: EgressRule[]): string {
  return rules
    .map((rule) =>
      rule.type === "domain"
        ? rule.value
        : `${rule.value}${rule.ports ? ` ${rule.ports}` : ""}`,
    )
    .join("\n");
}

function summarizePolicy(policy: NetworkPolicy | undefined): string {
  if (!policy) return "没有策略：员工的电脑可以访问集群允许的任何地方";
  const count = policy.rules.length;
  return `${MODE_NAMES[policy.mode]} · ${count} 条规则${policy.locked ? " · 已锁定" : ""}`;
}

type Scope = { scopeKind: "organization" | "group"; scopeId: string };

/**
 * 电脑与设备里团队版管理员的「网络」一节（`#network`，O07、O08）：组织一行、每个分组一行，点开是同一个对话框
 * （分组、模式、白名单）。原来在企业管控页。
 */
export function NetworkSection() {
  return (
    <SettingsSection
      audience={{ who: "team-admin", edition: "team" }}
      description="员工的电脑可以连到哪里。几秒内应用到正在运行的电脑上，无需重启。分组策略会替换组织策略，除非组织策略已锁定。"
      id="network"
      title="网络"
    >
      <NetworkRows />
    </SettingsSection>
  );
}

function NetworkRows() {
  const overview = useQuery(enterpriseOverviewQueryOptions());
  const [scope, setScope] = useState<Scope | undefined>();
  if (overview.isPending) return null;
  if (overview.error) {
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        读不到网络策略。请刷新页面。
      </p>
    );
  }
  const data = overview.data;
  const organizationPolicy = data.network.find(
    (row) => row.scopeKind === "organization",
  );
  const groupPolicies = data.network.filter((row) => row.scopeKind === "group");

  return (
    <>
      <PageRows>
        <Item
          render={
            <button
              data-setting-key="network.policy.organization"
              onClick={() =>
                setScope({ scopeKind: "organization", scopeId: "" })
              }
              type="button"
            />
          }
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconWorld />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>组织</ItemTitle>
            <ItemDescription>
              {summarizePolicy(organizationPolicy)}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
        {groupPolicies.map((policy) => (
          <div key={policy.scopeId}>
            <Separator />
            <Item
              render={
                <button
                  onClick={() =>
                    setScope({ scopeKind: "group", scopeId: policy.scopeId })
                  }
                  type="button"
                />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconNetwork />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>分组：{policy.scopeId}</ItemTitle>
                <ItemDescription>{summarizePolicy(policy)}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </div>
        ))}
      </PageRows>
      {data.groups.length > 0 ? (
        <Button
          className="mt-4"
          onClick={() => setScope({ scopeKind: "group", scopeId: "" })}
          size="sm"
          variant="outline"
        >
          添加分组策略
        </Button>
      ) : null}
      {scope ? (
        <NetworkDialog
          data={data}
          initial={scope}
          onClose={() => setScope(undefined)}
        />
      ) : null}
    </>
  );
}

function NetworkDialog({
  data,
  initial,
  onClose,
}: {
  data: EnterpriseOverview;
  initial: Scope;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const existing = data.network.find(
    (row) =>
      row.scopeKind === initial.scopeKind && row.scopeId === initial.scopeId,
  );
  const [group, setGroup] = useState(initial.scopeId || data.groups[0] || "");
  const [mode, setMode] = useState<NetworkMode>(
    existing?.mode ?? "defaults_plus_allowlist",
  );
  const [rules, setRules] = useState(rulesToText(existing?.rules ?? []));
  const [locked, setLocked] = useState(existing?.locked ?? false);
  const save = useMutation(setNetworkPolicyMutationOptions(queryClient));
  const remove = useMutation(removeNetworkPolicyMutationOptions(queryClient));
  const scopeId = initial.scopeKind === "group" ? group : "";

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {initial.scopeKind === "organization"
              ? "组织网络策略"
              : "分组网络策略"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(
              {
                scopeKind: initial.scopeKind,
                scopeId,
                mode,
                rules: rulesFromText(rules),
                locked,
              },
              { onSuccess: onClose },
            );
          }}
        >
          <DialogBody className="mt-4 space-y-4 overflow-y-auto">
            {initial.scopeKind === "group" && !initial.scopeId ? (
              <div className="space-y-1.5">
                <Label>分组</Label>
                <Select
                  onValueChange={(value) => setGroup(String(value))}
                  value={group}
                >
                  <SelectTrigger aria-label="分组">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {data.groups.map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label>模式</Label>
              <Select
                onValueChange={(value) => setMode(value as NetworkMode)}
                value={mode}
              >
                <SelectTrigger aria-label="模式">
                  <SelectValue>{MODE_NAMES[mode]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(Object.keys(MODE_NAMES) as NetworkMode[]).map(
                      (candidate) => (
                        <SelectItem key={candidate} value={candidate}>
                          {MODE_NAMES[candidate]}
                        </SelectItem>
                      ),
                    )}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="network-rules">白名单</Label>
              <Textarea
                className="font-mono text-xs"
                id="network-rules"
                onChange={(event) => setRules(event.target.value)}
                placeholder={"example.com\n*.corp.example\n10.0.0.0/8 443,5432"}
                rows={8}
                value={rules}
              />
              <p className="text-muted-foreground text-xs">
                每行一条。域名会覆盖它的子域名；*.name 只覆盖子域名。IP
                段可以带端口。默认目的地有{" "}
                {data.defaultDestinations.slice(0, 4).join("、")} 等，另有{" "}
                {data.defaultDestinations.length - 4} 个软件包和源码站点。
              </p>
            </div>
            {initial.scopeKind === "organization" ? (
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="network-locked">
                  锁定：分组不能替换这条策略
                </Label>
                <Switch
                  checked={locked}
                  id="network-locked"
                  onCheckedChange={setLocked}
                />
              </div>
            ) : null}
            {(save.error ?? remove.error) ? (
              <p className="text-destructive text-sm" role="alert">
                {(save.error ?? remove.error)?.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            {existing ? (
              <Button
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(
                    { scopeKind: initial.scopeKind, scopeId },
                    { onSuccess: onClose },
                  )
                }
                size="sm"
                type="button"
                variant="destructive"
              >
                移除策略
              </Button>
            ) : null}
            <Button onClick={onClose} size="sm" type="button" variant="outline">
              取消
            </Button>
            <Button
              disabled={
                save.isPending || (initial.scopeKind === "group" && !scopeId)
              }
              size="sm"
              type="submit"
            >
              {save.isPending ? "正在保存…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
