import {
  IconActivity,
  IconAlertTriangle,
  IconMessageCircle,
} from "@tabler/icons-react";
import type { Reachability } from "@/lib/delivery";
import { cn } from "@/lib/utils";
import {
  DELIVERY_KIND_LABELS,
  DELIVERY_STATE_LABELS,
  TRANSPORT_LABELS,
} from "./chats";

/** theme.css `.delivery.glass`: a graphite plate with 12px corners. */
const PLATE =
  "rounded-[12px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]";

/** theme.css `.symbol` at the delivery row's 29px: the row's icon in a small raised square. */
function DeliverySymbol({ failed }: { failed?: boolean }) {
  const Icon = failed ? IconAlertTriangle : IconMessageCircle;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-[29px] shrink-0 place-items-center rounded-[9px] border border-border bg-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]",
        failed ? "text-signal-ink" : "text-foreground/85",
      )}
    >
      <Icon className="size-[15px]" />
    </span>
  );
}

/** 最近送达: what was sent where, newest first, failures with the reason the provider gave. */
export function RecentDeliveries({
  deliveries,
}: {
  deliveries: Reachability["deliveries"] | undefined;
}) {
  return (
    <section aria-labelledby="recent-deliveries" className="grid gap-[9px]">
      <h2
        className="flex items-center gap-[7px] font-semibold text-[17px] leading-[24px] tracking-[-0.02em]"
        id="recent-deliveries"
      >
        <IconActivity aria-hidden className="size-[18px] text-foreground/85" />
        最近送达
      </h2>
      {deliveries === undefined ? null : deliveries.length === 0 ? (
        <p
          className={cn(
            PLATE,
            "flex min-h-[47px] items-center gap-[10px] px-[11px] py-[7px] text-[12px] text-muted-foreground",
          )}
        >
          <DeliverySymbol />
          暂无投递记录
        </p>
      ) : (
        <ul
          className={cn(
            PLATE,
            "max-h-[320px] divide-y divide-border overflow-y-auto text-[12px]",
          )}
        >
          {deliveries.map((delivery) => {
            const failed = delivery.state === "failed";
            return (
              <li
                className="flex min-h-[47px] items-center gap-[10px] px-[11px] py-[7px]"
                key={delivery.id}
              >
                <DeliverySymbol failed={failed} />
                <div className="grid min-w-0 gap-0.5">
                  <p className="flex flex-wrap gap-x-2">
                    <span className="font-medium text-foreground">
                      {TRANSPORT_LABELS[delivery.transport] ??
                        delivery.transport}
                    </span>
                    <span className="text-muted-foreground">
                      {DELIVERY_KIND_LABELS[delivery.kind] ?? delivery.kind}
                    </span>
                    <span
                      className={cn(
                        failed ? "text-signal-ink" : "text-muted-foreground",
                      )}
                    >
                      {DELIVERY_STATE_LABELS[delivery.state] ?? delivery.state}
                    </span>
                    <span className="text-faint tabular-nums">
                      {new Date(delivery.createdAt).toLocaleString()}
                    </span>
                  </p>
                  {delivery.error && (
                    <p className="break-words text-signal-ink">
                      {delivery.error}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
