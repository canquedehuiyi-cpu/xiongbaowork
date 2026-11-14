import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  RunnableBadge,
  runnableGrade,
} from "@/components/resources/runnable-badge";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";
import { useZh } from "@/lib/translations/queries";
import { cn } from "@/lib/utils";
import { TranslatedInstructions } from "./translated-instructions";

/**
 * 一条技能的正文，只读（`/capabilities/skills?view=<slug>`）。
 *
 * 为什么要有它：技能页翻开的一直是编辑面板，而只有自己的技能点得开。品牌包给的 109 条于是能列出、
 * 能打档位、能说缺什么，却谁也读不到它到底教员工做什么——「我的」那 109 张卡连正文的影子都没有。
 * 正文因此有了自己的地址：可分享、可刷新、按后退关上，和 `?edit=` 同一套机制（列表留在面板后面）。
 *
 * 只读这件事是刻意的：部署给的技能不归这个人改，画一个「保存改动」就是画一个必然被服务端拒绝的按钮。
 * 要改请走 `?edit=`，那条路自己会判断归不归你。
 *
 * 读的是列表已经拿到的东西（同一个 `/api/plugins`，react-query 从缓存喂），不另发请求；地址里那条不
 * 在列表中就照实说不在了——可能是别处删了，也可能是别人的技能，两种都不是「空面板」能回答的。
 */
export function SkillView({ slug }: { slug: string }) {
  const zh = useZh();
  const { data, isPending } = useQuery(pluginsPageQueryOptions());

  /* 加载中什么都不画：「还没到」和「不在了」不能长一个样。 */
  if (isPending) return null;

  /* 没有列表不等于没有这条技能：`isPending` 在读取失败时也会转 false。 */
  if (!data) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
        <p className="text-destructive text-sm" role="alert">
          读不到这个技能。
        </p>
      </div>
    );
  }

  const skill = data.skills.find((candidate) => candidate.slug === slug);
  if (!skill) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
        <p className="text-muted-foreground text-sm">
          这个技能不在了，或者不归你看。
        </p>
      </div>
    );
  }

  const body = skill.instructions ?? "";
  const grade = runnableGrade(skill.runnable);
  /* 理由与卡片同源：引文给人读，规则 id 挂 title 供检索（R18）。完整可用的技能没有缺什么可说。 */
  const reason =
    grade && grade !== "full"
      ? (skill.blockedReasonRef ?? skill.blockedReason)
      : null;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-[12px]">
          <div className="min-w-0">
            <h1 className="font-semibold text-2xl">{zh(skill.title)}</h1>
            <code className="mt-[4px] block font-mono text-muted-foreground text-xs">
              /{skill.slug}
            </code>
          </div>
          <RunnableBadge runnable={skill.runnable} />
        </div>
        {skill.summary ? (
          <p className="text-muted-foreground text-sm">{zh(skill.summary)}</p>
        ) : null}
      </header>

      {reason ? (
        <section className="rounded-[10px] border border-amber-500/40 bg-amber-500/10 px-[12px] py-[9px]">
          <h2 className="font-medium text-[12px] text-amber-700 dark:text-amber-300">
            缺什么
          </h2>
          <p
            className="mt-[3px] text-[12px] text-amber-800 leading-[1.6] dark:text-amber-200"
            title={skill.blockedReason ?? undefined}
          >
            {reason}
          </p>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="font-medium text-[13px]">正文</h2>
        {body.trim() ? (
          <>
            {/* 原文照排：换行是这条指令的一部分，不能被排版吃掉。 */}
            <div className="whitespace-pre-wrap text-[13px] leading-[1.7]">
              {body}
            </div>
            <TranslatedInstructions text={body} />
          </>
        ) : (
          <p className="text-muted-foreground text-sm">这条技能没有正文。</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium text-[13px]">点名的工具</h2>
        {skill.tools.length > 0 ? (
          <ul className="flex flex-wrap gap-[6px]">
            {skill.tools.map((ref) => (
              <li key={ref}>
                <code className="rounded-[5px] border border-border px-[6px] py-[1px] font-mono text-[11px]">
                  {ref}
                </code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">
            这条技能不点名任何工具。
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * 指向一条技能正文的入口（`?view=<slug>`）。
 *
 * 看得见的是「看正文」，读屏念的是「看正文：写周报」——一列卡里每个链接都叫「看正文」，脱离卡片就
 * 没有意思了；可访问名字是可见文字加名字，念出来与看到的不打架。
 */
export function SkillViewLink({
  slug,
  title,
  className,
}: {
  slug: string;
  title: string;
  className?: string;
}) {
  return (
    <Link
      aria-label={`看正文：${title}`}
      className={cn(
        "text-[11px] text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground",
        className,
      )}
      search={{ view: slug }}
      to="/capabilities/skills"
    >
      看正文
    </Link>
  );
}
