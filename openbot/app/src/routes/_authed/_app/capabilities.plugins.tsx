import { createFileRoute } from "@tanstack/react-router";

/** M5b 第 0 步占位：能力 › 插件。D 组在这里接熊宝现有的页签内容。 */
export const Route = createFileRoute("/_authed/_app/capabilities/plugins")({
  // 插件页签自己的参数（`/resources` 的 `view,category,page,q`），由 `/resources` 的重定向照带过来。
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    view?: "market" | "mine";
    category?: string;
    page?: number;
    q?: string;
  } => {
    const page = Number(search.page);
    return {
      ...(search.view === "market" || search.view === "mine"
        ? { view: search.view }
        : {}),
      ...(typeof search.category === "string" && search.category
        ? { category: search.category }
        : {}),
      ...(Number.isInteger(page) && page > 1 ? { page } : {}),
      ...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
    };
  },
  component: CapabilityPlaceholder,
});

function CapabilityPlaceholder() {
  return <h1 className="px-6 py-4 font-semibold text-lg">插件</h1>;
}
