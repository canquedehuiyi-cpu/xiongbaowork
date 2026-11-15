import type { BaseEvent } from "@ag-ui/client";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  attachments,
  groupBotThreads,
  intelligenceChannelMappings,
  taskEvents,
  tasks,
  threadRunEvents,
} from "../db/schema";
import { runAsTenant } from "../tenant/context";
import { runEventsSoFar } from "../threads/run-side-events";
import {
  type DeliverableComponent,
  type DeliverableRef,
  drawnComponents,
} from "./projector";

/**
 * The evidence gate (spec 2026-11-15-delivery-loop §5): whether a coworker's hand-in may move its card
 * to 已交成果. The server decides, not the coworker: a card the board shows as delivered has something
 * on it a person can open.
 *
 * In order, the first failure refusing the hand-in:
 * 1. at least one item, and every item real and this card's -- an attachment in the card's thread, a
 *    component drawn in one of the card's rounds, a link that is an http(s) address;
 * 2. a words-only hand-in (only `note`s) says how it was checked: at least one `checks` line;
 * 3. when the criteria list required items (「必需：A、B、C」), each one is named by an item's title
 *    or a check line, and the refusal says which are missing.
 *
 * It does not judge whether the work is right; that is the person's 验收.
 */

export const DELIVERY_ITEM_KINDS = [
  "attachment",
  "component",
  "link",
  "diff",
  "note",
] as const;

export type DeliveryItem = {
  kind: (typeof DELIVERY_ITEM_KINDS)[number];
  /**
   * attachment: its id (or `/api/attachments/<id>`); component: the id of the call that drew it, or
   * its name for the latest one drawn on the card; link: the address; note: the conclusion itself.
   */
  ref: string;
  title?: string;
};

export type EvidenceVerdict =
  | { ok: true; ref: DeliverableRef }
  | { ok: false; reason: string; missing?: string[] };

