import type {
  LearningProposal,
  LearningRunSummary,
} from "@openbot/shared/learning";
import {
  IconAlertTriangle,
  IconLoader2,
  IconSparkles,
} from "@tabler/icons-react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { shortName } from "@/lib/brand";
import { startPersonalLearningRunMutationOptions } from "@/lib/learning/mutations";
import {
  personalReviewQueryOptions,
  recordingSkillsQueryOptions,
} from "@/lib/learning/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import type { Stopped } from "./recording";

/** Where the skills learned from recordings are reviewed and listed. */
export const YOUR_SKILLS = "/settings/learning";

/** How much earlier than the recording's stop a run may be dated and still be after it: the two clocks can differ. */
const CLOCK_SLACK_MS = 60_000;

type Skill = LearningProposal & { container: string };

/** What has become of a saved recording in Learning, as Teach a Bot says it. */
export type LearningNext =
  /** Learning can't run on this machine, and why. */
  | { kind: "model"; reason: string }
  /** Learning is off in the back end. */
  | { kind: "off" }
  /** Couldn't ask. */
  | { kind: "unreadable"; reason: string }
  /** Learning made a skill from it, and it is published to the person's Bots. */
  | { kind: "learned"; skill: Skill }
  /** Learning made a skill from it, and it waits for a review. */
  | { kind: "proposed"; skill: Skill }
  /** A run is going. */
  | { kind: "learning" }
  /** The run since the recording saved failed, and why. */
  | { kind: "failed"; reason: string }
  /** The run since the recording saved finished without a skill from it. */
  | { kind: "none" }
  /** No run since the recording saved. */
  | { kind: "waiting" };

const finished = (run: LearningRunSummary) =>
  run.status === "succeeded" || run.status === "failed";

/**
 * Whether a stopped recording is in the person's Learning space, so there is a next step to say: not discarded, not
 * empty, not kept in the browser, and no longer on its way or being retried.
 */
export function savedToLearning(stopped: Stopped | undefined): boolean {
  return (
    !!stopped &&
    !stopped.discarded &&
    !stopped.empty &&
    !stopped.kept &&
    !stopped.sending &&
    !stopped.retrying
  );
}

/**
 * What Learning has made of the recording Stop just saved, read from the person's own review (their runs, and whether
 * they or an admin approve) and the skills proposed from that recording since it stopped. Learn now starts the same
 * run as Settings, Learning on each of the person's recording spaces.
 *
 * While nothing has come of it yet the review is read again, every 10 seconds during a run and every 30 otherwise, so
 * an automatic run is seen too. Once a skill from it is there, the page tells the person, and the browser does too
 * (a notification, where they allowed them) when they are looking at something else.
 */
export function useLearningNext(stopped: Stopped) {
  const since = stopped.stoppedAt;
  const [started, setStarted] = useState<{ from: string | null } | null>(null);
  // How often the review is read again, set from what the last read said (below).
  const pace = useRef<number | false>(30_000);
  const review = useQuery({
    ...personalReviewQueryOptions(),
    refetchInterval: () => pace.current,
  });
  const learnNow = useMutation(
    startPersonalLearningRunMutationOptions(queryClient),
  );

  const sources = (review.data?.sources ?? []).filter(
    (source) => source.kind === "recordings",
  );
  const latest = sources
    .map((source) => source.latestRun)
    .filter((run) => run !== null)
    .reduce<LearningRunSummary | null>(
      (newest, run) =>
        !newest || run.createdAt > newest.createdAt ? run : newest,
      null,
    );
  const off =
    sources.length > 0 && sources.every((source) => source.unavailable);
  const waitingCount = sources.reduce(
    (count, source) => count + (source.proposals?.length ?? 0),
    0,
  );
  // Anything that can mean a new skill: a run moving on, a proposal arriving, one approved.
  const revision = `${latest?.id ?? ""}:${latest?.status ?? ""}:${waitingCount}:${review.data?.approved ?? 0}`;
  const skills = useQuery({
    ...recordingSkillsQueryOptions(stopped.title, since, revision),
    enabled: review.isSuccess && sources.length > 0 && !off,
    placeholderData: keepPreviousData,
  });

  // A run Learn now started counts as going until a newer run than the one there was is over.
  const runSince =
    latest && Date.parse(latest.createdAt) >= since - CLOCK_SLACK_MS
      ? latest
      : null;
  const startedRunOver =
    started !== null &&
    latest !== null &&
    latest.id !== started.from &&
    finished(latest);
  const running =
    learnNow.isPending ||
    (latest !== null && !finished(latest)) ||
    (started !== null && !startedRunOver);

  const found = skills.data?.skills ?? [];
  const learned = found.find((skill) => skill.status === "approved");
  const proposed = found.find((skill) => skill.status === "pending_review");

  let next: LearningNext;
  if (review.error) next = { kind: "unreadable", reason: review.error.message };
  else if (learned) next = { kind: "learned", skill: learned };
  else if (proposed) next = { kind: "proposed", skill: proposed };
  else if (review.data?.modelProblem)
    next = { kind: "model", reason: review.data.modelProblem };
  else if (off) next = { kind: "off" };
  else if (running) next = { kind: "learning" };
  else if (skills.error)
    next = { kind: "unreadable", reason: skills.error.message };
  else if (runSince?.status === "failed")
    next = {
      kind: "failed",
      reason: runSince.failure ?? "学习没做完就停了。点「立即学习」再试一次。",
    };
  else if (
    runSince?.status === "succeeded" &&
    skills.isSuccess &&
    !skills.isPlaceholderData
  )
    next = { kind: "none" };
  else next = { kind: "waiting" };

  const kind = next.kind;
  useEffect(() => {
    pace.current =
      kind === "learned" || kind === "model" || kind === "off"
        ? false
        : kind === "learning"
          ? 10_000
          : 30_000;
  }, [kind]);

  useSkillNotice(stopped.title, next);

  return {
    loaded: review.isSuccess || review.isError,
    next,
    canReview: review.data?.canReview ?? false,
    autoApprove: review.data?.autoApprove ?? null,
    /** Why Learn now didn't start, in the server's sentence. */
    learnError: learnNow.error?.message ?? null,
    learning: running,
    async learnNow() {
      const from = latest?.id ?? null;
      let any = false;
      learnNow.reset();
      for (const source of sources) {
        try {
          await learnNow.mutateAsync(source.containerId);
          any = true;
        } catch {
          // Said beside the button from the mutation's own error.
        }
      }
      setStarted(any ? { from } : null);
    },
  };
}

