import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { RequestError } from "@/lib/client";
import { newId } from "@/lib/new-id";
import {
  getWakerFlowSharePreview,
  importWakerFlowShare,
  wakerFlowKeys,
} from "@/lib/wakerflows";

/**
 * Importing a shared WakerFlow (WF9, spec §3.4): what the link holds, a coworker of the person's own
 * for every role, and 导入 — which makes a draft Flow of theirs and opens it in the editor, where
 * Save is what makes it runnable (D8). Signing in comes first (D9, `_authed`).
 */
export const Route = createFileRoute("/_authed/_app/wakerflows/import/$token")({
  component: ImportPage,
});

function ImportPage() {
  const { token } = Route.useParams();
  return <WakerFlowImport key={token} token={token} />;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

export function WakerFlowImport(props: { token: string }) {
  const { token } = props;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const preview = useQuery({
    queryKey: wakerFlowKeys.sharePreview(token),
    queryFn: () => getWakerFlowSharePreview(token),
    retry: false,
  });
  const agents = useQuery(agentListQueryOptions());
  const [members, setMembers] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** One request id per choice of coworkers, so a retry after a lost answer imports once. */
  const request = useRef<{ key: string; id: string } | null>(null);

  const share = preview.data;
  const roster = agents.data ?? [];
  const chosen = share?.slots.map((slot) => members[slot.slot] ?? "") ?? [];
  const complete = chosen.length > 0 && chosen.every((agentId) => agentId);
  const distinct = new Set(chosen.filter(Boolean)).size === chosen.length;
  const ready = share !== undefined && complete && distinct && !importing;

  async function submit() {
    if (!share || !ready) return;
    const key = JSON.stringify(members);
    if (request.current?.key !== key) request.current = { key, id: newId() };
    setImporting(true);
    setFailure(null);
    try {
      const imported = await importWakerFlowShare(token, {
        requestId: request.current.id,
        members,
      });
      await queryClient.invalidateQueries({ queryKey: wakerFlowKeys.list() });
      await navigate({
        to: "/wakerflows/new",
        search: { flow: imported.flowId },
      });
    } catch (error) {
      // A refusal is final for this request; a lost answer keeps the id, so a retry is the same import.
      if (error instanceof RequestError) request.current = null;
      setFailure(
        error instanceof Error ? error.message : "没能导入这个 WakerFlow。",
      );
      if (error instanceof RequestError)
        await queryClient.invalidateQueries({
          queryKey: wakerFlowKeys.sharePreview(token),
        });
    } finally {
      setImporting(false);
    }
  }

  if (!share) {
    return (
      <PageShell
        backButton={{ label: "WakerFlow", linkProps: { to: "/wakerflows" } }}
        title="导入 WakerFlow"
      >
        {preview.error ? (
          <p className="mt-8 text-destructive text-sm" role="alert">
            {preview.error.message}
          </p>
        ) : (
          <div className="mt-8 flex flex-col gap-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14 w-2/3" />
          </div>
        )}
      </PageShell>
    );
  }

  return (
    <PageShell
      backButton={{ label: "WakerFlow", linkProps: { to: "/wakerflows" } }}
      description={share.description || undefined}
      title={`导入「${share.name}」`}
    >
      <p className="mt-4 text-muted-foreground text-sm">
        共 {share.stepCount} 个步骤、{share.inputCount} 项输入。链接
        {when(share.expiresAt)} 到期，还可以导入 {share.remainingUses} 次。
        导入后是你自己的草稿，检查并保存后才能运行。
      </p>
      <PageSection description="为每个角色选择你自己的一位员工。" title="角色">
        <ul className="mt-3 flex flex-col gap-3 text-sm">
          {share.slots.map((slot) => (
            <li className="flex flex-col gap-1" key={slot.slot}>
              <span className="font-medium">{slot.role}</span>
              {slot.prompt ? (
                <span className="text-muted-foreground text-xs">
                  {slot.prompt}
                </span>
              ) : null}
              <select
                aria-label={`「${slot.role}」由谁担任`}
                className="w-72 rounded-md border border-input bg-background px-2 py-1 text-sm"
                onChange={(event) =>
                  setMembers((current) => ({
                    ...current,
                    [slot.slot]: event.target.value,
                  }))
                }
                value={members[slot.slot] ?? ""}
              >
                <option value="">选择员工</option>
                {roster.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
        {complete && !distinct ? (
          <p className="mt-3 text-destructive text-sm">
            每个角色需要选择不同的员工。
          </p>
        ) : null}
        {failure ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {failure}
          </p>
        ) : null}
        <div className="mt-4">
          <Button disabled={!ready} onClick={submit}>
            {importing ? "正在导入…" : "导入为草稿"}
          </Button>
        </div>
      </PageSection>
    </PageShell>
  );
}
