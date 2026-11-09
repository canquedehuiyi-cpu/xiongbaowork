import { Link, useRouterState } from "@tanstack/react-router";
import { BrandLogo } from "@/components/layout/brand-logo";

/** The five workbench pages, where the bar carries the helper. */
const WORKBENCH_PATHS = new Set([
  "/tasks",
  "/reachability",
  "/autonomous",
  "/wakers",
  "/resources",
]);

/**
 * 熊宝小管家: the dock at the right of a workbench page's breadcrumb bar (docs/design/ios-studio
 * `.dock`) — the logo and the helper's name on a small graphite plate. It opens this product's default
 * assistant at /bot, as the floating button it replaces did.
 */
export function ButlerButton() {
  const shown = useRouterState({
    select: (state) => WORKBENCH_PATHS.has(state.location.pathname),
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
