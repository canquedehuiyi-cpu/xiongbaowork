import { IconHeartbeat } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, Fragment, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { AgentProfile } from "@/lib/agents/queries";
import { saveHeartbeatMutationOptions } from "@/lib/heartbeat/mutations";
import {
  type HeartbeatRun,
  type HeartbeatSettings,
  heartbeatQueryOptions,
} from "@/lib/heartbeat/queries";
import { relativeTime } from "@/lib/relative-time";
import {
  HEARTBEAT_CHECKLIST_MAX_CHARS,
  HEARTBEAT_MAX_INTERVAL_MINUTES,
  HEARTBEAT_MIN_INTERVAL_MINUTES,
} from "../../../../shared/heartbeat";

/** 一次醒来怎么收的，用人话说。 */
const OUTCOME_TEXT: Record<HeartbeatRun["outcome"], string> = {
  running: "正在检查",
  quiet: "没事，安静收工",
  acted: "做了事",
  failed: "出错了",
};

export function runSummary(run: HeartbeatRun): string {
  const parts = [OUTCOME_TEXT[run.outcome]];
  if (run.cardsClaimed > 0) parts.push(`领了 ${run.cardsClaimed} 张卡`);
  return parts.join("，");
}

/**
 * 员工设置里的「心跳」：开了以后这位员工隔一段时间自己醒来，照清单检查一遍；没事静默，有事才做、才告诉你。
 * 开关立即生效，间隔和清单点保存。只有能改这位员工的人能动，别人只读。外部员工自己干活，没有心跳。
 */
export function HeartbeatSection({ agent }: { agent: AgentProfile }) {
  const heartbeat = useQuery(heartbeatQueryOptions(agent.id));
  if (agent.external) return null;
  return (
    <>
      <PageSection
        description="开了心跳，这位员工会隔一段时间自己醒来，照清单检查一遍。没事就安静，有事才做、才告诉你。每天的次数和主动检查共用一个上限，安静时段里不会醒来。"
        title="心跳"
      >
        {heartbeat.isPending ? null : heartbeat.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            读不到这位员工的心跳设置。请刷新页面。
          </p>
        ) : (
          <HeartbeatForm
            agentId={agent.id}
            canManage={agent.canManage}
            saved={heartbeat.data.heartbeat}
          />
        )}
      </PageSection>
      {heartbeat.data && heartbeat.data.recent.length > 0 ? (
        <PageSection title="最近几次醒来">
          <PageRows>
            {heartbeat.data.recent.map((run, index) => (
              <Fragment key={run.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>{runSummary(run)}</ItemTitle>
                    <ItemDescription>
                      {relativeTime(run.startedAt)}
                      {run.outcome === "failed" && run.error
                        ? `：${run.error}`
                        : ""}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
    </>
  );
}

function HeartbeatForm({
  agentId,
  canManage,
  saved,
}: {
  agentId: string;
  canManage: boolean;
  saved: HeartbeatSettings;
}) {
  const queryClient = useQueryClient();
  const save = useMutation(saveHeartbeatMutationOptions(queryClient, agentId));
  const [interval, setInterval] = useState(String(saved.intervalMinutes));
  const [checklist, setChecklist] = useState(saved.checklist);
  const [mistake, setMistake] = useState<string | null>(null);
  // 服务器那份变了：没动过的那项跟着换，正在改的留着你填的。
  const [shown, setShown] = useState(saved);
  if (shown !== saved) {
    setShown(saved);
    if (interval === String(shown.intervalMinutes))
      setInterval(String(saved.intervalMinutes));
    if (checklist === shown.checklist) setChecklist(saved.checklist);
  }
  const minutes = Number(interval);
  const dirty =
    interval !== String(saved.intervalMinutes) || checklist !== saved.checklist;
  const locked = !canManage || save.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (
      !Number.isInteger(minutes) ||
      minutes < HEARTBEAT_MIN_INTERVAL_MINUTES ||
      minutes > HEARTBEAT_MAX_INTERVAL_MINUTES
    ) {
      setMistake(
        `间隔要是 ${HEARTBEAT_MIN_INTERVAL_MINUTES} 分钟到 ${HEARTBEAT_MAX_INTERVAL_MINUTES} 分钟之间的整数。`,
      );
      return;
    }
    setMistake(null);
    const patch: Partial<HeartbeatSettings> = {};
    if (minutes !== saved.intervalMinutes) patch.intervalMinutes = minutes;
    if (checklist !== saved.checklist) patch.checklist = checklist;
    save.mutate(patch);
  };

  return (
    <form aria-label="心跳" noValidate onSubmit={submit}>
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconHeartbeat />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>开启心跳</ItemTitle>
            <ItemDescription>
              {saved.enabled
                ? `现在开着：每 ${saved.intervalMinutes} 分钟醒来一次。`
                : canManage
                  ? "现在关着：这位员工只在你找它时才干活。"
                  : "现在关着。只有这位员工的主人能打开。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="开启心跳"
              checked={saved.enabled}
              disabled={locked}
              onCheckedChange={(next) => save.mutate({ enabled: next })}
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item size="sm">
          <ItemContent>
            <ItemTitle>
              <label htmlFor={`heartbeat-interval-${agentId}`}>醒来间隔</label>
            </ItemTitle>
            <ItemDescription>
              单位是分钟，最短 {HEARTBEAT_MIN_INTERVAL_MINUTES} 分钟。
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Input
              className="w-28"
              disabled={locked || !saved.enabled}
              id={`heartbeat-interval-${agentId}`}
              inputMode="numeric"
              max={HEARTBEAT_MAX_INTERVAL_MINUTES}
              min={HEARTBEAT_MIN_INTERVAL_MINUTES}
              onChange={(event) => setInterval(event.target.value)}
              required
              step={5}
              type="number"
              value={interval}
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item size="sm">
          <ItemContent className="w-full">
            <ItemTitle>
              <label htmlFor={`heartbeat-checklist-${agentId}`}>心跳清单</label>
            </ItemTitle>
            <ItemDescription className="line-clamp-none">
              每行写一件要定时看一眼的事，例如「有新卡就看一眼」。这位员工自己也会改它。清单留空时，它只会去看板上领派给自己岗位的卡。
            </ItemDescription>
            <Textarea
              className="mt-2 min-h-28"
              disabled={locked || !saved.enabled}
              id={`heartbeat-checklist-${agentId}`}
              maxLength={HEARTBEAT_CHECKLIST_MAX_CHARS}
              onChange={(event) => setChecklist(event.target.value)}
              placeholder="例如：每天 9 点汇总邮件；有新卡就看一眼"
              value={checklist}
            />
            <span className="mt-1 text-muted-foreground text-xs">
              {checklist.length} / {HEARTBEAT_CHECKLIST_MAX_CHARS}
            </span>
          </ItemContent>
        </Item>
      </PageRows>
      {canManage ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            disabled={!dirty || locked || !saved.enabled}
            size="sm"
            type="submit"
          >
            {save.isPending ? "正在保存…" : "保存心跳"}
          </Button>
          {save.isSuccess && !dirty ? (
            <span className="text-muted-foreground text-sm" role="status">
              已保存。
            </span>
          ) : null}
        </div>
      ) : null}
      {mistake ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {mistake}
        </p>
      ) : save.error ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {/[一-鿿]/.test(save.error.message)
            ? save.error.message
            : "心跳没能保存，请稍后再试。"}
        </p>
      ) : null}
    </form>
  );
}
