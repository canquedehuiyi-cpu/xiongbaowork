import type { Reachability } from "@/lib/delivery";
import { cn } from "@/lib/utils";
import {
  DELIVERY_KIND_LABELS,
  DELIVERY_STATE_LABELS,
  TRANSPORT_LABELS,
} from "./chats";

/** 最近送达: what was sent where, newest first, failures with the reason the provider gave. */
export function RecentDeliveries({
  deliveries,
}: {
  deliveries: Reachability["deliveries"] | undefined;
}) {
  return (
    <section aria-labelledby="recent-deliveries" className="grid gap-3">
      <h2 className="text-[15px] font-semibold" id="recent-deliveries">
        最近送达
      </h2>
      {deliveries === undefined ? null : deliveries.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">还没有投递记录。</p>
      ) : (
        <ul className="max-h-[320px] divide-y overflow-y-auto rounded-lg border text-[13px]">
          {deliveries.map((delivery) => (
            <li className="grid gap-0.5 px-3 py-2" key={delivery.id}>
              <p className="flex flex-wrap gap-x-2">
                <span>
                  {TRANSPORT_LABELS[delivery.transport] ?? delivery.transport}
                </span>
                <span className="text-muted-foreground">
                  {DELIVERY_KIND_LABELS[delivery.kind] ?? delivery.kind}
                </span>
                <span
                  className={cn(
                    delivery.state === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {DELIVERY_STATE_LABELS[delivery.state] ?? delivery.state}
                </span>
                <span className="text-muted-foreground">
                  {new Date(delivery.createdAt).toLocaleString()}
                </span>
              </p>
              {delivery.error && (
                <p className="text-destructive">{delivery.error}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
