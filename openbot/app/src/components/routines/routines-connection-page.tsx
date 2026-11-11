import { IconChevronRight, IconClock } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { NewRoutineButton } from "./new-routine-button";

/** 「还没有定时任务。」「1 条定时任务，开着。」「3 条定时任务，2 条开着。」 */
function routinesSummary(
  routines: { enabled: boolean }[] | undefined,
): string | null {
  if (!routines) return null;
  if (routines.length === 0) return "还没有定时任务。";
  const on = routines.filter((routine) => routine.enabled).length;
  const count = `${routines.length} 条定时任务`;
  if (routines.length === 1) return `${count}，${on === 1 ? "开着" : "关着"}。`;
  return `${count}，${on} 条开着。`;
}

/**
 * Connections > Routines: what Routines is, and the way to the Routines page.
 *
 * Routines is listed among the apps because it is one to a Bot: the tools a Bot calls to set up,
 * change and stop a routine. There is nothing to connect or switch, since every Bot has it in every
 * edition, so a person who opens it wants their routines, and this page sends them there.
 */
export function RoutinesConnectionPage() {
  const routines = useQuery(routinesQueryOptions());
  const summary = routinesSummary(routines.data?.routines);
  return (
    <PageShell
      action={<NewRoutineButton />}
      backButton={{ label: "全部连接", linkProps: { to: "/connections" } }}
      description="定时任务是员工按计划去做的事。每位员工都能帮你设一条。"
      title="定时任务"
    >
      {/* One destination, so no heading: it would only repeat the row's own title. */}
      <PageSection>
        <PageRows className="mt-0">
          {/* 定时任务的列表在「自主工作」里（`/routines` 也转到那里）。 */}
          <Item
            render={<Link search={{ trigger: "schedule" }} to="/autonomous" />}
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconClock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>你的定时任务</ItemTitle>
              <ItemDescription>
                {routines.error
                  ? "在「自主工作」里查看。"
                  : (summary ?? "在「自主工作」里查看。")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
