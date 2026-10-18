import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";

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
    </PageShell>
  );
}
