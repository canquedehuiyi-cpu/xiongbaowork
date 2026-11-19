/**
 * The card-drawing events of the delivery loop (spec 2026-11-15-delivery-loop §4): what a coworker's
 * run carries for the chat to draw (`tasks/delivery-tools.ts`, `agents/acp/delivery.ts`) and what a
 * group's reply keeps a mark of (`channels/group.ts`).
 *
 * A LEAF MODULE: it imports nothing, so both sides read the names at module load without a cycle
 * (`delivery-tools` reaches back to `channels/group` through `turn-cards`).
 */
export const DELIVERY_EVENTS = {
  accepted: "delivery.accepted",
  extensionRequested: "delivery.extension_requested",
  delivered: "delivery.delivered",
  bounced: "delivery.bounced",
  /** The person's answer to a 延期申请, so the chat's card can say it was granted or not. */
  extensionDecided: "delivery.extension_decided",
} as const;
