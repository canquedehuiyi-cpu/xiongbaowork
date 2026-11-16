import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/resources/resource-kit";
import { RequestError } from "@/lib/client";
import {
  listWakerFlowVersions,
  restoreWakerFlowVersion,
  WAKERFLOW_CONFLICT_MESSAGE,
  type WakerFlow,
  wakerFlowKeys,
} from "@/lib/wakerflows";
import { CARD_FACE } from "./flow-ui";

const when = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * The saved versions of one WakerFlow, and rolling back to one (WF8, spec §3.6).
 *
 * Every Save is a version; the newest is the one the Flow runs. 恢复此版本 asks once more before
 * anything is sent, then has the server save that version's plan again: the restore is itself a new
 * version, and history is never rewritten. A page that was not looking at the newest revision loses
 * the race (409) and is offered a refresh rather than a retry.
 */
export function VersionList(props: { flow: WakerFlow }) {
  const { flow } = props;
  const queryClient = useQueryClient();
  const versions = useQuery({
    queryKey: wakerFlowKeys.versions(flow.id),
    queryFn: () => listWakerFlowVersions(flow.id),
  });
  const [confirming, setConfirming] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState<{ from: number; to: number } | null>(
    null,
  );
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: wakerFlowKeys.detail(flow.id),
      }),
      queryClient.invalidateQueries({
        queryKey: wakerFlowKeys.versions(flow.id),
      }),
    ]);

  async function restore(revision: number) {
    setRestoring(true);
    setFailure(null);
    setRestored(null);
    try {
      const saved = await restoreWakerFlowVersion(flow.id, revision, {
        revision: flow.revision,
      });
      queryClient.setQueryData(wakerFlowKeys.detail(flow.id), saved);
      setRestored({ from: revision, to: saved.revision });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: wakerFlowKeys.versions(flow.id),
        }),
        queryClient.invalidateQueries({ queryKey: wakerFlowKeys.list() }),
      ]);
    } catch (error) {
      if (error instanceof RequestError && error.status === 409)
        setConflict(true);
      else
        setFailure(
          error instanceof Error ? error.message : "没能恢复这个版本。",
        );
    } finally {
      setRestoring(false);
      setConfirming(null);
    }
  }

  const list = versions.data ?? [];
  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <p className="font-medium">当前版本：第 {flow.revision} 版</p>
      {restored ? (
        <p className="text-muted-foreground" role="status">
          已恢复第 {restored.from} 版的计划，保存为第 {restored.to} 版。
        </p>
      ) : null}
      {conflict ? (
        <div
          className="flex flex-wrap items-center gap-2 text-signal-ink"
          role="alert"
        >
          <span>{WAKERFLOW_CONFLICT_MESSAGE}</span>
          <Button
            onClick={async () => {
              setConflict(false);
              await refresh();
            }}
            size="sm"
            variant="outline"
          >
            刷新
          </Button>
        </div>
      ) : null}
      {failure ? (
        <p className="text-signal-ink" role="alert">
          {failure}
        </p>
      ) : null}
      {versions.isPending ? (
        <p className="text-muted-foreground" role="status">
          正在加载版本记录…
        </p>
      ) : versions.error ? (
        <p className="text-signal-ink" role="alert">
          {versions.error.message}
        </p>
      ) : list.length === 0 ? (
        <p className="text-muted-foreground">还没有保存过的版本。</p>
      ) : (
        <ul
          aria-label="版本记录"
          className={`${CARD_FACE} flex flex-col divide-y divide-border overflow-hidden`}
        >
          {list.map((version) => {
            const current = version.revision === flow.revision;
            return (
              <li
                className="flex flex-wrap items-center gap-x-[10px] gap-y-2 px-[14px] py-[10px]"
                key={version.revision}
              >
                <span className="font-semibold tabular-nums">
                  第 {version.revision} 版
                </span>
                <span className="min-w-0 truncate">{version.name}</span>
                <span className="text-[12px] text-muted-foreground tabular-nums">
                  {version.stepCount} 个步骤 · {when(version.createdAt)}
                </span>
                <span className="flex-1" />
                {current ? (
                  <Tag tone="positive">当前</Tag>
                ) : confirming === version.revision ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] text-muted-foreground">
                      恢复后会保存为第 {flow.revision + 1}{" "}
                      版，正在进行的运行不受影响。
                    </span>
                    <Button
                      disabled={restoring}
                      onClick={() => void restore(version.revision)}
                      size="sm"
                    >
                      {restoring ? "正在恢复…" : "确认恢复"}
                    </Button>
                    <Button
                      disabled={restoring}
                      onClick={() => setConfirming(null)}
                      size="sm"
                      variant="outline"
                    >
                      取消
                    </Button>
                  </span>
                ) : (
                  <Button
                    aria-label={`恢复第 ${version.revision} 版`}
                    disabled={restoring || conflict}
                    onClick={() => setConfirming(version.revision)}
                    size="sm"
                    variant="outline"
                  >
                    恢复此版本
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
