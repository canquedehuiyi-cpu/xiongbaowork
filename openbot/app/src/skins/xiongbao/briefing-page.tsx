import { useQuery } from "@tanstack/react-query";
import {
  Link,
  useCanGoBack,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useUserPreferences } from "@/lib/settings/message-list";
import {
  type PreferencesWithWorkHours,
  scheduleTimeZone,
  type WorkHours,
} from "@/lib/settings/work-hours";
import {
  type Briefing,
  type BriefingKind,
  briefingKindAt,
  briefingQueryOptions,
  clockText,
  dayText,
  dueText,
  firstBriefingTask,
  overdueChip,
} from "@/lib/tasks/delivery";
import { cn } from "@/lib/utils";
import { deliveryButton, useWbFallback, ZoneNote } from "./delivery-actions";

/*
 * 手机清点页（交付闭环 Task 10，设计稿 4，`/briefing`）：开工 / 收工清点的全文——已验收、等你验收、还在做、
 * 逾期四个数，下面逐件列出，点一件打开它的卡片详情。数字和列表都原样取自 `GET /api/me/briefing`，和推送、
 * 看板顶上的清点条是同一份。没有在跟的活时服务器不给清点，这里说清楚为什么是空的。
 *
 * 看哪一份按你作息的时区：上午开工清点，过了中午收工清点（`briefingKindAt`）；标题日期、每件的时刻、「今天 /
 * 明早」也按它算，和推送正文、服务器写的「作息外攒下的提醒」同一个钟。作息时区和这台设备不一样时标题下写明。
 * 手机推送「清点」点开落到这里。
 * 颜色只从 `--wb-*` 令牌取；在别的皮肤里打开时根上接上兜底令牌（`useWbFallback`）。
 */

/**
 * 此刻该看哪一份清点。作息还在读时先不定（免得先按浏览器的钟读一份、读到作息再换一份）；读不到作息、或还
 * 没登录读不了时，按浏览器的钟。
 */
export function useBriefingKind(now: Date): {
  kind: BriefingKind | undefined;
  hours: WorkHours | undefined;
  timeZone: string | undefined;
} {
  const preferences = useUserPreferences();
  const hours = (preferences.data as PreferencesWithWorkHours | undefined)
    ?.workHours;
  const reading = preferences.isPending && preferences.fetchStatus !== "idle";
  if (reading) return { kind: undefined, hours, timeZone: undefined };
  const timeZone = scheduleTimeZone(hours);
  return { kind: briefingKindAt(now, timeZone), hours, timeZone };
}

const TAG =
  "shrink-0 whitespace-nowrap rounded-(--wb-radius-pill) px-[7px] py-0.5 text-[11.5px]";

/** 一件活：标签、标题、右边灰色的一句；点开是它的卡片详情。 */
function Row({
  taskId,
  tag,
  tagClass,
  title,
  aside,
}: {
  taskId: string;
  tag: string;
  tagClass: string;
  title: string;
  aside: string;
}) {
  return (
    <li className="flex">
      <Link
        className="flex min-h-11 w-full items-center gap-2.5 rounded-(--wb-radius) border border-(--wb-line) bg-(--wb-card) px-3.5 py-3 text-(--wb-fg) text-[13.5px] outline-none hover:bg-(--wb-hover) focus-visible:outline-2 focus-visible:outline-(--wb-blue)"
        params={{ taskId }}
        to="/tasks/$taskId"
      >
        <span className={cn(TAG, tagClass)}>{tag}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <small className="ml-auto shrink-0 whitespace-nowrap text-(--wb-muted) text-[12px]">
          {aside}
        </small>
      </Link>
    </li>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="m-0 mt-1 font-semibold text-(--wb-fg2) text-[13px]">
        {title}
      </h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">{children}</ul>
    </section>
  );
}

function Tile({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: "blue" | "danger";
}) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5 rounded-(--wb-radius) bg-(--wb-list) p-3">
      <b
        className={cn(
          "font-semibold text-[22px] leading-tight",
          tone === "blue" && value > 0 ? "text-(--wb-blue-text)" : null,
          tone === "danger" && value > 0 ? "text-(--wb-danger-fg)" : null,
        )}
      >
        {value}
      </b>
      <span className="truncate text-(--wb-muted) text-[12px]">{label}</span>
    </li>
  );
}

