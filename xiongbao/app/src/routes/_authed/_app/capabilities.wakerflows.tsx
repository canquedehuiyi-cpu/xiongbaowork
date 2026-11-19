import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { WakerFlowsTab } from "@/components/resources/source-tabs";

/**
 * 能力 › WakerFlow：工作区的 WakerFlow 卡片，以及去独立的 `/wakerflows` 页（在那里写、改、运行）的入口。
 * `/wakerflows/*` 的详情页保留原地址，看板卡片和分享链接都指向它们。
 */
export const Route = createFileRoute("/_authed/_app/capabilities/wakerflows")({
  // 搜索框里的字。路由会把纯数字解析成数字，所以数字也收成文字。
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = typeof search.q === "number" ? String(search.q) : search.q;
    return typeof q === "string" && q ? { q } : {};
  },
  component: WakerFlowsPage,
});

function WakerFlowsPage() {
  const navigate = Route.useNavigate();
  const [query, setQuery] = useState(Route.useSearch().q ?? "");
  return (
    <CapabilitiesShell>
      <WakerFlowsTab
        onQuery={(value) => {
          setQuery(value);
          navigate({ search: value ? { q: value } : {}, replace: true });
        }}
        query={query}
      />
    </CapabilitiesShell>
  );
}
