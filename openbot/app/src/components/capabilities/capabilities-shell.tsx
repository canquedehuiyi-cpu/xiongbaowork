import { useQuery } from "@tanstack/react-query";
import { linkOptions } from "@tanstack/react-router";
import type * as React from "react";
import { PageShell } from "@/components/layout/page-shell";
import {
  ALL_CAPABILITY_TABS,
  CapabilityTabs,
  useCurrentCapabilityTab,
} from "@/components/resources/resource-tabs";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * 能力：员工除了你给它连的应用之外还能用的东西——插件、技能、知识库、WakerFlow、公开项目、模型库、组件、
 * 记忆与信息源、角色模板。连接（员工以你的身份去碰的应用，以及员工可用的连接器）是自己的一页。
 *
 * 结构照上游 main（`/capabilities/*`，每个页签一个子路由，各自画这个外壳），页签照熊宝原来「能力与资源」
 * 的九个入口和「资源入口」画法（`components/resources/resource-tabs.tsx`）。
 *
 * 外壳由每个页签自己画、而不是 `/capabilities` 布局路由画一次，因为技能页把整块内容放在写技能、改技能的侧边
 * 面板里；布局路由画的标题会落在面板外面。
 */
export function CapabilitiesShell({ children }: { children: React.ReactNode }) {
  const current = useCurrentCapabilityTab();
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  /*
   * 个人版没有「能力」页：技能从员工页打开，所以标题就是这一页自己的名字，返回员工页，不画页签（页签指向的页
   * 不在个人版的菜单里）。个人版也没有记忆，那个路由在画这里之前就把它送回员工页了（见 `offersMemory`）。
   */
  if (personal) {
    const tab = current ?? ALL_CAPABILITY_TABS[1];
    return (
      <PageShell
        backButton={{ label: "员工", linkProps: linkOptions({ to: "/bots" }) }}
        className="@container"
        title={tab?.label ?? "技能"}
      >
        {children}
      </PageShell>
    );
  }
  return (
    <PageShell
      className="@container"
      description="释放你的员工潜能，解锁更多可能"
      eyebrow="05 RESOURCE CENTER"
      title="能力"
      width="workbench"
    >
      <CapabilityTabs />
      <section
        aria-label={current?.label}
        className="outline-none"
        data-slot="capability-panel"
      >
        {children}
      </section>
    </PageShell>
  );
}
