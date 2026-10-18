import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { switchPlanMutationOptions } from "@/lib/quota/mutations";
import {
  meter,
  quotaQueryOptions,
  tiersQueryOptions,
} from "@/lib/quota/queries";

export const Route = createFileRoute("/_authed/_app/plans")({
  component: RouteComponent,
});

/**
 * The tier list, the current one, and the switch (spec K3).
 *
 * No checkout: this deployment takes no payment, so the page says "switch" and moves the subscription
 * row. Naming that plainly matters, because a person who expects a payment flow and finds none assumes
 * the product is broken rather than that it is deliberately not selling anything yet.
 */
function RouteComponent() {
  const queryClient = useQueryClient();
  const quota = useQuery(quotaQueryOptions());
  const tiers = useQuery(tiersQueryOptions());
  const switchPlan = useMutation(switchPlanMutationOptions(queryClient));
  const [problem, setProblem] = useState<string | null>(null);

  const current = quota.data?.plan?.id;
  const usage = quota.data?.usage;

  return (
    <PageShell
      description="每个套餐允许什么、这个月已经用了多少，以及它们之间怎么切换。这里不收钱：选一个档，对这个工作空间立刻生效。"
      title="套餐"
    >
      <PageSection title="本工作空间">
        {quota.isPending || !quota.data ? null : (
          <p className="text-muted-foreground text-sm">
            {quota.data.plan
              ? `当前套餐：${quota.data.plan.name}。用量按 ${quota.data.usage.period} 统计。`
              : "这个工作空间还没有订阅，所以什么都不限。"}
          </p>
        )}
        {usage && quota.data?.limits ? (
          <PageRows>
            {(
              [
                ["员工", meter(usage.wakers, quota.data.limits.wakers)],
                [
                  "本月任务",
                  meter(usage.tasks, quota.data.limits.tasksPerMonth),
                ],
                ["设备", meter(usage.devices, quota.data.limits.devices)],
                [
                  "自带模型",
                  meter(
                    usage.models,
                    quota.data.limits.customModels ? null : 0,
                  ),
                ],
              ] as const
            ).map(([label, value]) => (
              <Item key={label} size="sm" variant="outline">
                <ItemContent>
                  <ItemTitle>{label}</ItemTitle>
                  <ItemDescription>
                    已用 {value.used} /{" "}
                    {value.limit === null ? "不限" : value.limit}
                    {value.full ? " · 已到上限" : ""}
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </PageRows>
        ) : null}
      </PageSection>

      <PageSection title="全部套餐">
        <PageRows>
          {(tiers.data?.plans ?? []).map((tier) => (
            <Item key={tier.id} size="sm" variant="outline">
              <ItemContent>
                <ItemTitle>
                  {tier.name}
                  {tier.id === current ? " · 当前" : ""}
                </ItemTitle>
                <ItemDescription>
                  {tier.limits.wakers} 位员工 · 每月 {tier.limits.tasksPerMonth}{" "}
                  个任务 · {tier.limits.devices} 台机器 ·{" "}
                  {tier.limits.customModels
                    ? "可接入自己的模型"
                    : "只用部署自带的模型"}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  disabled={tier.id === current || switchPlan.isPending}
                  onClick={() => {
                    setProblem(null);
                    switchPlan.mutate(tier.id, {
                      onError: (thrown: Error) => setProblem(thrown.message),
                    });
                  }}
                  size="sm"
                  variant={tier.id === current ? "outline" : "default"}
                >
                  {tier.id === current ? "使用中" : "切换"}
                </Button>
              </ItemActions>
            </Item>
          ))}
        </PageRows>
        {problem ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {problem}
          </p>
        ) : null}
        <p className="mt-4 text-muted-foreground text-xs">
          已经计过量的用量不会因为切换而退还：一个月里用掉三次任务，升级之后仍然显示三次——抬高的是
          上限，不是把计量表清零。
        </p>
      </PageSection>
    </PageShell>
  );
}
