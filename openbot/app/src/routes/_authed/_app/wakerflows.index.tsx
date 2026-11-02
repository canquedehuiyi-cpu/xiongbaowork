import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageRows, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { wakerFlowsQueryOptions } from "@/lib/wakerflows";

/**
 * The workspace's WakerFlows (spec D10, story WF1): a Flow is a plan a crew of coworkers carries out
 * step by step, written from one sentence and edited before it is saved.
 *
 * Rows open the Flow's own page (`wakerflows.$flowId.tsx`): its plan, 编辑/复用/删除, and its runs.
 */
export const Route = createFileRoute("/_authed/_app/wakerflows/")({
  component: WakerFlowsPage,
});

function NewButton() {
  return (
    <Button
      render={(props) => <Link search={{}} to="/wakerflows/new" {...props} />}
      size="sm"
    >
      <IconPlus />
      新建
    </Button>
  );
}

function WakerFlowsPage() {
  const flows = useQuery(wakerFlowsQueryOptions());
  const rows = flows.data ?? [];

  return (
    <PageShell
      action={rows.length > 0 ? <NewButton /> : null}
      backButton={{ label: "能力与资源", linkProps: { to: "/resources" } }}
      description="用一句话描述想要的流程，生成由多位员工分步执行的计划，修改并保存后即可运行。"
      title="WakerFlow"
    >
      {flows.isPending ? (
        <div className="mt-8 flex flex-col gap-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14 w-2/3" />
        </div>
      ) : flows.error ? (
        <p className="mt-8 text-destructive text-sm" role="alert">
          {flows.error.message}
        </p>
      ) : rows.length === 0 ? (
        <Empty className="mt-8 h-[200px] border border-dashed">
          <EmptyHeader>
            <EmptyTitle>还没有 WakerFlow</EmptyTitle>
            <EmptyDescription>
              说出你想要的流程，比如周会准备或工作周报，熊宝会帮你生成一份可编辑的计划。
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <NewButton />
          </EmptyContent>
        </Empty>
      ) : (
        <PageRows>
          {rows.map((flow) => (
            <Item key={flow.id} variant="muted">
              <ItemContent>
                <ItemTitle>{flow.name}</ItemTitle>
                <ItemDescription>
                  {flow.status === "ready" ? "已保存，可以运行" : "草稿"}
                  {flow.plan ? ` · ${flow.plan.steps.length} 个步骤` : ""}
                  {flow.description ? ` · ${flow.description}` : ""}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  render={(props) => (
                    <Link
                      params={{ flowId: flow.id }}
                      to="/wakerflows/$flowId"
                      {...props}
                    />
                  )}
                  size="sm"
                  variant="outline"
                >
                  查看
                </Button>
              </ItemActions>
            </Item>
          ))}
        </PageRows>
      )}
    </PageShell>
  );
}
