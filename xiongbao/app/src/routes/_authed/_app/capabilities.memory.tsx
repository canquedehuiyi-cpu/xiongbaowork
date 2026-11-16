import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { MemoryScreen } from "@/components/memory/memory-screen";
import { deploymentOffersMemory } from "@/lib/deployment/queries";

/**
 * 能力 › 记忆与信息源：同步过来的信息源、员工记住的内容（含「让它记住一条事实」，即上游的 RememberFact）、
 * 后台调研的建议与设置。`/memory`、`/settings/memory` 与 `/resources?tab=sources` 都转到这里。
 */
export const Route = createFileRoute("/_authed/_app/capabilities/memory")({
  // 个人版没有记忆（见 `offersMemory`），所以去员工页。转到这里的旧地址也落在那里。
  beforeLoad: async ({ context }) => {
    if (!(await deploymentOffersMemory(context.queryClient))) {
      throw redirect({ to: "/bots", replace: true });
    }
  },
  // 搜索框里的字。路由会把纯数字解析成数字，所以数字也收成文字。
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = typeof search.q === "number" ? String(search.q) : search.q;
    return typeof q === "string" && q ? { q } : {};
  },
  component: MemoryPage,
});

function MemoryPage() {
  const navigate = Route.useNavigate();
  const [query, setQuery] = useState(Route.useSearch().q ?? "");
  return (
    <CapabilitiesShell>
      <MemoryScreen
        onQuery={(value) => {
          setQuery(value);
          navigate({ search: value ? { q: value } : {}, replace: true });
        }}
        query={query}
      />
    </CapabilitiesShell>
  );
}