/** Whether this browser lets OpenBot interrupt. Some browsers throw on the mere question. */
function notificationsAllowed() {
  try {
    return (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    );
  } catch {
    return false;
  }
}

/**
 * Tells the person in a browser notification once a skill from this recording arrives while they are looking at
 * something else (the browser they recorded in, say), as a Bot that needs them is told. Only a change seen while the
 * page is open: a skill that was already there when it opened is on the page.
 */
function useSkillNotice(title: string, next: LearningNext) {
  const seen = useRef<string | null>(null);
  const skill =
    next.kind === "learned" || next.kind === "proposed"
      ? `${next.kind}:${next.skill.id}`
      : "";
  useEffect(() => {
    const before = seen.current;
    seen.current = skill;
    if (before === null || !skill || skill === before) return;
    if (document.visibilityState !== "hidden" || !notificationsAllowed())
      return;
    try {
      new Notification(
        next.kind === "learned"
          ? `你的员工学会了「${title}」`
          : `从「${title}」学到的技能可以审核了`,
        {
          body:
            next.kind === "learned"
              ? "打开「教员工做事」试一试。"
              : "到「设置 → 学习」里审核。",
          tag: `xiongbao-learned-${skill}`,
        },
      );
    } catch {
      // A browser that refuses the constructor still has the page.
    }
  }, [skill, title, next.kind]);
}

export type LearningNextState = ReturnType<typeof useLearningNext>;

/** The step's heading and sentence once a recording is saved, by what Learning has made of it. */
export function learningNextWords(
  learning: LearningNextState,
  title: string,
): { heading: string; sentence: string } {
  const { next, canReview, autoApprove } = learning;
  if (next.kind === "learned")
    return {
      heading: "你的员工学会了",
      sentence: `你的员工现在会做「${title}」了。试一试，或者让任意一位员工去做。`,
    };
  if (next.kind === "proposed")
    return canReview
      ? {
          heading: "新技能可以审核了",
          sentence: `学习从「${title}」里学出了一项技能。到「设置 → 学习」里批准它，然后就可以让任意一位员工去做。`,
        }
      : {
          heading: "新技能在等管理员审核",
          sentence: `学习从「${title}」里学出了一项技能。管理员批准后，就可以让任意一位员工去做。`,
        };
  if (next.kind === "model" || next.kind === "off")
    return {
      heading: `已保存「${title}」`,
      sentence: `你的录制已保留。等学习可以运行了，${shortName()}就会从中学出技能。`,
    };
  if (!canReview)
    return {
      heading: `已保存「${title}」`,
      sentence: `${shortName()}会从中学出技能，再由管理员审核。批准后，就可以让任意一位员工去做。`,
    };
  return {
    heading: `已保存「${title}」`,
    sentence: autoApprove
      ? `${shortName()}会从中学出技能，你可以在「设置 → 学习」里找到它。学会后，就可以让任意一位员工去做。`
      : `${shortName()}会从中学出技能，你可以在「设置 → 学习」里审核它。你批准后，就可以让任意一位员工去做。`,
  };
}