export type EvidenceGate = {
  checkEvidence(input: {
    tenantId: string;
    taskId: string;
    threadRef: string | null;
    items: readonly DeliveryItem[];
    checks: readonly string[];
    criteria: string | null;
  }): Promise<EvidenceVerdict>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The attachment id an item names: the id itself, or the path the chat links it by. */
function attachmentIdOf(ref: string): string | undefined {
  const id = ref
    .trim()
    .replace(/^.*\/api\/attachments\//, "")
    .replace(/[/?#].*$/, "");
  return UUID.test(id) ? id.toLowerCase() : undefined;
}

function httpAddress(ref: string): string | undefined {
  try {
    const url = new URL(ref.trim());
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

const nameOf = (item: DeliveryItem) => item.title?.trim() || item.ref.trim();

/**
 * The required items criteria list after 「必需：」 (or 「必需:」), split on 、，, ; and the like.
 * Empty when the criteria name none.
 */
export function requiredItemsOf(criteria: string | null | undefined): string[] {
  const marked = /必需\s*[：:]\s*([^。\n；;]*)/.exec(criteria ?? "");
  if (!marked) return [];
  return (marked[1] ?? "")
    .split(/[、，,／/]|\s+和\s*|\s*及\s*/)
    .map((item) => item.trim().replace(/等$/, "").trim())
    .filter((item) => item.length > 0);
}

const comparable = (text: string) => text.toLowerCase().replace(/\s+/g, "");

export function createEvidenceGate(database: Database): EvidenceGate {
  /** Every run the card has had: the one that opened it, the one on it now, and each in its history. */
  async function runsOf(tenantId: string, taskId: string): Promise<string[]> {
    const [card] = await database
      .select({ runRef: tasks.runRef, activeRunRef: tasks.activeRunRef })
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
      .limit(1);
    const logged = await database
      .selectDistinct({ runId: sql<string>`${taskEvents.detail}->>'runId'` })
      .from(taskEvents)
      .where(
        and(
          eq(taskEvents.tenantId, tenantId),
          eq(taskEvents.taskId, taskId),
          sql`${taskEvents.detail}->>'runId' is not null`,
        ),
      );
    return [
      ...new Set(
        [
          card?.runRef,
          card?.activeRunRef,
          ...logged.map((row) => row.runId),
        ].filter((id): id is string => typeof id === "string" && id !== ""),
      ),
    ];
  }

  /** What the card's rounds drew: the stored runs, and the run still open in this process. */
  async function drawnOnCard(tenantId: string, taskId: string) {
    const runIds = await runsOf(tenantId, taskId);
    if (runIds.length === 0) return [];
    const stored = await database
      .select({ runId: threadRunEvents.runId, event: threadRunEvents.event })
      .from(threadRunEvents)
      .where(
        and(
          eq(threadRunEvents.tenantId, tenantId),
          inArray(threadRunEvents.runId, runIds),
        ),
      )
      .orderBy(threadRunEvents.runId, threadRunEvents.seq);
    const byRun = new Map<string, BaseEvent[]>();
    for (const row of stored) {
      const event =
        typeof row.event === "string"
          ? (JSON.parse(row.event) as BaseEvent)
          : (row.event as unknown as BaseEvent);
      const list = byRun.get(row.runId) ?? [];
      list.push(event);
      byRun.set(row.runId, list);
    }
    return runIds.flatMap((runId) =>
      drawnComponents([...(byRun.get(runId) ?? []), ...runEventsSoFar(runId)]),
    );
  }

  /** Which of these attachments are in the card's thread (its channel, or its group's channel). */
  async function attachmentsInThread(
    threadRef: string | null,
    ids: string[],
  ): Promise<Set<string>> {
    if (!threadRef || ids.length === 0) return new Set();
    const channelsOfThread = sql`(
      select ${intelligenceChannelMappings.channelId} from ${intelligenceChannelMappings}
      where ${intelligenceChannelMappings.threadId} = ${threadRef}
      union
      select ${groupBotThreads.channelId} from ${groupBotThreads}
      where ${groupBotThreads.threadId} = ${threadRef}
    )`;
    const rows = await database
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          inArray(attachments.id, ids),
          sql`${attachments.channelId} in ${channelsOfThread}`,
        ),
      );
    return new Set(rows.map((row) => row.id.toLowerCase()));
  }

  return {
    checkEvidence: (input) =>
      runAsTenant(input.tenantId, async (): Promise<EvidenceVerdict> => {
        const items = input.items;
        const checks = input.checks
          .map((check) => check.trim())
          .filter((check) => check.length > 0);
        if (items.length === 0)
          return {
            ok: false,
            reason:
              "没有交付物：至少交一项（附件、组件、链接或文字结论），再写上你怎么查过的。",
          };

        const ref: DeliverableRef = { kind: "deliverable" };
        const components: DeliverableComponent[] = [];
        const attachmentIds: string[] = [];
        const links: { url: string; title: string }[] = [];
        const notes: string[] = [];

        const wantedAttachments = items
          .filter((item) => item.kind === "attachment")
          .map((item) => attachmentIdOf(item.ref))
          .filter((id): id is string => id !== undefined);
        const inThread = await attachmentsInThread(
          input.threadRef,
          wantedAttachments,
        );
        const drawn = items.some((item) => item.kind === "component")
          ? await drawnOnCard(input.tenantId, input.taskId)
          : [];

        for (const item of items) {
          const name = nameOf(item);
          switch (item.kind) {
            case "attachment": {
              const id = attachmentIdOf(item.ref);
              if (!id || !inThread.has(id))
                return {
                  ok: false,
                  reason: `附件「${name}」不在这件活的对话里，交不了。只能交这个对话里的附件。`,
                  missing: [name],
                };
              attachmentIds.push(id);
              break;
            }
            case "component": {
              const wanted = item.ref.trim();
              const found =
                drawn.find((component) => component.toolCallId === wanted) ??
                drawn.findLast((component) => component.name === wanted);
              if (!found)
                return {
                  ok: false,
                  reason: `组件「${name}」不是这件活里画的，交不了。先在这件活里把它画出来再交。`,
                  missing: [name],
                };
              components.push({ name: found.name, args: found.args });
              break;
            }
            case "link": {
              const url = httpAddress(item.ref);
              if (!url)
                return {
                  ok: false,
                  reason: `链接「${name}」不是 http(s) 地址。`,
                  missing: [name],
                };
              links.push({ url, title: item.title?.trim() || url });
              break;
            }
            case "diff":
              return {
                ok: false,
                reason: "改动汇总只能来自外部员工的轮次，不能自己报。",
                missing: [name],
              };
            case "note": {
              const text = item.ref.trim() || item.title?.trim() || "";
              if (!text)
                return { ok: false, reason: "文字结论是空的。", missing: [] };
              notes.push(text);
              break;
            }
            default:
              return {
                ok: false,
                reason: `不认识的交付物类型「${String((item as { kind: unknown }).kind)}」。`,
              };
          }
        }

        if (items.every((item) => item.kind === "note") && checks.length === 0)
          return {
            ok: false,
            reason:
              "只有文字结论时，至少写一条你怎么查过的（checks），比如核对了哪些数据、跑了什么测试。",
          };

        const named = [...items.map(nameOf), ...checks].map(comparable);
        const missing = requiredItemsOf(input.criteria).filter(
          (required) =>
            !named.some((text) => text.includes(comparable(required))),
        );
        if (missing.length > 0)
          return {
            ok: false,
            reason: `验收标准里的必需项没对上：缺 ${missing.join("、")}。在交付物标题或自查里逐一写到再交。`,
            missing,
          };

        if (components.length) ref.components = components;
        if (attachmentIds.length) ref.attachments = [...new Set(attachmentIds)];
        if (links.length) ref.links = links;
        if (notes.length) ref.notes = notes;
        if (checks.length) ref.checks = checks;
        return { ok: true, ref };
      }),
  };
}