function BriefingBody({
  briefing,
  kind,
  now,
  timeZone,
}: {
  briefing: Briefing;
  kind: BriefingKind;
  now: Date;
  /** 作息时区：时刻和「今天 / 明早」都按它算，和推送、服务器写的提醒同一个钟。 */
  timeZone?: string;
}) {
  return (
    <>
      <ul
        aria-label="清点数字"
        className="m-0 grid list-none grid-cols-4 gap-2 p-0"
      >
        <Tile label="已验收" value={briefing.reviewed} />
        <Tile
          label="等你验收"
          tone="blue"
          value={briefing.awaitingReview.length}
        />
        <Tile label="还在做" value={briefing.inProgress.length} />
        <Tile label="逾期" tone="danger" value={briefing.overdue.length} />
      </ul>
      {briefing.overdue.length > 0 ? (
        <Group title="逾期">
          {briefing.overdue.map((item) => (
            <Row
              aside={overdueChip(item.minutes, item.nudges)}
              key={item.taskId}
              tag="逾期"
              tagClass="bg-(--wb-danger-soft) text-(--wb-danger-fg)"
              taskId={item.taskId}
              title={item.title}
            />
          ))}
        </Group>
      ) : null}
      {briefing.awaitingReview.length > 0 ? (
        <Group title="等你验收">
          {briefing.awaitingReview.map((item) => (
            <Row
              aside={`${item.agentName} · ${clockText(item.deliveredAt, now, timeZone)}`}
              key={item.taskId}
              tag="已交成果"
              tagClass="bg-(--wb-blue-soft) text-(--wb-blue-text)"
              taskId={item.taskId}
              title={item.title}
            />
          ))}
        </Group>
      ) : null}
      {briefing.inProgress.length > 0 ? (
        <Group title="还在做">
          {briefing.inProgress.map((item) => (
            <Row
              aside={`${item.agentName} · ${
                item.dueAt
                  ? `${dueText(item.dueAt, now, timeZone)} 到期`
                  : "等它接下"
              }`}
              key={item.taskId}
              tag={item.dueAt ? "已接下" : "待接下"}
              tagClass="bg-(--wb-card2) text-(--wb-fg2)"
              taskId={item.taskId}
              title={item.title}
            />
          ))}
        </Group>
      ) : null}
      {kind === "start" && briefing.deferred.length > 0 ? (
        <section aria-label="作息外攒下的提醒" className="flex flex-col gap-2">
          <h2 className="m-0 mt-1 font-semibold text-(--wb-fg2) text-[13px]">
            作息外攒下的提醒
          </h2>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-(--wb-fg2) text-[13px] leading-[1.6]">
            {briefing.deferred.map((text, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 清点里的提醒按先后列，不会变。
              <li key={index}>· {text}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export function BriefingPage({ now: fixedNow }: { now?: Date } = {}) {
  const now = fixedNow ?? new Date();
  const fallback = useWbFallback();
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const { kind, hours, timeZone } = useBriefingKind(now);
  const briefing = useQuery({
    ...briefingQueryOptions(kind ?? "start"),
    enabled: kind !== undefined,
  });
  const label = kind === "end" ? "收工清点" : "开工清点";
  const data = briefing.data;
  const first = data ? firstBriefingTask(data) : null;
  const later = () => {
    if (canGoBack) router.history.back();
    else void navigate({ to: "/tasks" });
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-(--wb-main) text-(--wb-fg)"
      data-briefing-page
      style={fallback}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col gap-3.5 px-4 py-5">
          <h1 className="m-0 mt-1.5 font-semibold text-[18px]">
            {kind ? `${label} · ${dayText(now, timeZone)}` : "清点"}
          </h1>
          <ZoneNote now={now} />
          {kind === undefined || briefing.isPending ? (
            <p className="m-0 text-(--wb-muted) text-[13px]">正在读清点…</p>
          ) : briefing.isError ? (
            <p className="m-0 text-(--wb-danger-fg) text-[13px]" role="alert">
              读不到清点，稍后再试。
            </p>
          ) : data ? (
            <BriefingBody
              briefing={data}
              kind={kind}
              now={now}
              timeZone={timeZone}
            />
          ) : (
            <section
              aria-label="没有清点"
              className="flex flex-col gap-2 rounded-(--wb-radius) border border-(--wb-line) bg-(--wb-card) px-4 py-5"
            >
              <b className="font-semibold text-[15px]">现在没有在跟的活</b>
              <p className="m-0 text-(--wb-fg2) text-[13px] leading-[1.6]">
                没有在跟的活就不发清点。员工接下你派的活，或者你在看板的卡上、卡片详情里、对话右侧的「目标」里点「当作一件活来跟」，它就会出现在这里和看板上。
              </p>
            </section>
          )}
          <p className="m-0 text-(--wb-muted) text-[12px] leading-[1.6]">
            {hours
              ? `开工 ${hours.start}、收工 ${hours.end} 各发一次`
              : "开工、收工各发一次"}
            ，时间按你的作息；没有在跟的活就不发。{" "}
            <Link
              className="text-(--wb-fg2) underline underline-offset-2"
              to="/settings/notifications"
            >
              改作息
            </Link>
          </p>
          <div className="mt-auto flex gap-2 pt-2">
            <button
              className={cn(deliveryButton(false, "lg"), "flex-1")}
              onClick={later}
              type="button"
            >
              稍后
            </button>
            {first ? (
              <Link
                className={cn(deliveryButton(true, "lg"), "flex-1")}
                params={{ taskId: first }}
                to="/tasks/$taskId"
              >
                {data && data.awaitingReview.length > 0 && !data.overdue.length
                  ? "逐件验收"
                  : "逐件看"}
              </Link>
            ) : (
              <Link
                className={cn(deliveryButton(true, "lg"), "flex-1")}
                to="/tasks"
              >
                去看板
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
