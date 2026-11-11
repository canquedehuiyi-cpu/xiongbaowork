import { createFileRoute } from "@tanstack/react-router";

/** M5b 第 0 步占位：能力 › 知识库。D 组在这里接熊宝现有的页签内容。 */
export const Route = createFileRoute("/_authed/_app/capabilities/knowledge")({
  // 搜索框里的字。路由会把纯数字解析成数字，所以数字也收成文字。
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = typeof search.q === "number" ? String(search.q) : search.q;
    return typeof q === "string" && q ? { q } : {};
  },
  component: CapabilityPlaceholder,
});

function CapabilityPlaceholder() {
  return <h1 className="px-6 py-4 font-semibold text-lg">知识库</h1>;
}
