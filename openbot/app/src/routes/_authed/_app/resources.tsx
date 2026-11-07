import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell } from "@/components/layout/page-shell";
import {
  ConnectorsTab,
  SkillsTab,
} from "@/components/resources/capability-tabs";
import { ModelsTab } from "@/components/resources/model-zones";
import {
  type PluginsSearch,
  PluginsTab,
} from "@/components/resources/plugins-tab";
import { ProjectsSection } from "@/components/resources/projects-section";
import {
  isResourceTab,
  ResourceTabs,
  type ResourceTab,
  resourcePanelId,
  resourceTabId,
} from "@/components/resources/resource-tabs";
import {
  ComponentsTab,
  KnowledgeTab,
  SourcesTab,
  WakerFlowsTab,
} from "@/components/resources/source-tabs";

/**
 * The one screen holding everything a coworker can be assembled from.
 *
 * QoderWake's "能力与资源" is a row of six entries over one shell — 插件 · 技能 · 连接器 · 知识库 ·
 * WakerFlow · 公开项目 — and this fork adds its own after them: the model library (the thing its
 * employees differ by), components, and synced sources with memory (parity plan F4).
 *
 * The selected entry is `?tab=`, absent meaning 插件, so a reload, Back or a shared link keeps it and
 * every older link to `/resources` still opens the screen. Only the selected tab is mounted, so only
 * its reads are made. Every tab is an aggregate of an endpoint that already exists; nothing here is
 * a second write path: the model library is the one thing a person fully owns, and the tabs they do
 * not are a list plus the way to the screen that decides.
 */
export type ResourcesSearch = PluginsSearch & { tab?: ResourceTab };

function resourcesSearch(search: Record<string, unknown>): ResourcesSearch {
  const page = Number(search.page);
  return {
    ...(isResourceTab(search.tab) ? { tab: search.tab } : {}),
    ...(search.view === "market" || search.view === "mine"
      ? { view: search.view }
      : {}),
    ...(typeof search.category === "string" && search.category
      ? { category: search.category }
      : {}),
    ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    ...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
  };
}

export const Route = createFileRoute("/_authed/_app/resources")({
  validateSearch: resourcesSearch,
  component: ResourcesPage,
});

function ResourcesPage() {
  /*
   * Read through the validator again: a route's search is merged over its parents', and the root
   * passes the raw query through, so a key this route dropped (`?tab=nope`) still arrives here.
   */
  const search = resourcesSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const tab: ResourceTab = search.tab ?? "plugins";

  const patch = (next: ResourcesSearch, options?: { replace?: boolean }) =>
    navigate({
      search: (previous) => resourcesSearch({ ...previous, ...next }),
      replace: options?.replace,
    });

  return (
    <PageShell
      width="workbench"
      description="你的员工能被赋予的东西：它们用的插件、技能与连接器，它们读取的知识，它们执行的流程与项目，以及它们用来回答的模型。"
      title="能力与资源"
    >
      <ResourceTabs
        onValueChange={(value) =>
          // A tab's own filters belong to it: switching starts the next one clean.
          navigate({ search: { tab: value } })
        }
        value={tab}
      />
      <div
        aria-labelledby={resourceTabId(tab)}
        className="outline-none"
        id={resourcePanelId(tab)}
        role="tabpanel"
      >
        <TabContent
          // Remounted per tab, so a search typed in one tab is not carried into the next.
          key={tab}
          onSearch={patch}
          search={search}
          tab={tab}
        />
      </div>
    </PageShell>
  );
}

function TabContent({
  tab,
  search,
  onSearch,
}: {
  tab: ResourceTab;
  search: ResourcesSearch;
  onSearch: (next: ResourcesSearch, options?: { replace?: boolean }) => void;
}) {
  const [query, setQuery] = useState(search.q ?? "");
  const searchProps = {
    query,
    onQuery: (value: string) => {
      setQuery(value);
      onSearch({ q: value || undefined }, { replace: true });
    },
  };
  switch (tab) {
    case "plugins":
      return <PluginsTab onSearch={onSearch} search={search} />;
    case "skills":
      return <SkillsTab {...searchProps} />;
    case "connectors":
      return <ConnectorsTab {...searchProps} />;
    case "knowledge":
      return <KnowledgeTab {...searchProps} />;
    case "wakerflows":
      return <WakerFlowsTab {...searchProps} />;
    case "projects":
      return <ProjectsSection />;
    case "models":
      return <ModelsTab />;
    case "components":
      return <ComponentsTab {...searchProps} />;
    case "sources":
      return <SourcesTab {...searchProps} />;
  }
}
