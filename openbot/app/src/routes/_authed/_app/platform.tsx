import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import {
  TOKEN_SCOPE_CAPTION,
  type TokenUsage,
  tokenReadout,
} from "@/lib/quota/queries";

export const Route = createFileRoute("/_authed/_app/platform")({
  component: PlatformPage,
});

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

function PlatformPage() {
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
  return (
    <PageShell
      title="平台"
      description="这个部署服务的所有租户，以及对单个租户的两个操作。"
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left opacity-70">
            <th className="py-2">租户</th>
            <th>套餐</th>
            <th>员工数</th>
            <th>定时任务</th>
            <th>状态</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(tenants.data ?? []).map((tenant) => (
            <tr key={tenant.id} className="border-t">
              <td className="py-2">
                <div>{tenant.name ?? tenant.email}</div>
                <div className="text-xs opacity-60">{tenant.email}</div>
              </td>
              <td>{tenant.plan}</td>
              <td>{tenant.wakers}</td>
              <td>{tenant.activeRoutines}</td>
              <td>{tenant.suspended ? "suspended" : "active"}</td>
              <td className="text-right">
                <button
                  className="underline opacity-80"
                  type="button"
                  onClick={() =>
                    act.mutate({
                      id: tenant.id,
                      verb: tenant.suspended ? "restore" : "suspend",
                    })
                  }
                >
                  {tenant.suspended ? "恢复" : "暂停"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
        description={TOKEN_SCOPE_CAPTION}
        title={
          page ? `按租户的 Token 用量（${page.period}）` : "按租户的 Token 用量"
        }
      >
        {usage.isPending ? (
          <p className="mt-3 text-muted-foreground text-sm">正在加载用量…</p>
        ) : usage.error ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {usage.error.message}
          </p>
        ) : (
          <>
            <table
              aria-label="按租户的 Token 用量"
              className="mt-3 w-full text-sm"
            >
              <thead>
                <tr className="text-left opacity-70">
                  <th className="py-2">租户</th>
                  <th>调用次数</th>
                  <th>Token 用量</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(page?.tenants ?? []).map((row) => (
                  <tr className="border-t" key={row.tenantId}>
                    <td className="py-2">
                      <div>{row.name ?? row.email}</div>
                      <div className="text-xs opacity-60">{row.email}</div>
                    </td>
                    <td>{row.usage.calls}</td>
                    <td>{tokenReadout(row.usage)}</td>
                    <td className="text-right">
                      <button
                        aria-pressed={selected?.tenantId === row.tenantId}
                        className="underline opacity-80"
                        onClick={() => setSelected(row)}
                        type="button"
                      >
                        查看审计
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 flex gap-3 text-sm">
              {offset > 0 ? (
                <button
                  className="underline"
                  onClick={() => setOffset(Math.max(0, offset - USAGE_PAGE))}
                  type="button"
                >
                  上一页
                </button>
              ) : null}
              {page?.nextOffset != null ? (
                <button
                  className="underline"
                  onClick={() => setOffset(page.nextOffset ?? 0)}
                  type="button"
                >
                  下一页
                </button>
              ) : null}
            </div>
          </>
        )}
      </PageSection>
      {selected ? (
        <PageSection
          description="最近 20 条，最新在前。"
          title={`${selected.name ?? selected.email} 的审计记录`}
        >
          {audit.isPending ? (
            <p className="mt-3 text-muted-foreground text-sm">
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
              className="mt-3 flex flex-col gap-1 text-sm"
            >
              {(audit.data?.events ?? []).map((event) => (
                <li className="border-t py-1" key={event.id}>
                  <span className="opacity-60">
                    {new Date(event.createdAt).toLocaleString("zh-CN")}
                  </span>{" "}
                  <span className="font-medium">{event.eventType}</span>{" "}
                  <span className="opacity-80">
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
