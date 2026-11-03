import {
  mutationOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
import { proactiveKeys } from "@/lib/proactive";
import { responsibilityKeys } from "@/lib/responsibilities";
import { type AutonomousSummary, autonomousKeys } from "./queries";

/**
 * The 启停开关 of spec C1 for the two kinds of unattended work the routine store does not own: a
 * long-running responsibility and a proactive check-in.
 *
 * Neither is a new write. A responsibility is switched by the same `pause`/`resume` transitions its
 * own page uses, and a check-in by the same `PATCH { enabled }` the settings screen sends, so whatever
 * those stores refuse is refused here too, in their words.
 *
 * The switch moves at once (optimistic): every cached summary on this page, one coworker's and the
 * 全部员工 overview alike, is rewritten before the request goes out, and if the server says no that one
 * row is put back to exactly what each cache held for it. Only that row: restoring a whole snapshot
 * would also undo a second switch pressed while the first was still waiting. Once no switch is
 * waiting any more the summaries are asked again, because the server is the one that knows what was
 * actually stored; asking while another switch still waits would draw that one back before its
 * answer.
 */

/** Every switch on the page, so one settling can tell whether another is still waiting. */
const SWITCH_KEY = ["autonomous-switch"] as const;

/** For each cached entry, how to put the switched row back to what that entry held before. */
type Undo = { key: QueryKey; put: (cached: unknown) => unknown }[];

type Row = { id: string };

/** Rewrite one row, wherever it appears, in a summary or in the overview's list of summaries. */
function patchCached(
  cached: unknown,
  rewrite: (summary: AutonomousSummary) => AutonomousSummary,
): unknown {
  if (Array.isArray(cached))
    return cached.map((entry) => rewrite(entry as AutonomousSummary));
  if (cached && typeof cached === "object")
    return rewrite(cached as AutonomousSummary);
  return cached;
}

function summariesIn(cached: unknown): AutonomousSummary[] {
  if (Array.isArray(cached)) return cached as AutonomousSummary[];
  if (cached && typeof cached === "object")
    return [cached as AutonomousSummary];
  return [];
}

function mapRows<T extends Row>(
  rows: T[] | undefined,
  id: string,
  change: (row: T) => T,
): T[] | undefined {
  return rows?.map((row) => (row.id === id ? change(row) : row));
}

/** One switched row: how to read its value from a summary and how to write one back. */
type RowAccess<V> = {
  read: (summary: AutonomousSummary) => V | undefined;
  write: (summary: AutonomousSummary, value: V) => AutonomousSummary;
};

async function applyOptimistic<V>(
  queryClient: QueryClient,
  row: RowAccess<V>,
  next: V,
): Promise<Undo> {
  // A refetch already in flight would land after this and draw the switch back where it was.
  await queryClient.cancelQueries({ queryKey: autonomousKeys.all });
  const undo: Undo = [];
  for (const [key, cached] of queryClient.getQueriesData({
    queryKey: autonomousKeys.all,
  })) {
    const value = summariesIn(cached)
      .map(row.read)
      .find((found) => found !== undefined);
    if (value === undefined) continue;
    undo.push({
      key,
      put: (current) =>
        patchCached(current, (summary) => row.write(summary, value)),
    });
    queryClient.setQueryData(
      key,
      patchCached(cached, (summary) => row.write(summary, next)),
    );
  }
  return undo;
}

function restore(queryClient: QueryClient, undo: Undo | undefined) {
  for (const { key, put } of undo ?? [])
    queryClient.setQueryData<unknown>(key, (cached: unknown) => put(cached));
}

/**
 * Ask again, without holding the switch until the answer arrives: the server's yes or no is what the
 * person is waiting on, and a slow summary must not keep the switch locked or its refusal unsaid.
 * `isMutating` still counts the switch that is settling, so 1 means no other switch is waiting.
 */
function refresh(queryClient: QueryClient, related: QueryKey) {
  void queryClient.invalidateQueries({ queryKey: related });
  if (queryClient.isMutating({ mutationKey: SWITCH_KEY }) <= 1)
    void queryClient.invalidateQueries({ queryKey: autonomousKeys.all });
}

function responsibilityRow(id: string): RowAccess<string> {
  return {
    read: (summary) =>
      summary.responsibilities?.find((row) => row.id === id)?.status,
    write: (summary, status) => {
      const responsibilities = mapRows(summary.responsibilities, id, (row) => ({
        ...row,
        status,
      }));
      return responsibilities ? { ...summary, responsibilities } : summary;
    },
  };
}

function proactiveRow(id: string): RowAccess<boolean> {
  return {
    read: (summary) => summary.proactive?.find((row) => row.id === id)?.enabled,
    write: (summary, enabled) => {
      const proactive = mapRows(summary.proactive, id, (row) => ({
        ...row,
        enabled,
      }));
      return proactive ? { ...summary, proactive } : summary;
    },
  };
}

/** A responsibility is "on" while it is active; paused is off; completed is neither and not offered. */
export function setResponsibilityEnabledMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationKey: SWITCH_KEY,
    mutationFn: (variables: { id: string; enabled: boolean }) =>
      client(
        `/api/responsibilities/${encodeURIComponent(variables.id)}/${
          variables.enabled ? "resume" : "pause"
        }`,
        {
          method: "POST",
          fallback: variables.enabled
            ? "长期职责没能开启。"
            : "长期职责没能暂停。",
        },
      ),
    onMutate: (variables) =>
      applyOptimistic(
        queryClient,
        responsibilityRow(variables.id),
        variables.enabled ? "active" : "paused",
      ),
    onError: (_error, _variables, undo) => restore(queryClient, undo),
    onSettled: () => refresh(queryClient, responsibilityKeys.all),
  });
}

/** Switch one proactive check-in on or off, through the settings store's own patch. */
export function setProactiveEnabledMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: SWITCH_KEY,
    mutationFn: (variables: { id: string; enabled: boolean }) =>
      client(`/api/proactive/settings/${encodeURIComponent(variables.id)}`, {
        method: "PATCH",
        body: { enabled: variables.enabled },
        fallback: variables.enabled
          ? "主动巡检没能开启。"
          : "主动巡检没能关闭。",
      }),
    onMutate: (variables) =>
      applyOptimistic(
        queryClient,
        proactiveRow(variables.id),
        variables.enabled,
      ),
    onError: (_error, _variables, undo) => restore(queryClient, undo),
    onSettled: () => refresh(queryClient, proactiveKeys.settings),
  });
}
