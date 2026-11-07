import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { componentDisplayTitle } from "@/lib/components/display-title";
import { componentListQueryOptions } from "@/lib/components/queries";
import { wakerFlowsQueryOptions } from "@/lib/wakerflows";
import { ResourceCard, textMatch } from "./capability-tabs";
import {
  CardGrid,
  NoMatch,
  QueryState,
  TabEmpty,
  TabHeader,
  TabSearch,
  Tag,
} from "./resource-kit";

type SearchProps = { query: string; onQuery: (value: string) => void };

/**
 * 能力与资源 › WakerFlow: the workspace's Flows as cards, with the way to the standalone page
 * (`/wakerflows`, story WF1) where they are written, edited and run.
 */
export function WakerFlowsTab({ query, onQuery }: SearchProps) {
  const flows = useQuery(wakerFlowsQueryOptions());
  const rows = flows.data ?? [];
  const visible = rows.filter((flow) =>
    textMatch(query, flow.name, flow.description),
  );
  const newButton = (
    <Button
      render={(props) => <Link search={{}} to="/wakerflows/new" {...props} />}
      size="sm"
    >
      <IconPlus />
      新建
    </Button>
  );
  return (
    <>
      <TabHeader
        actions={
          <>
            {rows.length > 0 ? newButton : null}
            <Button
              render={(props) => <Link to="/wakerflows" {...props} />}
              size="sm"
              variant="outline"
            >
              打开 WakerFlow 页
            </Button>
          </>
        }
        description="用一句话描述想要的流程，生成由多位员工分步执行、可以修改保存的计划。"
        search={
          <TabSearch label="搜索 WakerFlow" onChange={onQuery} value={query} />
        }
      />
      <QueryState label="读不到 WakerFlow" query={flows}>
        {rows.length === 0 ? (
          <TabEmpty
            action={newButton}
            description="说出你想要的流程，比如周会准备或工作周报，熊宝会帮你生成一份可编辑的计划。"
            title="还没有 WakerFlow"
          />
        ) : visible.length === 0 ? (
          <NoMatch onClear={() => onQuery("")} title="没有匹配的 WakerFlow" />
        ) : (
          <CardGrid className="mt-4" label="WakerFlow 列表">
            {visible.map((flow) => (
              <ResourceCard
                actions={
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
                }
                description={flow.description || undefined}
                key={flow.id}
                meta={
                  flow.plan ? `${flow.plan.steps.length} 个步骤` : undefined
                }
                title={
                  <>
                    {flow.name}
                    <Tag tone={flow.status === "ready" ? "positive" : "muted"}>
                      {flow.status === "ready" ? "可运行" : "草稿"}
                    </Tag>
                  </>
                }
              />
            ))}
          </CardGrid>
        )}
      </QueryState>
    </>
  );
}

/** This fork's own entry: the interfaces employees give rather than describe. */
export function ComponentsTab({ query, onQuery }: SearchProps) {
  const components = useQuery(componentListQueryOptions());
  const rows = components.data ?? [];
  const visible = rows.filter((component) =>
    textMatch(query, componentDisplayTitle(component), component.name),
  );
  return (
    <>
      <TabHeader
        description="员工可以直接给出、而不是用文字描述的界面。发布与授予在管理员的组件页里做。"
        search={<TabSearch label="搜索组件" onChange={onQuery} value={query} />}
      />
      <QueryState label="读不到组件" query={components}>
        {rows.length === 0 ? (
          <TabEmpty title="还没有组件" />
        ) : visible.length === 0 ? (
          <NoMatch onClear={() => onQuery("")} title="没有匹配的组件" />
        ) : (
          <CardGrid className="mt-4" label="组件列表">
            {visible.map((component) => (
              <ResourceCard
                description={
                  component.published ? "已发布" : "草稿——没有提供给任何员工"
                }
                key={component.name}
                title={componentDisplayTitle(component)}
              />
            ))}
          </CardGrid>
        )}
      </QueryState>
    </>
  );
}
