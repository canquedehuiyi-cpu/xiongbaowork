import { Link, useRouterState } from "@tanstack/react-router";
import { BrandLogo } from "@/components/layout/brand-logo";

/**
 * 小管家出现的工作台页面：v0.2.7 的五个工作台页（任务看板、@Waker、自主工作，以及员工管理和能力与资源——
 * 这两页现在叫员工、能力）再加能力的每个页签（`/capabilities/<页签>`）。@Waker 曾在 #452 里掉了，按用户要求加回。
 */
const WORKBENCH_PATHS = new Set([
  "/tasks",
  "/reachability",
  "/autonomous",
  "/bots",
]);
const WORKBENCH_PREFIXES = ["/capabilities"];

export function showsButler(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return (
    WORKBENCH_PATHS.has(path) ||
    WORKBENCH_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  );
}

/**
 * 熊宝小管家: the dock at the right of a workbench page's breadcrumb bar (docs/design/ios-studio
 * `.dock`) — the logo and the helper's name on a small graphite plate. It opens this product's default
 * assistant at /bot, as the floating button it replaces did.
 */
export function ButlerButton() {
  const shown = useRouterState({
    select: (state) => showsButler(state.location.pathname),
  });
  if (!shown) return null;
  return (
    <Link
      aria-label="小管家"
      className="flex shrink-0 items-center gap-[7px] rounded-[10px] border border-border bg-popover py-[4px] pr-[8px] pl-[4px] text-[11px] text-foreground/90 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
      title="熊宝小管家"
      to="/bot"
    >
      <BrandLogo alt="熊宝" className="rounded-[6px]" size={23} />
      <span className="hidden sm:inline">熊宝小管家</span>
    </Link>
  );
}
