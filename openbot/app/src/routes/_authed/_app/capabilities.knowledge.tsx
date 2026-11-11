import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { KnowledgeScreen } from "@/components/knowledge/knowledge-screen";

/** 能力 › 知识库：整个知识库页（`/knowledge` 与 `/resources?tab=knowledge` 重定向到这里）。 */
export const Route = createFileRoute("/_authed/_app/capabilities/knowledge")({
  // 搜索框里的字。路由会把纯数字解析成数字，所以数字也收成文字。
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = typeof search.q === "number" ? String(search.q) : search.q;
    return typeof q === "string" && q ? { q } : {};
  },
  component: KnowledgePage,
});

function KnowledgePage() {
  const navigate = Route.useNavigate();
  const [query, setQuery] = useState(Route.useSearch().q ?? "");
  return (
    <CapabilitiesShell>
      <KnowledgeScreen
        onQuery={(value) => {
          setQuery(value);
          // Typing replaces history, so every keystroke is not a step for Back.
          navigate({ search: value ? { q: value } : {}, replace: true });
        }}
        query={query}
      />
    </CapabilitiesShell>
  );
}
