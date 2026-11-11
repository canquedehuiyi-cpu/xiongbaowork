import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AutomationForm } from "@/components/automations/automation-form";
import { SecretOnce } from "@/components/automations/automations-section";
import { PANEL } from "@/components/autonomous/work-bits";
import { SegmentedTabs } from "@/components/layout/segmented-tabs";
import { Button, buttonVariants } from "@/components/ui/button";
import type { CreatedAutomation } from "@/lib/automations/queries";
import { TRIGGER_TYPE_LABEL, type TriggerType } from "@/lib/autonomous/unified";
import { cn } from "@/lib/utils";

const TABS = (["schedule", "event", "api"] as const).map((value) => ({
  value,
  label: TRIGGER_TYPE_LABEL[value],
}));

/**
 * 新建自动任务, opened from the page's primary action: first how it starts, then the existing form.
 *
 * 定时 and API are the automation contract's own trigger kinds (定期 / 一次性, and the Hook / API
 * entry), so both open `AutomationForm` with that kind chosen; who carries it out — an employee or a
 * saved WakerFlow — is chosen inside it, where a deployment without the WakerFlow executor shows
 * that option disabled with its reason. 事件 has no automation trigger kind: the store accepts only
 * `schedule | once | webhook`. What does exist for events is a 长期职责 subscribed to an event source,
 * so the panel says that and links there rather than offering a form that would be refused.
 */
export function CreateAutomationPanel({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<TriggerType>("schedule");
  const [created, setCreated] = useState<CreatedAutomation | null>(null);
  const secrets = (created?.triggers ?? []).flatMap(({ trigger, secret }) =>
    secret ? [{ triggerId: trigger.id, secret }] : [],
  );

  return (
    <section
      aria-label="新建"
      className={cn(
        PANEL,
        "mt-[5px] mb-[22px] flex flex-col gap-3 rounded-[18px] p-[16px]",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-[13px] text-muted-foreground">触发类型</span>
          <SegmentedTabs
            label="触发类型"
            onValueChange={setKind}
            tabs={TABS}
            value={kind}
          />
        </div>
        <Button onClick={onClose} size="sm" variant="ghost">
          收起
        </Button>
      </div>

      {created ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">「{created.automation.name}」已建立。</p>
          {secrets.map((entry) => (
            <SecretOnce
              key={entry.triggerId}
              onDismiss={() =>
                setCreated((current) =>
                  current
                    ? {
                        ...current,
                        triggers: current.triggers.filter(
                          (item) => item.trigger.id !== entry.triggerId,
                        ),
                      }
                    : current,
                )
              }
              secret={entry.secret}
              triggerId={entry.triggerId}
            />
          ))}
          <div>
            <Button onClick={onClose} size="sm" variant="outline">
              完成
            </Button>
          </div>
        </div>
      ) : kind === "event" ? (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-muted-foreground">
            自动任务暂不支持按内部事件触发（如收到消息、任务状态变化），也不能让
            Flow 由事件启动。外部系统的事件可以推送到「API」触发方式的 Hook
            地址；要让一位员工持续盯着
            GitHub、Slack、邮件等事件源，请新建一条长期职责。
          </p>
          <div>
            <Link
              className={cn(
                buttonVariants({ variant: "outline" }),
                "h-[32px] px-3 text-[13px]",
              )}
              to="/responsibilities"
            >
              去长期职责新建
            </Link>
          </div>
        </div>
      ) : (
        <AutomationForm
          initialTriggerKind={kind === "api" ? "webhook" : "schedule"}
          key={kind}
          onCreated={(result) => {
            if (result.triggers.some((entry) => entry.secret)) {
              setCreated(result);
              return;
            }
            onClose();
          }}
        />
      )}
    </section>
  );
}
