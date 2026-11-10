import {
  LOCAL_LEARNING_SKIPPED,
  type LocalLearningOverview,
  type LocalSkillCandidateSummary,
} from "@openbot/shared/local-learning";
import {
  IconChevronRight,
  IconHistory,
  IconMessages,
  IconSparkles,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
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
import {
  approveLocalCandidateMutationOptions,
  rejectLocalCandidateMutationOptions,
  setLocalLearningEnabledMutationOptions,
  startLocalLearningMutationOptions,
} from "@/lib/local-learning/mutations";
import {
  localCandidateQueryOptions,
  localLearningQueryOptions,
  type StartedLocalLearning,
} from "@/lib/local-learning/queries";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";
import { relativeTime } from "@/lib/relative-time";
import { skillFormSchema } from "@/lib/skills/form";
import { queryClient } from "@/query-client";

const DESCRIPTION =
  "熊宝每天读一次你和员工最近的对话，把反复做的事整理成技能草案。你批准后才会交给员工，对话不会离开熊宝。";

/** 已处理的草案显示最近几条。 */
const REVIEWED_SHOWN = 5;

/** 对话发生的时间，按这台电脑的时区。 */
const evidenceTime = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
});

function agentLabel(candidate: LocalSkillCandidateSummary): string {
  return candidate.agentName ?? "已不在的员工";
}

/** 上次学习的结果，给本人看的一句话。 */
function lastRunText(overview: LocalLearningOverview): string {
  if (overview.running) return "正在学习…";
  const run = overview.lastRun;
  if (!run) return "还没学过。";
  const when = `上次学习（${relativeTime(run.finishedAt ?? run.startedAt)}）：`;
  switch (run.outcome) {
    case "proposed":
      return `${when}提出了 ${run.candidates} 条草案。`;
    case "nothing":
      return `${when}没有发现可以整理成技能的做法。`;
    case "skipped":
      return `${when}${run.skipReason ? LOCAL_LEARNING_SKIPPED[run.skipReason] : "这次没有学。"}`;
    case "failed":
      return `${when}没学成，稍后会再试。`;
    case "running":
      return "正在学习…";
  }
}

/** 命令名不合规则时的说法；合规时为 null。规则和技能库的一致（`skillFormSchema`）。 */
function slugProblem(slug: string): string | null {
  const parsed = skillFormSchema.shape.slug.safeParse(slug);
  return parsed.success
    ? null
    : (parsed.error.issues[0]?.message ?? "命令名不对。");
}

/**
 * 设置里「学习」页最上面的一块：从对话中学习的开关、上次学习的结果、「现在学一次」，
 * 以及员工从对话里提出的技能草案。草案在这里批准后，技能才会存进技能库并交给员工。
 */
