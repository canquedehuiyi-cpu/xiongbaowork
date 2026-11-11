import { IconArrowLeft, IconArrowRight } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { QueryError } from "@/components/layout/query-error";
import { SearchBox } from "@/components/layout/search-box";
import { WorkbenchEmpty } from "@/components/layout/workbench-empty";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The pieces every tab of 能力与资源 is built from, so nine tabs share one header, one grid, one
 * set of states and one pager instead of each drawing its own.
 *
 * Drawn to docs/design/ios-studio (05-能力与资源.png, theme.css): graphite cards with a hairline and a
 * faint top highlight at a 13px radius, 33px icon plates, round badges, and red only where something
 * is selected or needs attention. Sizes are the reference's CSS px scaled by this app's 15px root
 * against its 14px one, rounded (11 → 12, 10 → 11).
 */

/** A card's matte face: hairline, graphite, and the faint highlight along its top edge. */
export const CARD_FACE =
  "rounded-[13px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]";

/**
 * The reference's `.symbol`: a 33px plate an icon or logo sits on. `active` turns the glyph red, as
 * the selected resource entry draws it; the plate itself never changes, so nothing reads by colour
 * alone.
 */
export function ResourceSymbol({
  children,
  active = false,
  className,
}: {
  children: ReactNode;
  active?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-[33px] shrink-0 items-center justify-center rounded-[9px] border border-foreground/10 bg-muted shadow-[inset_0_1px_0_rgb(255_255_255/0.05)] dark:bg-[linear-gradient(145deg,oklch(0.27_0.002_286.2),oklch(0.225_0.002_286.2))] [&_svg]:size-[18px]",
        active ? "text-signal-ink" : "text-foreground/85",
        className,
      )}
      data-slot="resource-symbol"
    >
      {children}
    </span>
  );
}

/** A section's first line (`.section-head`): a 17px title on the left, its aside on the right. */
export function SectionHead({
  title,
  id,
  aside,
  className,
}: {
  title: ReactNode;
  id?: string;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-[9px] flex min-h-[26px] flex-wrap items-center justify-between gap-[10px]",
        className,
      )}
    >
      <h2
        className="font-bold text-[17px] leading-[26px] tracking-[-0.02em]"
        id={id}
      >
        {title}
      </h2>
      {aside}
    </div>
  );
}

/** A tab's first row: what it is, its own actions, and its search. */
export function TabHeader({
  description,
  actions,
  search,
}: {
  description: ReactNode;
  actions?: ReactNode;
  search?: ReactNode;
}) {
  return (
    <div className="mt-[22px] flex flex-col gap-[10px] md:flex-row md:items-center md:justify-between">
      <p className="max-w-prose text-pretty text-[13px] text-muted-foreground leading-[1.6]">
        {description}
      </p>
      <div className="flex shrink-0 flex-wrap items-center gap-[7px]">
        {search}
        {actions}
      </div>
    </div>
  );
}

/** A search box in the toolbar: the workbench's 32px box, magnifier on the left. */
export function TabSearch({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <SearchBox
      className={cn("w-full sm:w-[221px]", className)}
      label={label}
      onValueChange={onChange}
      placeholder={label}
      value={value}
    />
  );
}

/** The grid cards sit in: one column on a phone, two, then the reference's three. */
export function CardGrid({
  children,
  label,
  className,
}: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <ul
      aria-label={label}
      className={cn(
        "grid grid-cols-1 gap-[9px] min-[441px]:grid-cols-2 xl:grid-cols-3",
        className,
      )}
    >
      {children}
    </ul>
  );
}

/** The skeleton a tab shows while its first read is in flight: three card-shaped plates. */
export function TabSkeleton({ label = "正在加载" }: { label?: string }) {
  return (
    <div
      aria-label={label}
      className="mt-[12px] grid grid-cols-1 gap-[9px] min-[441px]:grid-cols-2 xl:grid-cols-3"
      role="status"
    >
      <Skeleton className="h-[126px] rounded-[13px]" />
      <Skeleton className="h-[126px] rounded-[13px]" />
      <Skeleton className="h-[126px] rounded-[13px]" />
    </div>
  );
}

type QueryLike = {
  isPending: boolean;
  isFetching: boolean;
  error: unknown;
  data: unknown;
  refetch: () => unknown;
};

/**
 * Pending, failed-with-retry, and the content — with a failed BACKGROUND refetch keeping the cached
 * content on screen under the alert, since a stale list is still the best answer there is.
 */
export function QueryState({
  query,
  label,
  children,
  skeleton,
}: {
  query: QueryLike;
  /** What failed, said by the tab: "读不到插件". */
  label: string;
  children: ReactNode;
  skeleton?: ReactNode;
}) {
  if (query.isPending) return <>{skeleton ?? <TabSkeleton />}</>;
  return (
    <>
      {query.error ? (
        <div className="mt-[12px]">
          <QueryError
            error={query.error}
            label={label}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </div>
      ) : null}
      {query.data === undefined ? null : children}
    </>
  );
}

