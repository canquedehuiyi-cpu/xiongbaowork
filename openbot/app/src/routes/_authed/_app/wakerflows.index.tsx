import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  type LinkProps,
  linkOptions,
} from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { WorkbenchEmpty } from "@/components/layout/workbench-empty";
import { TabSkeleton } from "@/components/resources/resource-kit";
import { Button } from "@/components/ui/button";
import { CARD_FACE, StateBadge } from "@/components/wakerflow/flow-ui";
import { wakerFlowsQueryOptions } from "@/lib/wakerflows";

/**
 * The workspace's WakerFlows (spec D10, story WF1): a Flow is a plan a crew of coworkers carries out
 * step by step, written from one sentence and edited before it is saved.
 *
 * Rows open the Flow's own page (`wakerflows.$flowId.tsx`): its plan, 编辑/复用/删除, and its runs.
 */
/*
 * Checked against /resources' own search schema by `linkOptions`, then widened to the shell's
 * `LinkProps` (as `wakersBackLink` does): an inline object literal there is inferred against the
 * union of every route's search and rejects `tab: "wakerflows"`. The widening goes through
 * `unknown` because the validated, route-specific type and the shell's generic one share too little
 * for a direct assertion; `linkOptions` above is what checks the address.
 */
const WAKERFLOWS_TAB = linkOptions({
  to: "/resources",
  search: { tab: "wakerflows" },
}) as unknown as LinkProps;

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
      backButton={{
        label: "能力与资源",
        // Back to the tab this list belongs to, not to 插件, which /resources opens on.
        linkProps: WAKERFLOWS_TAB,
      }}
      description="用一句话描述想要的流程，生成由多位员工分步执行的计划，修改并保存后即可运行。"
      title="WakerFlow"
      width="workbench"
    >
      {flows.isPending ? (
        <TabSkeleton label="正在加载 WakerFlow" />
      ) : flows.error ? (
        <p
          className="rounded-[13px] border border-signal/40 bg-signal-soft px-4 py-3 text-[13px] text-signal-ink"
          role="alert"
        >
          {flows.error.message}
        </p>
      ) : rows.length === 0 ? (
        <WorkbenchEmpty
          action={<NewButton />}
          className="border border-border"
          description="说出你想要的流程，比如周会准备或工作周报，熊宝会帮你生成一份可编辑的计划。"
          title="还没有 WakerFlow"
        />
      ) : (
        /*
         * docs/design/ios-studio: the resource card grid — one column on a phone, two, then three.
         * Each card says the Flow's state in words (a badge), its size and its purpose, and opens it.
         */
        <ul
          aria-label="WakerFlow 列表"
          className="grid grid-cols-1 gap-[9px] min-[441px]:grid-cols-2 xl:grid-cols-3"
        >
          {rows.map((flow) => (
            <li
              className={`${CARD_FACE} flex min-h-[126px] flex-col gap-[8px] p-[14px]`}
              key={flow.id}
            >
              <div className="flex items-start justify-between gap-[10px]">
                <h2 className="min-w-0 truncate font-bold text-[15px] leading-[22px] tracking-[-0.01em]">
                  {flow.name}
                </h2>
                <StateBadge
                  label={flow.status === "ready" ? "已保存，可以运行" : "草稿"}
                  state={flow.status}
                />
              </div>
              <p className="line-clamp-2 min-h-[2lh] text-pretty text-[12.5px] text-muted-foreground leading-[1.6]">
                {flow.description || "没有说明。"}
              </p>
              <div className="mt-auto flex items-center justify-between gap-[10px] border-border border-t pt-[9px]">
                <span className="font-mono text-[11px] text-faint tracking-[0.04em]">
                  {flow.plan ? `${flow.plan.steps.length} 个步骤` : "尚无计划"}
                </span>
                <Button
                  aria-label={`查看「${flow.name}」`}
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
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
