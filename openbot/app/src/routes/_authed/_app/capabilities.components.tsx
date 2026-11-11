import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { ComponentsTab } from "@/components/resources/source-tabs";

/** 能力 › 组件：员工可以直接给出的界面。发布与授予在管理员的组件页里做。 */
export const Route = createFileRoute("/_authed/_app/capabilities/components")({
  // 搜索框里的字。路由会把纯数字解析成数字，所以数字也收成文字。
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = typeof search.q === "number" ? String(search.q) : search.q;
    return typeof q === "string" && q ? { q } : {};
  },
  component: ComponentsPage,
});

function ComponentsPage() {
  const navigate = Route.useNavigate();
  const [query, setQuery] = useState(Route.useSearch().q ?? "");
  return (
    <CapabilitiesShell>
      <ComponentsTab
        onQuery={(value) => {
          setQuery(value);
          navigate({ search: value ? { q: value } : {}, replace: true });
        }}
        query={query}
      />
    </CapabilitiesShell>
  );
}
