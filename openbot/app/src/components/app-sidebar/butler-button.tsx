import { Link, useRouterState } from "@tanstack/react-router";
import { BrandLogo } from "@/components/layout/brand-logo";

/** The five workbench pages the reference floats its helper over. */
const WORKBENCH_PATHS = new Set([
  "/tasks",
  "/reachability",
  "/autonomous",
  "/wakers",
  "/resources",
]);

/**
 * 小管家: a round button with our logo's 熊宝 waving from it, floating at the bottom centre of the main area on the
 * five workbench pages, where the reference floats its own helper. It opens this product's default
 * assistant at /bot — what the sidebar footer's 小管家 row used to link to.
 *
 * Positioned against `main` (which is `relative` and never scrolls itself), so it stays put while
 * the page beneath scrolls.
 */
export function ButlerButton() {
  const shown = useRouterState({
    select: (state) => WORKBENCH_PATHS.has(state.location.pathname),
  });
  if (!shown) return null;
  return (
    <Link
      aria-label="小管家"
      className="absolute bottom-[24px] left-1/2 z-20 flex size-[48px] -translate-x-1/2 items-center justify-center overflow-hidden rounded-full bg-card shadow-lg ring-1 ring-brand-gold/60 outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring/60"
      title="小管家"
      to="/bot"
    >
      <BrandLogo alt="熊宝" className="size-full scale-[1.12]" size={48} />
    </Link>
  );
}
