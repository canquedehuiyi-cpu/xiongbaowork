import {
  IconChevronRight,
  IconPlus,
  IconTargetArrow,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { statusWord } from "@/components/autonomous/work-bits";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { responsibilitiesQueryOptions } from "@/lib/responsibilities";

/**
 * 长期职责 as a section of a skin's screen: one row per responsibility, saying where it stands, each
 * opening this fork's own 长期职责 page, where it is worded, triggered, paused and completed. Given an
 * employee, only that employee's, and the page opens narrowed to it (`?agent=`).
 *
 * Upstream's skins draw its own responsibilities list with its dialogs in place. This fork's page is
 * a different design (its triggers, GitHub bindings and runs), so the skins link to it rather than
 * carrying a second editor.
 */
// M4: 待接入 上游 components/responsibilities/*（在皮肤里就地新建、编辑长期职责的对话框）；目前链到 /responsibilities（带员工筛选）。
export function BotResponsibilities({ agentId }: { agentId?: string }) {
  const goals = useQuery(responsibilitiesQueryOptions());
  const shown = (goals.data ?? []).filter(
    (goal) => agentId === undefined || goal.agentId === agentId,
  );
  const page = (
    <Link search={agentId ? { agent: agentId } : {}} to="/responsibilities" />
  );
  const add = (
    <Button render={page} size="sm" variant="ghost">
      <IconPlus />
      新建长期职责
    </Button>
  );
  return (
    <PageSection action={add} title="长期职责">
      {goals.isPending ? null : goals.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {goals.error.message}
        </p>
      ) : shown.length === 0 ? (
        <PageEmpty icon={IconTargetArrow} title="还没有长期职责">
          {agentId
            ? "交给这位员工持续去做的事会出现在这里。"
            : "交给员工持续去做的事会出现在这里。"}
        </PageEmpty>
      ) : (
        <PageRows>
          {shown.map((goal, index) => (
            <Fragment key={goal.id}>
              {index > 0 ? <Separator /> : null}
              <Item render={page} size="sm">
                <ItemMedia variant="icon">
                  <IconTargetArrow />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{goal.title}</ItemTitle>
                  <ItemDescription>
                    {[statusWord(goal.status), goal.progress]
                      .filter(Boolean)
                      .join(" · ")}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}
