import type { QueryClient } from "@tanstack/react-query";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { Route as CapabilitiesComponentsRoute } from "@/routes/_authed/_app/capabilities.components";
import { Route as CapabilitiesIndexRoute } from "@/routes/_authed/_app/capabilities.index";
import { Route as CapabilitiesKnowledgeRoute } from "@/routes/_authed/_app/capabilities.knowledge";
import { Route as CapabilitiesMemoryRoute } from "@/routes/_authed/_app/capabilities.memory";
import { Route as CapabilitiesModelsRoute } from "@/routes/_authed/_app/capabilities.models";
import { Route as CapabilitiesPluginsRoute } from "@/routes/_authed/_app/capabilities.plugins";
import { Route as CapabilitiesProjectsRoute } from "@/routes/_authed/_app/capabilities.projects";
import { Route as CapabilitiesRolesRoute } from "@/routes/_authed/_app/capabilities.roles";
import { Route as CapabilitiesSkillsRoute } from "@/routes/_authed/_app/capabilities.skills";
import { Route as CapabilitiesWakerFlowsRoute } from "@/routes/_authed/_app/capabilities.wakerflows";
import { Route as LegacyKnowledgeRoute } from "@/routes/_authed/_app/knowledge";
import { Route as LegacyMemoryRoute } from "@/routes/_authed/_app/memory";
import { Route as LegacyResourcesRoute } from "@/routes/_authed/_app/resources";
import { Route as LegacyRoleTemplatesRoute } from "@/routes/_authed/_app/role-templates";
import { Route as LegacySkillsRoute } from "@/routes/_authed/_app/skills";
import { Route as LegacySettingsMemoryRoute } from "@/routes/_authed/settings/memory";

/**
 * 能力（`/capabilities/*`）的九个页签路由，加上转到它们的旧地址（`/resources?tab=`、`/skills`、`/knowledge`、
 * `/memory`、`/role-templates`、`/settings/memory`），挂在测试自己的根上、用它们在应用里的地址。
 *
 * 文件路由在生成的路由树里挂在 `/_authed/_app` 下面；这里 `as never` 只是为了一次渲染把它们重新挂到根上，
 * 和装配页、员工页的测试一样。页签之间的链接、重定向都是真的，所以点页签、后退、旧地址都能测。
 * 别的页（员工、连接、WakerFlow 独立页）是只写着自己名字的替身。
 */
export function capabilitiesRouter({
  at,
  queryClient,
}: {
  at: string;
  queryClient: QueryClient;
}) {
  const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: () => <Outlet />,
  });
  const mount = (route: unknown, path: string) =>
    (route as { update: (options: unknown) => AnyRoute }).update({
      getParentRoute: () => root,
      path,
    } as never);
  const stub = (path: string, name: string): AnyRoute =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <p>{name}</p>,
    }) as unknown as AnyRoute;

  return createRouter({
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [at] }),
    routeTree: root.addChildren([
      mount(CapabilitiesIndexRoute, "/capabilities"),
      mount(CapabilitiesPluginsRoute, "/capabilities/plugins"),
      mount(CapabilitiesSkillsRoute, "/capabilities/skills"),
      mount(CapabilitiesKnowledgeRoute, "/capabilities/knowledge"),
      mount(CapabilitiesWakerFlowsRoute, "/capabilities/wakerflows"),
      mount(CapabilitiesProjectsRoute, "/capabilities/projects"),
      mount(CapabilitiesModelsRoute, "/capabilities/models"),
      mount(CapabilitiesComponentsRoute, "/capabilities/components"),
      mount(CapabilitiesMemoryRoute, "/capabilities/memory"),
      mount(CapabilitiesRolesRoute, "/capabilities/roles"),
      mount(LegacyResourcesRoute, "/resources"),
      mount(LegacySkillsRoute, "/skills"),
      mount(LegacyKnowledgeRoute, "/knowledge"),
      mount(LegacyMemoryRoute, "/memory"),
      mount(LegacyRoleTemplatesRoute, "/role-templates"),
      mount(LegacySettingsMemoryRoute, "/settings/memory"),
      stub("/bots", "员工页"),
      stub("/connections", "连接页"),
      stub("/wakerflows", "WakerFlow 页"),
    ]),
  });
}