/**
 * The row under a saved recording on Teach a Bot that says what comes next in Learning, with the one thing to do about
 * it: Learn now, Review, or Try it once the skill is learned.
 */
export function LearningNextRow({
  learning,
  title,
  className,
  more,
}: {
  learning: LearningNextState;
  title: string;
  className?: string;
  /** Another way on beside the row's own action: See your skills, where the row is the whole of the next step. */
  more?: ReactNode;
}) {
  const { next, canReview, learnError } = learning;
  const learnNow = canReview ? (
    <Button
      onClick={() => void learning.learnNow()}
      size="sm"
      variant="outline"
    >
      立即学习
    </Button>
  ) : null;
  let icon = <IconSparkles />;
  let tone: "ok" | "warn" | "busy" | "plain" = "plain";
  let heading: string;
  let sentence: string;
  let action: ReactNode = null;
  switch (next.kind) {
    case "learned":
      tone = "ok";
      heading = "技能已学会";
      sentence = next.skill.description;
      action = (
        <Button size="sm" render={<Link to="/" search={{ ask: title }} />}>
          试一试
        </Button>
      );
      break;
    case "proposed":
      heading = canReview ? "可以审核了" : "等管理员审核";
      sentence = next.skill.description;
      action = canReview ? (
        <Button size="sm" variant="outline" render={<Link to={YOUR_SKILLS} />}>
          审核
        </Button>
      ) : null;
      break;
    case "learning":
      tone = "busy";
      icon = <IconLoader2 />;
      heading = "正在从你的录制里学习";
      sentence = "这需要几分钟。你可以先离开这个页面。";
      break;
    case "failed":
      tone = "warn";
      icon = <IconAlertTriangle />;
      heading = "学习没有完成";
      sentence = next.reason;
      action = learnNow;
      break;
    case "none":
      heading = "还没从中学到技能";
      sentence = "学习没能从这段录制里找出技能。再录一遍，边做边说你在做什么。";
      action = learnNow;
      break;
    case "model":
      tone = "warn";
      icon = <IconAlertTriangle />;
      heading = "学习暂时还不能运行";
      sentence = next.reason;
      break;
    case "off":
      tone = "warn";
      icon = <IconAlertTriangle />;
      heading = "学习已关闭";
      sentence = "后端没有提供学习功能，所以不会从中学习技能。";
      break;
    case "unreadable":
      tone = "warn";
      icon = <IconAlertTriangle />;
      heading = "没能查看学习进度";
      sentence = next.reason;
      break;
    case "waiting":
      heading = "学习会自动运行";
      sentence = canReview
        ? "点「立即学习」可以更快拿到技能。"
        : "什么时候运行由管理员决定。";
      action = learnNow;
      break;
  }
  if (learnError && next.kind !== "learned" && next.kind !== "proposed") {
    tone = "warn";
    icon = <IconAlertTriangle />;
    heading = "学习没能开始";
    sentence = learnError;
  }
  return (
    // Announced as it changes, without being a second status beside the recording's own.
    <Item size="sm" aria-live="polite" className={className}>
      <ItemMedia
        variant="icon"
        className={cn(
          tone === "ok" && "text-emerald-600 dark:text-emerald-400",
          tone === "warn" && "text-amber-600 dark:text-amber-400",
          tone === "busy" && "[&_svg]:animate-spin",
        )}
      >
        {icon}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{heading}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {sentence}
        </ItemDescription>
      </ItemContent>
      {action || more ? (
        <ItemActions>
          {action}
          {more}
        </ItemActions>
      ) : null}
    </Item>
  );
}

/**
 * The next step under a saved recording in the browser drawn in the page (OpenBot Desktop, hosted OpenBot), where Teach
 * a Bot is one page and Record lives in the browser's toolbar: under the toolbar's line that says where the recording
 * went, what Learning does with it next, worded for who approves, and the row that follows it through Learning, with
 * See your skills beside its action. Record another is the toolbar's Record.
 */
export function LearningNextNotice({ stopped }: { stopped: Stopped }) {
  const learning = useLearningNext(stopped);
  if (!learning.loaded) return null;
  const { sentence } = learningNextWords(learning, stopped.title);
  return (
    <div className="border-b border-border bg-background">
      <p className="px-3 pt-2 text-pretty text-foreground/75 text-sm">
        {sentence}
      </p>
      <LearningNextRow
        className="px-3 py-2"
        learning={learning}
        title={stopped.title}
        more={
          <Button
            size="sm"
            variant="outline"
            render={<Link to={YOUR_SKILLS} />}
          >
            查看你的技能
          </Button>
        }
      />
    </div>
  );
}
