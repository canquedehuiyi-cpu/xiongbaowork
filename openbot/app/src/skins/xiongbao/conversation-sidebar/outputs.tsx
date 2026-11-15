import {
  IconCircleCheck,
  IconFile,
  IconFileDiff,
  IconLink,
  IconTable,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ComponentType } from "react";
import {
  type ConversationSidebar,
  SIDEBAR_OUTPUT_LIMIT,
  type SidebarOutput,
} from "../../../../../shared/conversation-sidebar";

/**
 * 「输出内容」：这个对话产出的文件、表格、链接、改动、报告，一行一个，右边标类型；超过 3 条时给
 * 「查看全部 N 项」（去任务看板，产出都挂在那里的任务卡上）。
 */

type Outputs = ConversationSidebar["outputs"];

const KIND_LABELS: Record<SidebarOutput["kind"], string> = {
  file: "文件",
  table: "表格",
  link: "链接",
  diff: "改动",
  report: "报告",
};

const KIND_ICONS: Record<
  SidebarOutput["kind"],
  ComponentType<{ className?: string; "aria-hidden"?: "true" }>
> = {
  file: IconFile,
  table: IconTable,
  link: IconLink,
  diff: IconFileDiff,
  report: IconCircleCheck,
};

const ROW =
  "flex min-h-[30px] items-center gap-2.5 rounded-(--wb-radius-sm) text-(--wb-fg) text-[13px] no-underline outline-none hover:text-(--wb-accent2) focus-visible:outline-2 focus-visible:outline-(--wb-accent)";

/** 收起时标题右边的一句。 */
export function outputsSummary(outputs: Outputs): string {
  return outputs.total > 0 ? `${outputs.total} 项` : "还没有";
}

export function OutputsIcon({ count }: { count?: number }) {
  return (
    <>
      <IconFile aria-hidden="true" className="size-[18px] stroke-[1.8]" />
      {count ? (
        <span
          aria-hidden="true"
          className="absolute right-[3px] bottom-1 text-(--wb-muted) text-[10px]"
        >
          {count}
        </span>
      ) : null}
    </>
  );
}

function OutputRow({ output }: { output: SidebarOutput }) {
  const Icon = KIND_ICONS[output.kind];
  const content = (
    <>
      <Icon
        aria-hidden="true"
        className="size-4 shrink-0 stroke-[1.8] text-(--wb-fg2)"
      />
      <span className="min-w-0 truncate">{output.title}</span>
      <em className="ml-auto shrink-0 text-(--wb-muted) text-[12px] not-italic">
        {KIND_LABELS[output.kind]}
      </em>
    </>
  );
  // 附件是下载地址，在新标签页打开；看板这类应用内的页面走路由。
  return output.href.startsWith("/") && !output.href.startsWith("/api/") ? (
    <Link className={ROW} data-output={output.kind} to={output.href}>
      {content}
    </Link>
  ) : (
    <a
      className={ROW}
      data-output={output.kind}
      href={output.href}
      rel="noreferrer"
      target="_blank"
    >
      {content}
    </a>
  );
}

export function OutputsBody({ outputs }: { outputs: Outputs }) {
  if (outputs.items.length === 0)
    return (
      <p className="m-0 text-(--wb-muted) text-[12.5px]">还没有输出内容。</p>
    );
  return (
    <>
      {outputs.items.map((output) => (
        <OutputRow
          key={`${output.kind}:${output.href}:${output.title}`}
          output={output}
        />
      ))}
      {outputs.total > SIDEBAR_OUTPUT_LIMIT ? (
        <Link
          className="mt-1 self-start text-(--wb-muted) text-[12.5px] outline-none hover:text-(--wb-fg2) focus-visible:outline-2 focus-visible:outline-(--wb-accent)"
          to="/tasks"
        >
          查看全部 {outputs.total} 项
        </Link>
      ) : null}
    </>
  );
}
