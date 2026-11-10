import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { MemoryScreen } from "@/components/memory/memory-screen";
import { RoutinesList } from "@/components/routines/routines-list";
import {
  deploymentCapabilitiesQueryOptions,
  offersMemory,
} from "@/lib/deployment/queries";

/**
 * OpenDots' workspace page: a small eyebrow, a large quiet title and one line under it, with the
 * page's primary action on the title's right. What sits beneath is OpenBot's own list, so every
 * switch, Run now, history and delete OpenBot offers is still there.
 */
function OpenDotsPage({
  eyebrow = "你的工作区",
  title,
  description,
  action,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-opendots-page>
      <div className="mx-auto w-full max-w-[1090px] px-[54px] pt-16 pb-9 max-[1150px]:px-8 max-[1150px]:pt-[45px] max-md:px-[22px] max-md:pt-[38px]">
        <header className="mb-[35px] flex items-center justify-between gap-[25px] max-[920px]:items-start max-md:flex-col max-md:items-stretch">
          <div className="min-w-0">
            <span className="text-[10px] font-semibold tracking-[1.5px] text-(--opendots-eyebrow)">
              {eyebrow}
            </span>
            <h1 className="mt-3.5 mb-2 text-[34px] leading-tight font-[550] tracking-[-0.04em] text-foreground max-[920px]:text-[30px]">
              {title}
            </h1>
            <p className="text-[12px] leading-[1.7] text-(--opendots-note)">
              {description}
            </p>
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </header>
        {children}
      </div>
    </div>
  );
}

/** Routines: what each Bot does on a schedule, as OpenBot's routines list. */
export function RoutinesScreen() {
  return (
    <OpenDotsPage
      description="员工按时间表做的事。让员工帮你设一个；在这里可以暂停、运行或删除。"
      title="定时任务"
    >
      <RoutinesList embedded />
    </OpenDotsPage>
  );
}

/**
 * "Memories": what the person's Bots know about them, as this fork's 信息源与记忆 screen (the same
 * one 能力与资源 shows), which holds both remembering a fact and the list. Home where memory isn't
 * offered, as the screen route does for a screen this skin doesn't have (see `offersMemory`).
 */
export function MemoriesScreen() {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const [query, setQuery] = useState("");
  if (capabilities.isPending) return null;
  if (!offersMemory(capabilities.data)) return <Navigate replace to="/" />;
  return (
    <OpenDotsPage description="员工记得的关于你的事。" title="记忆">
      <MemoryScreen onQuery={setQuery} query={query} />
    </OpenDotsPage>
  );
}
