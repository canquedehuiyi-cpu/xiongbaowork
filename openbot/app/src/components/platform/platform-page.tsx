/*
 * M5b 第 0 步：从 `routes/_authed/_app/platform.tsx` 剪出的页面主体，原样保留，地址改成重定向（/platform → /admin/platform）。
 * 各组在新路由里接这个组件，再按新结构调整其中的链接与文案。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StatusBadge, TablePanel } from "@/components/admin/admin-kit";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  TOKEN_SCOPE_CAPTION,
  type TokenUsage,
  tokenReadout,
} from "@/lib/quota/queries";


type TenantRow = {
  id: string;
  email: string;
  name: string | null;
  plan: string;
  wakers: number;
  activeRoutines: number;
  suspended: boolean;
  createdAt: string;
};

async function loadTenants(): Promise<TenantRow[]> {
  const response = await fetch("/api/platform/tenants", {
    credentials: "include",
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { tenants?: TenantRow[] };
  return body.tenants ?? [];
}

/** A tenant's name over its address, the way both tables on this page name one. */
function TenantName({ name, email }: { name: string | null; email: string }) {
  return (
    <>
      <div className="font-medium">{name ?? email}</div>
      <div className="text-[12px] text-muted-foreground">{email}</div>
    </>
  );
}

