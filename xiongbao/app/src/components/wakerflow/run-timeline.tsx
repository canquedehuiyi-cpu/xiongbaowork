import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  listWakerFlowRunEvents,
  runEventLabel,
  type WakerFlowRunEvent,
} from "@/lib/wakerflows";

/** How many events one page holds. */
const PAGE = 20;

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/**
 * What happened in one run, in order (WF8, spec §3.4): when it started, each step's start, end, wait,
 * answer, skip or failure, and how it ended. Read a page at a time by sequence; 加载更多 asks for the
 * page after the last one shown, so nothing is shown twice or skipped. While the run is still going,
 * a change on the run (`version`) reads what came after the newest event already shown.
 *
 * Outputs are not here: the event record never holds them (D10), the steps above show them.
 */
export function RunTimeline(props: {
  flowId: string;
  runId: string;
  /** Anything that changes when the run does, so new events are read as they happen. */
  version: string;
  /** Overridable so a test can page through a short list. */
  pageSize?: number;
}) {
  const { flowId, runId, version } = props;
  const pageSize = props.pageSize ?? PAGE;
  const [events, setEvents] = useState<WakerFlowRunEvent[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The sequence the next read starts after; kept in a ref so overlapping reads cannot repeat a page.
  const last = useRef(0);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setFailure(null);
    try {
      const page = await listWakerFlowRunEvents(flowId, runId, {
        after: last.current,
        limit: pageSize,
      });
      const fresh = page.events.filter(
        (event) => event.sequence > last.current,
      );
      const newest = fresh.at(-1);
      if (newest) last.current = newest.sequence;
      setEvents((shown) => [...shown, ...fresh]);
      setMore(page.next !== null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "运行记录没能加载。");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [flowId, runId, pageSize]);

  // The first page, and whatever the run did since the newest event shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the trigger, not an input
  useEffect(() => {
    if (!more) void load();
  }, [load, version]);

  return (
    <section
      aria-label="运行时间线"
      className="flex flex-col gap-[6px] text-[12px]"
    >
      <h4 className="font-semibold text-[13px]">时间线</h4>
      {events.length === 0 && !loading && !failure ? (
        <p className="text-muted-foreground">还没有记录。</p>
      ) : null}
      <ul className="flex flex-col gap-[3px] border-border border-l pl-[10px]">
        {events.map((event) => (
          <li
            className="flex flex-row gap-2"
            data-event-type={event.type}
            key={event.sequence}
          >
            <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums leading-[18px]">
              {timeOf(event.createdAt)}
            </span>
            <span>{runEventLabel(event)}</span>
          </li>
        ))}
      </ul>
      {failure ? (
        <p className="text-signal-ink" role="alert">
          {failure}
        </p>
      ) : null}
      {more ? (
        <div>
          <Button
            disabled={loading}
            onClick={() => void load()}
            size="sm"
            type="button"
            variant="outline"
          >
            {loading ? "正在加载…" : "加载更多"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