export function LocalLearningSection() {
  const [started, setStarted] = useState<StartedLocalLearning | null>(null);
  const overview = useQuery(localLearningQueryOptions(started));
  const setEnabled = useMutation(
    setLocalLearningEnabledMutationOptions(queryClient),
  );
  const learn = useMutation(startLocalLearningMutationOptions(queryClient));
  const [open, setOpen] = useState<LocalSkillCandidateSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (overview.isPending) return null;
  if (overview.error) {
    return (
      <PageSection description={DESCRIPTION} title="从对话中学习">
        <p className="mt-4 text-destructive text-sm" role="alert">
          {overview.error.message}
        </p>
      </PageSection>
    );
  }
  const data = overview.data;
  if (!data.available) {
    return (
      <PageSection title="从对话中学习">
        <p className="mt-1 text-pretty text-muted-foreground text-sm">
          这个部署没有开启从对话中学习。
        </p>
      </PageSection>
    );
  }
  // 开关一按就显示新的状态，保存在路上也一样。
  const enabled =
    (setEnabled.isPending ? setEnabled.variables : undefined) ?? data.enabled;
  const reviewed = data.reviewed.slice(0, REVIEWED_SHOWN);

  const learnNow = () => {
    setNotice(null);
    const from = data.lastRun?.startedAt ?? null;
    learn.mutate(undefined, {
      onSuccess: () => {
        setStarted({ from, at: Date.now() });
        setNotice("开始学习了，学完后草案会出现在这里。");
      },
    });
  };

  return (
    <>
      <PageSection description={DESCRIPTION} title="从对话中学习">
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconMessages />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>从对话中学习</ItemTitle>
              <ItemDescription>
                {enabled
                  ? "熊宝每天读一次你和员工最近的对话。"
                  : "熊宝不会读你的对话来整理技能。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="从对话中学习"
                checked={enabled}
                disabled={setEnabled.isPending}
                onCheckedChange={(checked) => setEnabled.mutate(checked)}
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconHistory />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{lastRunText(data)}</ItemTitle>
              {enabled && data.nextRunAt && !data.running && (
                <ItemDescription>
                  下次学习：{relativeTime(data.nextRunAt)}。
                </ItemDescription>
              )}
            </ItemContent>
            <ItemActions>
              <Button
                disabled={!enabled || data.running || learn.isPending}
                onClick={learnNow}
                size="sm"
                type="button"
                variant="outline"
              >
                {data.running || learn.isPending ? "正在学习…" : "现在学一次"}
              </Button>
            </ItemActions>
          </Item>
        </PageRows>
        {setEnabled.error && (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {setEnabled.error.message}
          </p>
        )}
        {learn.error && (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {learn.error.message}
          </p>
        )}
        {notice && (
          <p className="mt-4 text-muted-foreground text-sm" role="status">
            {notice}
          </p>
        )}
      </PageSection>

      <PageSection
        description="批准一条草案，技能就会存进你的技能库，并交给提出它的员工。"
        title="技能草案"
      >
        {data.pending.length === 0 ? (
          <PageEmpty icon={IconSparkles} title="没有等你批准的草案">
            学完后，熊宝从对话里整理出的技能草案会出现在这里。
          </PageEmpty>
        ) : (
          <PageRows>
            {data.pending.map((candidate, index) => (
              <Fragment key={candidate.id}>
                {index > 0 && <Separator />}
                <Item
                  render={
                    <button
                      onClick={() => {
                        setNotice(null);
                        setOpen(candidate);
                      }}
                      type="button"
                    />
                  }
                  size="sm"
                >
                  <ItemMedia variant="icon">
                    <IconSparkles />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{candidate.title}</ItemTitle>
                    <ItemDescription>{candidate.summary}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <span className="text-muted-foreground text-sm">
                      {agentLabel(candidate)}
                    </span>
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        )}
        {reviewed.length > 0 && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              最近处理过的草案
            </summary>
            <PageRows>
              {reviewed.map((candidate, index) => (
                <Fragment key={candidate.id}>
                  {index > 0 && <Separator />}
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{candidate.title}</ItemTitle>
                      <ItemDescription>
                        {[
                          candidate.status === "approved"
                            ? candidate.skillSlug
                              ? `已批准（/${candidate.skillSlug}）`
                              : "已批准"
                            : "已拒绝",
                          agentLabel(candidate),
                          candidate.reviewedAt
                            ? relativeTime(candidate.reviewedAt)
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                </Fragment>
              ))}
            </PageRows>
          </details>
        )}
      </PageSection>

      {open && (
        <CandidateDialog
          candidate={open}
          key={open.id}
          onClose={() => setOpen(null)}
          onDone={(message) => {
            setOpen(null);
            setNotice(message);
          }}
        />
      )}
    </>
  );
}

/**
 * 一条技能草案：员工为什么提它、技能步骤、来自哪些对话。可以改命令名，然后批准并交给员工，或者不要它。
 */
function CandidateDialog({
  candidate,
  onClose,
  onDone,
}: {
  candidate: LocalSkillCandidateSummary;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const slugId = useId();
  const detail = useQuery(localCandidateQueryOptions(candidate.id));
  const approve = useMutation(
    approveLocalCandidateMutationOptions(queryClient),
  );
  const reject = useMutation(rejectLocalCandidateMutationOptions(queryClient));
  const [slug, setSlug] = useState(candidate.slug);
  const [touched, setTouched] = useState(false);
  const problem = slugProblem(slug);
  // 存技能时同名的会被替换：先说一声，想保留原来的就换个命令名。
  const replaces = useQuery(pluginsPageQueryOptions()).data?.skills.some(
    (skill) => skill.slug === slug.trim(),
  );
  const agentGone = candidate.agentName === null;
  const busy = approve.isPending || reject.isPending;
  const error = approve.error ?? reject.error;
  const loaded = detail.data;

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{candidate.title}</DialogTitle>
          <DialogDescription>
            {agentLabel(candidate)}提出 · {candidate.summary}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 gap-5 overflow-y-auto">
          {detail.isPending ? null : detail.error ? (
            <p className="text-destructive text-sm" role="alert">
              {detail.error.message}
            </p>
          ) : (
            <>
              <section className="grid gap-1.5">
                <h3 className="font-medium text-sm">为什么提这一项</h3>
                <p className="text-pretty text-sm">{detail.data.reason}</p>
              </section>
              <section className="grid gap-1.5">
                <h3 className="font-medium text-sm">技能步骤</h3>
                <p className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">
                  {detail.data.instructions}
                </p>
              </section>
              {detail.data.evidence.length > 0 && (
                <section className="grid gap-1.5">
                  <h3 className="font-medium text-sm">来自这些对话</h3>
                  <ul className="grid gap-1 text-sm">
                    {detail.data.evidence.map((item) => (
                      <li
                        className="flex flex-wrap justify-between gap-x-3"
                        key={`${item.threadId}:${item.runId}`}
                      >
                        <span
                          className={
                            item.exists ? undefined : "text-muted-foreground"
                          }
                        >
                          {item.name ?? "已删除的对话"}
                        </span>
                        <span className="text-muted-foreground">
                          {evidenceTime.format(new Date(item.at))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <Field>
                <FieldLabel htmlFor={slugId}>命令名</FieldLabel>
                <Input
                  aria-invalid={touched && problem !== null}
                  disabled={busy}
                  id={slugId}
                  onBlur={() => setTouched(true)}
                  onChange={(event) => {
                    setSlug(event.target.value);
                    setTouched(true);
                    approve.reset();
                  }}
                  value={slug}
                />
                {touched && problem ? (
                  <FieldError>{problem}</FieldError>
                ) : replaces ? (
                  <FieldDescription>
                    已经有 /{slug.trim()}{" "}
                    这项技能了。批准会用这条草案替换它，想保留原来的就换个命令名。
                  </FieldDescription>
                ) : (
                  <FieldDescription>
                    在对话里输入 /{slug.trim() || "命令名"} 就能用这项技能。
                  </FieldDescription>
                )}
              </Field>
            </>
          )}
          {agentGone && (
            <p className="text-muted-foreground text-sm">
              提出它的员工已经不在了，没法把技能交给它。
            </p>
          )}
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            disabled={busy}
            onClick={() =>
              reject.mutate(candidate.id, {
                onSuccess: () => onDone("已拒绝这条草案。"),
              })
            }
            size="sm"
            type="button"
            variant="outline"
          >
            不要这一条
          </Button>
          <Button
            disabled={busy || !loaded || problem !== null || agentGone}
            onClick={() => {
              if (!loaded) return;
              approve.mutate(
                { candidate: loaded, slug: slug.trim() },
                {
                  onSuccess: () =>
                    onDone(`已把技能交给${agentLabel(candidate)}。`),
                },
              );
            }}
            size="sm"
            type="button"
          >
            {approve.isPending ? "正在保存…" : "批准并交给员工"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