export function PlatformPage() {
  const queryClient = useQueryClient();
  const tenants = useQuery({
    queryKey: ["platform", "tenants"],
    queryFn: loadTenants,
  });
  const act = useMutation({
    mutationFn: async (input: { id: string; verb: "suspend" | "restore" }) => {
      await fetch(`/api/platform/tenants/${input.id}/${input.verb}`, {
        method: "POST",
        credentials: "include",
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["platform", "tenants"] });
    },
  });
  /*
   * Suspending stops a whole workspace, so it is asked twice: the row's button opens this, and only
   * the dialog's own button sends it. Restoring gives something back and goes straight through.
   */
  const [suspending, setSuspending] = useState<TenantRow | null>(null);
  const rows = tenants.data ?? [];

  return (
    <PageShell
      description="这个部署服务的所有租户，以及对单个租户的两个操作。"
      title="平台"
      width="workbench"
    >
      <PageSection className="mt-6" title="租户">
        {tenants.isPending ? (
          <p className="mt-2 text-muted-foreground text-sm" role="status">
            正在读取租户…
          </p>
        ) : rows.length === 0 ? (
          <p className="mt-2 text-muted-foreground text-sm">
            没有可以显示的租户。
          </p>
        ) : (
          <TablePanel>
            <table aria-label="租户">
              <thead>
                <tr>
                  <th>租户</th>
                  <th>套餐</th>
                  <th className="text-right">员工数</th>
                  <th className="text-right">定时任务</th>
                  <th>状态</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((tenant) => (
                  <tr key={tenant.id}>
                    <td className="min-w-[200px]">
                      <TenantName email={tenant.email} name={tenant.name} />
                    </td>
                    <td className="whitespace-nowrap">{tenant.plan}</td>
                    <td className="text-right tabular-nums">{tenant.wakers}</td>
                    <td className="text-right tabular-nums">
                      {tenant.activeRoutines}
                    </td>
                    <td>
                      <StatusBadge
                        tone={tenant.suspended ? "attention" : "positive"}
                      >
                        {tenant.suspended ? "已暂停" : "正常"}
                      </StatusBadge>
                    </td>
                    <td className="text-right">
                      <Button
                        disabled={act.isPending}
                        onClick={() =>
                          tenant.suspended
                            ? act.mutate({ id: tenant.id, verb: "restore" })
                            : setSuspending(tenant)
                        }
                        size="sm"
                        variant={tenant.suspended ? "outline" : "destructive"}
                      >
                        {tenant.suspended ? "恢复" : "暂停"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TablePanel>
        )}
      </PageSection>

      <Dialog
        onOpenChange={(open) => (open ? null : setSuspending(null))}
        open={suspending !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>暂停这个租户？</DialogTitle>
            <DialogDescription>
              {suspending
                ? `${suspending.name ?? suspending.email} 的成员和员工会立刻停下来，直到你在这里恢复它。`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setSuspending(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              取消
            </Button>
            <Button
              disabled={act.isPending}
              onClick={() => {
                if (suspending)
                  act.mutate({ id: suspending.id, verb: "suspend" });
                setSuspending(null);
              }}
              size="sm"
              type="button"
              variant="destructive"
            >
              暂停租户
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TenantUsageAndAudit />
    </PageShell>
  );
}

type TenantUsageRow = {
  tenantId: string;
  email: string;
  name: string | null;
  usage: TokenUsage;
};

type TenantUsagePage = {
  period: string;
  tenants: TenantUsageRow[];
  nextOffset: number | null;
};

type AuditEventRow = {
  id: string;
  eventType: string;
  targetType: string;
  targetId: string | null;
  initiatorKind: string;
  createdAt: string;
};

/** Tenants per page of the usage table. */
const USAGE_PAGE = 50;

/** The server's own sentence when it refused, so a 403 or 503 is not drawn as an empty list. */
async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include" });
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok || body === null)
    throw new Error(body?.error ?? `请求失败（HTTP ${response.status}）`);
  return body;
}

/**
 * Spec J5: every tenant's model tokens this month (the same count each tenant's own plan panel
 * shows, K2) and one tenant's audit trail. Both read across tenants, so the server answers only an
 * administrator holding the admin capability.
 */
export function TenantUsageAndAudit() {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<TenantUsageRow | null>(null);
  const usage = useQuery({
    queryKey: ["platform", "usage", offset],
    queryFn: () =>
      readJson<TenantUsagePage>(
        `/api/platform/usage?limit=${USAGE_PAGE}&offset=${offset}`,
      ),
  });
  const audit = useQuery({
    queryKey: ["platform", "audit", selected?.tenantId],
    queryFn: () =>
      readJson<{ events: AuditEventRow[] }>(
        `/api/platform/tenants/${encodeURIComponent(selected?.tenantId ?? "")}/audit?limit=20`,
      ),
    enabled: selected !== null,
  });
  const page = usage.data;
  return (
    <>
      <PageSection
        className="mt-10"
        description={TOKEN_SCOPE_CAPTION}
        title={
          page ? `按租户的 Token 用量（${page.period}）` : "按租户的 Token 用量"
        }
      >
        {usage.isPending ? (
          <p className="mt-3 text-muted-foreground text-sm" role="status">
            正在加载用量…
          </p>
        ) : usage.error ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {usage.error.message}
          </p>
        ) : (page?.tenants ?? []).length === 0 && offset === 0 ? (
          <p className="mt-3 text-muted-foreground text-sm">
            这个月还没有租户的用量。
          </p>
        ) : (
          <>
            <TablePanel>
              <table aria-label="按租户的 Token 用量">
                <thead>
                  <tr>
                    <th>租户</th>
                    <th className="text-right">调用次数</th>
                    <th>Token 用量</th>
                    <th>
                      <span className="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(page?.tenants ?? []).map((row) => (
                    <tr
                      className={
                        selected?.tenantId === row.tenantId
                          ? "bg-muted/40"
                          : undefined
                      }
                      key={row.tenantId}
                    >
                      <td className="min-w-[200px]">
                        <TenantName email={row.email} name={row.name} />
                      </td>
                      <td className="text-right tabular-nums">
                        {row.usage.calls}
                      </td>
                      <td className="min-w-[180px]">
                        {tokenReadout(row.usage)}
                      </td>
                      <td className="text-right">
                        <Button
                          aria-pressed={selected?.tenantId === row.tenantId}
                          onClick={() => setSelected(row)}
                          size="sm"
                          type="button"
                          variant={
                            selected?.tenantId === row.tenantId
                              ? "default"
                              : "outline"
                          }
                        >
                          查看审计
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TablePanel>
            {offset > 0 || page?.nextOffset != null ? (
              <div className="mt-3 flex gap-2">
                {offset > 0 ? (
                  <Button
                    onClick={() => setOffset(Math.max(0, offset - USAGE_PAGE))}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    上一页
                  </Button>
                ) : null}
                {page?.nextOffset != null ? (
                  <Button
                    onClick={() => setOffset(page.nextOffset ?? 0)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    下一页
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </PageSection>
      {selected ? (
        <PageSection
          className="mt-10"
          description="最近 20 条，最新在前。"
          title={`${selected.name ?? selected.email} 的审计记录`}
        >
          {audit.isPending ? (
            <p className="mt-3 text-muted-foreground text-sm" role="status">
              正在加载审计记录…
            </p>
          ) : audit.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {audit.error.message}
            </p>
          ) : (audit.data?.events ?? []).length === 0 ? (
            <p className="mt-3 text-muted-foreground text-sm">
              这个租户还没有审计记录。
            </p>
          ) : (
            <ul
              aria-label="审计记录"
              className="mt-4 divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-card text-[13px] shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]"
            >
              {(audit.data?.events ?? []).map((event) => (
                <li
                  className="grid grid-cols-1 gap-x-4 gap-y-1 px-4 py-[10px] sm:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)]"
                  key={event.id}
                >
                  <span className="font-mono text-[12px] text-muted-foreground tabular-nums">
                    {new Date(event.createdAt).toLocaleString("zh-CN")}
                  </span>
                  <span className="break-all font-medium">
                    {event.eventType}
                  </span>
                  <span className="break-all text-muted-foreground">
                    {event.targetType}
                    {event.targetId ? ` · ${event.targetId}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </PageSection>
      ) : null}
    </>
  );
}