/**
 * A tab with nothing in it yet: 熊宝, a fact and, where there is one, the way to change it — the
 * workbench's one empty state, inside the tab's hairline.
 */
export function TabEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <WorkbenchEmpty
      action={action}
      className="mt-[12px] border border-border"
      description={description}
      title={title}
    />
  );
}

/** A filter that matches nothing, with the one way back. */
export function NoMatch({
  title,
  onClear,
}: {
  title: string;
  onClear?: () => void;
}) {
  return (
    <div className="mt-[12px] flex min-h-[126px] flex-col items-center justify-center gap-[9px] rounded-[13px] border border-border border-dashed px-4 py-8 text-center">
      <p className="text-[13px] text-muted-foreground">{title}</p>
      {onClear ? (
        <Button onClick={onClear} size="sm" variant="outline">
          清除筛选
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A small round badge beside a title or in a card's footer (the reference's `.badge`). Not a
 * control, so plain text a screen reader reads in line; the words carry the state, the tone only
 * echoes it: `positive` is the brighter plate (已授权, 已安装), `warning` the red one for something
 * that needs attention (待授权, 连接异常, 缺少凭据), `muted` the quiet default (未安装).
 */
export function Tag({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "positive" | "warning";
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[20px] shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full px-[8px] font-semibold text-[11px]",
        tone === "positive"
          ? "bg-foreground/[0.08] text-foreground"
          : tone === "warning"
            ? "bg-signal-soft text-signal-ink"
            : "bg-foreground/[0.05] text-muted-foreground",
      )}
      data-tone={tone}
    >
      {children}
    </span>
  );
}

/** "已授予 N 位员工", or that nobody holds it yet. */
export function grantedSentence(count: number): string {
  return count > 0 ? `已授予 ${count} 位员工` : "尚未授予任何员工";
}

/**
 * Which page numbers the pager draws: every page when there are five or fewer, otherwise the first,
 * the last, the current one and its neighbours (the first three while near the start, the last three
 * near the end), with `"gap"` where numbers are left out — 「1 2 3 … 7」 as the reference draws it.
 * A gap of exactly one page draws that page instead, since an ellipsis would be no shorter.
 */
export function pageWindow(page: number, pages: number): (number | "gap")[] {
  if (pages <= 5) return Array.from({ length: pages }, (_, index) => index + 1);
  const keep = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 2) for (const n of [2, 3]) keep.add(n);
  if (page >= pages - 1) for (const n of [pages - 2, pages - 1]) keep.add(n);
  const numbers = [...keep]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  let previous = 0;
  for (const n of numbers) {
    if (n - previous === 2) out.push(n - 1);
    else if (n - previous > 2) out.push("gap");
    out.push(n);
    previous = n;
  }
  return out;
}

const PAGER_BUTTON =
  "inline-flex size-[32px] items-center justify-center rounded-[9px] text-[13px] tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40";

/**
 * The pager under a grid, bottom right: ←, the page numbers with the current one boxed, →. One-based,
 * and the caller keeps the page in the URL so a reload or a shared link lands on the same page. The
 * arrows are named 上一页 / 下一页 for a screen reader.
 */
export function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  if (pages <= 1) return null;
  return (
    <nav
      aria-label="分页"
      className="mt-[20px] flex items-center justify-end gap-[4px]"
    >
      <button
        aria-label="上一页"
        className={cn(
          PAGER_BUTTON,
          "text-muted-foreground hover:text-foreground",
        )}
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        type="button"
      >
        <IconArrowLeft aria-hidden="true" className="size-[16px]" />
      </button>
      {pageWindow(page, pages).map((item, index, all) =>
        item === "gap" ? (
          <span
            aria-hidden="true"
            className="inline-flex size-[32px] items-center justify-center text-[13px] text-muted-foreground"
            // A gap always follows a number, which names it.
            key={`gap-after-${all[index - 1]}`}
          >
            …
          </span>
        ) : (
          <button
            aria-current={item === page ? "page" : undefined}
            className={cn(
              PAGER_BUTTON,
              item === page
                ? "border border-border bg-foreground/[0.05] font-semibold text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]"
                : "text-muted-foreground hover:text-foreground",
            )}
            data-current={item === page ? "true" : undefined}
            key={item}
            onClick={() => onPage(item)}
            type="button"
          >
            {item}
          </button>
        ),
      )}
      <button
        aria-label="下一页"
        className={cn(
          PAGER_BUTTON,
          "text-muted-foreground hover:text-foreground",
        )}
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
        type="button"
      >
        <IconArrowRight aria-hidden="true" className="size-[16px]" />
      </button>
    </nav>
  );
}
