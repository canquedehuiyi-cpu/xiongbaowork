import { IconBolt, IconClock, IconCode } from "@tabler/icons-react";
import type { ReactNode } from "react";
import {
  IconTile,
  PANEL,
  SECTION_TITLE,
} from "@/components/autonomous/work-bits";
import { TRIGGER_TYPE_LABEL, type TriggerType } from "@/lib/autonomous/unified";
import { cn } from "@/lib/utils";

/*
 * The three ways work starts here, keyed by the list's own trigger types, so the names match the
 * 触发类型 filter and the create panel's tabs. Each line says what really starts it in this app:
 * a schedule (定期 / 一次性 automations, 定时任务, 主动巡检), an event (a 长期职责 subscribed to an event
 * source; automations have no event trigger), or a call from outside (an automation's Hook / API).
 */
const KINDS: { type: TriggerType; icon: ReactNode; description: string }[] = [
  {
    type: "schedule",
    icon: <IconClock stroke={1.6} />,
    description: "按设定时间执行例行工作",
  },
  {
    type: "event",
    icon: <IconBolt stroke={1.6} />,
    description: "收到指定事件后启动任务",
  },
  {
    type: "api",
    icon: <IconCode stroke={1.6} />,
    description: "由外部系统请求启动任务",
  },
];

/** 「定时触发」, and 「API 触发」 with the space Latin wants before Chinese. */
const titleOf = (type: TriggerType) => {
  const label = TRIGGER_TYPE_LABEL[type];
  return /[A-Za-z]$/.test(label) ? `${label} 触发` : `${label}触发`;
};

/**
 * 触发方式 (docs/design/ios-studio `.trigger-grid`, 03-自主工作.png): one continuous panel in three
 * cells split by hairlines — icon square, name, one line, and the index in mono at the right. It
 * explains; it does not act. Stacked into rows on a phone.
 */
export function TriggerKinds() {
  return (
    <section aria-labelledby="autonomous-trigger-kinds" className="mt-[22px]">
      <h2
        className={cn(SECTION_TITLE, "mb-[11px]")}
        id="autonomous-trigger-kinds"
      >
        触发方式
      </h2>
      <ol
        className={cn(
          PANEL,
          "grid grid-cols-1 overflow-hidden rounded-[13px] sm:grid-cols-3",
        )}
      >
        {KINDS.map((kind, index) => (
          <li
            className={cn(
              "flex min-w-0 items-center gap-[10px] px-[11px] py-[9px]",
              index > 0 && "border-border border-t sm:border-t-0 sm:border-l",
            )}
            data-trigger-type={kind.type}
            key={kind.type}
          >
            <IconTile>{kind.icon}</IconTile>
            <div className="min-w-0">
              <p className="truncate font-bold text-[12px] leading-[18px]">
                {titleOf(kind.type)}
              </p>
              <p className="truncate text-[11px] text-muted-foreground leading-[16px]">
                {kind.description}
              </p>
            </div>
            <span
              aria-hidden="true"
              className="ms-auto shrink-0 font-mono text-[9px] text-faint tracking-[0.07em]"
            >
              {String(index + 1).padStart(2, "0")}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
