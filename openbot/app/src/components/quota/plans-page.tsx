/*
 * 套餐与用量（M5b：原 `routes/_authed/_app/plans.tsx` 的页面主体，挂在设置里的 `/settings/plans`；
 * `/plans` 重定向到这里，服务端 `upgradeUrl` 的契约不断）。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StatusBadge } from "@/components/admin/admin-kit";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { UsageMeter } from "@/components/plans/usage-meter";
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { switchPlanMutationOptions } from "@/lib/quota/mutations";
import {
  meter,
  quotaQueryOptions,
  TOKEN_SCOPE_CAPTION,
  tiersQueryOptions,
  tokenReadout,
} from "@/lib/quota/queries";
import { cn } from "@/lib/utils";

/** The graphite panel these sections draw in (docs/design/ios-studio). */
const PANEL =
  "rounded-[14px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]";

/**
 * The tier list, the current one, and the switch (spec K3).
 *
 * No checkout: this deployment takes no payment, so the page says "switch" and moves the subscription
 * row. Naming that plainly matters, because a person who expects a payment flow and finds none assumes
 * the product is broken rather than that it is deliberately not selling anything yet.
 *
 * The switch is a platform administrator's: the server refuses everybody else with a 403, so the page
 * shows them the tiers without a button that could only fail.
 */
export function PlansPage() {
  const queryClient = useQueryClient();
  const quota = useQuery(quotaQueryOptions());
  const tiers = useQuery(tiersQueryOptions());
  const switchPlan = useMutation(switchPlanMutationOptions(queryClient));
  const isAdmin = useQuery(currentUserQueryOptions()).data?.role === "admin";
  const [problem, setProblem] = useState<string | null>(null);

  const current = quota.data?.plan?.id;
  const usage = quota.data?.usage;
  const tokens = quota.data?.tokens;

  return (
    <PageShell
      description="每个套餐允许什么、这个月已经用了多少，以及它们之间怎么切换。这里不收钱：套餐由平台管理员切换，对这个工作空间立刻生效。"
      title="套餐"
      width="workbench"
    >
      <PageSection className="mt-6" title="本工作空间">
        {quota.isPending ? (
          <p className="mt-2 text-muted-foreground text-sm" role="status">
            正在读取套餐与用量…
          </p>
        ) : quota.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {quota.error.message}
          </p>
        ) : quota.data ? (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
            {quota.data.plan ? (
              <>
                <StatusBadge tone="positive">
                  {quota.data.plan.name}
                </StatusBadge>
                {`当前套餐：${quota.data.plan.name}。用量按 ${quota.data.usage.period} 统计。`}
              </>
            ) : (
              "这个工作空间还没有订阅，所以什么都不限。"
            )}
          </p>
        ) : null}
        {usage && quota.data?.limits ? (
          <div className={cn("mt-4 overflow-hidden", PANEL)}>
            <div className="grid grid-cols-1 divide-y divide-border md:grid-cols-2 md:divide-y-0 [&>*]:border-border md:[&>*:nth-child(n+3)]:border-t md:[&>*:nth-child(even)]:border-l">
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
                <UsageMeter key={label} label={label} value={value} />
              ))}
            </div>
            {tokens ? (
              <div className="flex flex-col gap-1 border-border border-t px-4 py-[13px]">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="font-medium text-[13px]">
                    本月模型 token
                  </span>
                  <span className="text-[12px] text-muted-foreground tabular-nums">
                    {tokenReadout(tokens)}
                  </span>
                </div>
                <p className="text-[12px] text-faint">{TOKEN_SCOPE_CAPTION}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </PageSection>

      <PageSection className="mt-10" title="全部套餐">
        {tiers.isPending ? (
          <p className="mt-2 text-muted-foreground text-sm" role="status">
            正在读取套餐…
          </p>
        ) : tiers.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {tiers.error.message}
          </p>
        ) : (tiers.data?.plans ?? []).length === 0 ? (
          <p className="mt-2 text-muted-foreground text-sm">
            这个部署还没有配置套餐。
          </p>
        ) : (
          <ul
            aria-label="全部套餐"
            className="mt-4 grid grid-cols-1 gap-[11px] sm:grid-cols-2 xl:grid-cols-3"
          >
            {(tiers.data?.plans ?? []).map((tier) => {
              const isCurrent = tier.id === current;
              return (
                <li
                  className={cn(
                    "relative flex min-w-0 flex-col gap-4 overflow-hidden p-[17px]",
                    PANEL,
                  )}
                  key={tier.id}
                >
                  {/* The one selected tier carries the red signal line, as selection does elsewhere. */}
                  {isCurrent ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-0 top-0 h-[2px] bg-signal"
                    />
                  ) : null}
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-bold text-[15px]">
                      {tier.name}
                      {isCurrent ? (
                        <span className="sr-only"> · 当前</span>
                      ) : null}
                    </h3>
                    {isCurrent ? (
                      <span aria-hidden="true">
                        <StatusBadge tone="attention">当前</StatusBadge>
                      </span>
                    ) : null}
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-[6px] text-[13px]">
                    <dt className="text-muted-foreground">员工</dt>
                    <dd className="text-right tabular-nums">
                      {tier.limits.wakers} 位
                    </dd>
                    <dt className="text-muted-foreground">每月任务</dt>
                    <dd className="text-right tabular-nums">
                      {tier.limits.tasksPerMonth} 个
                    </dd>
                    <dt className="text-muted-foreground">机器</dt>
                    <dd className="text-right tabular-nums">
                      {tier.limits.devices} 台
                    </dd>
                    <dt className="text-muted-foreground">模型</dt>
                    <dd className="text-right">
                      {tier.limits.customModels
                        ? "可接入自己的模型"
                        : "只用部署自带的模型"}
                    </dd>
                  </dl>
                  {isAdmin ? (
                    <Button
                      className="mt-auto self-start"
                      disabled={isCurrent || switchPlan.isPending}
                      onClick={() => {
                        setProblem(null);
                        switchPlan.mutate(tier.id, {
                          onError: (thrown: Error) =>
                            setProblem(thrown.message),
                        });
                      }}
                      size="sm"
                      variant={isCurrent ? "outline" : "default"}
                    >
                      {isCurrent
                        ? "使用中"
                        : switchPlan.isPending &&
                            switchPlan.variables === tier.id
                          ? "正在切换…"
                          : "切换"}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {isAdmin ? null : (
          <p className="mt-4 text-muted-foreground text-sm">
            套餐由平台管理员调整。需要切换时，请联系管理员。
          </p>
        )}
        {problem ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {problem}
          </p>
        ) : null}
        <p className="mt-4 max-w-[70ch] text-[12px] text-faint leading-relaxed">
          已经计过量的用量不会因为切换而退还：一个月里用掉三次任务，升级之后仍然显示三次——抬高的是
          上限，不是把计量表清零。
        </p>
      </PageSection>
    </PageShell>
  );
}
