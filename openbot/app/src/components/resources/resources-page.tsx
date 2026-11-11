/*
 * M5b 第 0 步：从 `routes/_authed/_app/resources.tsx` 剪出的页面主体，原样保留，地址改成重定向（/resources?tab= → /capabilities/* 与 /connections）。
 * 各组在新路由里接这个组件，再按新结构调整其中的链接与文案。
 */
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { KnowledgeScreen } from "@/components/knowledge/knowledge-screen";
import { PageShell } from "@/components/layout/page-shell";
import { MemoryScreen } from "@/components/memory/memory-screen";
import { ConnectorsTab } from "@/components/resources/capability-tabs";
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
  WakerFlowsTab,
} from "@/components/resources/source-tabs";
import { SkillsScreen } from "@/components/skills/skills-screen";

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
 * a second write path.
 *
 * 技能, 知识库 and 信息源与记忆 are the full screens the standalone `/skills`, `/knowledge` and
 * `/memory` pages used to be: those pages were archived into these tabs and their URLs redirect
 * here. `/skills`' own search parameters came with it — `new` (the authoring panel is open) and
 * `edit` (the slug being edited) — and only mean anything on `?tab=skills`.
 */
export type ResourcesSearch = PluginsSearch & {
  tab?: ResourceTab;
  /** 技能: the authoring panel is open. */
  new?: true;
  /** 技能: the slug being edited. */
  edit?: string;
};

export function resourcesSearch(search: Record<string, unknown>): ResourcesSearch {
  const page = Number(search.page);
  // A numeric slug arrives as a number: the default search parser reads `?edit=42` as JSON.
  const edit =
    typeof search.edit === "number" ? String(search.edit) : search.edit;
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
    ...(search.new === true || search.new === "true"
      ? { new: true as const }
      : {}),
    ...(typeof edit === "string" && edit ? { edit } : {}),
  };
}


export function ResourcesPage({
  search: rawSearch,
}: {
  search: Record<string, unknown>;
}) {
  /*
   * Read through the validator again: a route's search is merged over its parents', and the root
   * passes the raw query through, so a key this route dropped (`?tab=nope`) still arrives here.
   */
  const search = resourcesSearch(rawSearch);
  const navigate = useNavigate({ from: "/resources" });
  const tab: ResourceTab = search.tab ?? "plugins";

  const patch = (next: ResourcesSearch, options?: { replace?: boolean }) =>
    navigate({
      search: (previous) => resourcesSearch({ ...previous, ...next }),
      replace: options?.replace,
    });

  return (
    <PageShell
      width="workbench"
      description="释放你的员工潜能，解锁更多可能"
      eyebrow="05 RESOURCE CENTER"
      title="能力与资源"
    >
      <ResourceTabs
        onValueChange={(value, change) =>
          // A tab's own filters belong to it: switching starts the next one clean. Arrowing across
          // the nine entries replaces history, so Back leaves the page rather than every tab passed.
          navigate({ replace: change.keyboard, search: { tab: value } })
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

export function TabContent({
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
      return (
        <SkillsScreen
          {...searchProps}
          creating={search.new === true}
          editing={search.edit}
          // Opening and closing the panel are navigations, so Back undoes them, as on the old page.
          onClose={() => onSearch({ new: undefined, edit: undefined })}
          onCompose={() => onSearch({ new: true, edit: undefined })}
          onEdit={(slug) => onSearch({ new: undefined, edit: slug })}
        />
      );
    case "connectors":
      return <ConnectorsTab {...searchProps} />;
    case "knowledge":
      return <KnowledgeScreen {...searchProps} />;
    case "wakerflows":
      return <WakerFlowsTab {...searchProps} />;
    case "projects":
      return <ProjectsSection />;
    case "models":
      return <ModelsTab />;
    case "components":
      return <ComponentsTab {...searchProps} />;
    case "sources":
      return <MemoryScreen {...searchProps} />;
  }
}
