import { IconBook, IconPlus } from "@tabler/icons-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { componentDisplayTitle } from "@/lib/components/display-title";
import { componentListQueryOptions } from "@/lib/components/queries";
import {
  knowledgeNotebookQueryOptions,
  knowledgeNotebooksQueryOptions,
} from "@/lib/knowledge/queries";
import { memorySourcesQueryOptions } from "@/lib/memory";
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
 * Story E1's knowledge, as its own tab: the person's knowledge bases (D08 RES1).
 *
 * 已授权 N 位员工 is the number of distinct Wakers bound to a base, read from each base's detail —
 * the list endpoint carries no bindings. One base's detail failing says so on that card; the list
 * failing is the tab's alert. The memory sources that used to sit under the bases are this fork's
 * own entry, 信息源与记忆.
 */
export function KnowledgeTab({ query, onQuery }: SearchProps) {
  const notebooks = useQuery(knowledgeNotebooksQueryOptions());
  const bases = notebooks.data ?? [];
  const details = useQueries({
    queries: bases.map((notebook) =>
      knowledgeNotebookQueryOptions(notebook.id),
    ),
  });
  const visible = bases
    .map((notebook, index) => ({ notebook, index }))
    .filter(({ notebook }) => textMatch(query, notebook.title));

  const boundSentence = (index: number): string => {
    const detail = details[index];
    if (!detail || detail.isPending) return "正在读取授权…";
    if (detail.error || !detail.data) return "读不到授权";
    const count = new Set(
      detail.data.bindings.map((binding) => binding.agentId),
    ).size;
    return count > 0 ? `已授权 ${count} 位员工` : "尚未授权任何员工";
  };

  return (
    <>
      <TabHeader
        actions={
          <Button
            render={(props) => <Link to="/knowledge" {...props} />}
            size="sm"
            variant="outline"
          >
            <IconBook />
            打开知识库页
          </Button>
        }
        description="你整理好、授权给员工去读的知识库。建库、加资料和授权都在知识库页里做。"
        search={
          <TabSearch label="搜索知识库" onChange={onQuery} value={query} />
        }
      />
      <QueryState label="读不到知识库" query={notebooks}>
        {bases.length === 0 ? (
          <TabEmpty
            action={
              <Button
                render={(props) => <Link to="/knowledge" {...props} />}
                size="sm"
              >
                <IconPlus />
                去建一个
              </Button>
            }
            description="在知识库页里建一个，再授权给员工。"
            title="还没有知识库"
          />
        ) : visible.length === 0 ? (
          <NoMatch onClear={() => onQuery("")} title="没有匹配的知识库" />
        ) : (
          <CardGrid className="mt-4" label="知识库列表">
            {visible.map(({ notebook, index }) => (
              <ResourceCard
                actions={
                  <span className="text-[12px] text-muted-foreground">
                    {boundSentence(index)}
                  </span>
                }
                key={notebook.id}
                media={
                  <span className="flex size-[32px] items-center justify-center rounded-md bg-muted">
                    <IconBook className="size-4" />
                  </span>
                }
                title={notebook.title}
              />
            ))}
          </CardGrid>
        )}
      </QueryState>
    </>
  );
}

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

/** This fork's own entry: the sources synced in for employees to fetch from, and their memory. */
export function SourcesTab({ query, onQuery }: SearchProps) {
  const sources = useQuery(memorySourcesQueryOptions());
  const rows = sources.data ?? [];
  const visible = rows.filter((source) => textMatch(query, source.title));
  return (
    <>
      <TabHeader
        actions={
          <Button
            render={(props) => <Link to="/memory" {...props} />}
            size="sm"
            variant="outline"
          >
            去管理
          </Button>
        }
        description="同步过来让员工主动去拿的来源，以及别人告诉它并留下来的记忆。"
        search={
          <TabSearch label="搜索信息源" onChange={onQuery} value={query} />
        }
      />
      <QueryState label="读不到信息源" query={sources}>
        {rows.length === 0 ? (
          <TabEmpty title="还没有接入信息源" />
        ) : visible.length === 0 ? (
          <NoMatch onClear={() => onQuery("")} title="没有匹配的信息源" />
        ) : (
          <CardGrid className="mt-4" label="信息源列表">
            {visible.map((source) => (
              <ResourceCard
                description={
                  <>
                    {source.enabled
                      ? `同步状态 ${source.syncStatus}`
                      : "已暂停"}
                    {source.lastSyncAt ? ` · 上次 ${source.lastSyncAt}` : ""}
                  </>
                }
                key={source.id}
                title={source.title}
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
