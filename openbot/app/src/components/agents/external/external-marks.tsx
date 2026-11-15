import { IconAlertTriangle } from "@tabler/icons-react";
import { EXTERNAL_UNATTENDED_NOTE, externalMark } from "@/lib/agents/external";
import type { ExternalRun } from "@/lib/agents/queries";
import { shortName } from "@/lib/brand";
import type { RegisteredDevice } from "@/lib/devices/queries";
import { cn } from "@/lib/utils";

/*
 * 外部员工的标记和警示（外部员工 Task 11）。通讯录、名片、对话顶栏都画在默认皮肤里，也画在别的皮肤里：
 * 颜色先取 `--wb-*` 令牌，没有时取应用自己的主题令牌，不会露出透明底。
 */

/** 「外部员工 · Codex」小标签（设计稿第 3 屏顶栏名字旁边那一块）。 */
export function ExternalMark({
  external,
  device,
  className,
}: {
  external: Pick<ExternalRun, "harness" | "appRef">;
  /** 它所在的电脑：本机智能体从这里读登记的名字。 */
  device?: Pick<RegisteredDevice, "apps">;
  className?: string;
}) {
  const text = externalMark(external, device);
  return (
    <span
      className={cn(
        "inline-block w-fit min-w-0 max-w-full shrink truncate whitespace-nowrap rounded-full px-[7px] py-[2px] align-middle font-normal text-[11px] leading-[1.4]",
        "bg-[color:var(--wb-card2,var(--muted))] text-[color:var(--wb-fg2,var(--muted-foreground))]",
        className,
      )}
      data-external-mark=""
      title={text}
    >
      {text}
    </span>
  );
}

/** 本机智能体可能从不请求许可：熊宝拦不住它的动作（规格第 4 节）。 */
export function NoPermissionWarning({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "m-0 flex items-start gap-1.5 rounded-[8px] px-2 py-1.5 text-[12px] leading-relaxed",
        "bg-[color:var(--wb-amber-soft,var(--muted))] text-[color:var(--wb-amber-fg,var(--foreground))]",
        className,
      )}
      data-no-permission-warning=""
      role="note"
    >
      <IconAlertTriangle
        aria-hidden="true"
        className="mt-[2px] size-3.5 shrink-0"
      />
      <span>这个智能体不会请求许可，{shortName()}拦不住它的动作。</span>
    </p>
  );
}

/**
 * 例行任务、长期职责、主动巡检、定时唤醒的分页对外部员工只放这一句（服务器对它一律 409，入口也都不显示；
 * 有人从旧链接直接打开时才看得到）。
 */
export function ExternalUnattendedNote() {
  return (
    <p
      className="mt-6 rounded-[14px] border border-border border-dashed px-[14px] py-[11px] text-[13px] text-muted-foreground"
      data-external-unattended=""
    >
      {EXTERNAL_UNATTENDED_NOTE}
    </p>
  );
}
