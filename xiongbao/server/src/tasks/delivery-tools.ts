import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { z } from "zod";
import { currentApprovalContext } from "../approvals/types";
import { shortName } from "../brand";
import { currentModelRun, UNSCOPED } from "../models/token-metering";
import { runTimeZone } from "../person-time-zone";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import { TenantContextError } from "../tenant/context";
import { emitRunEvent } from "../threads/run-side-events";
import type { Delivery } from "./delivery";
import { DELIVERY_EVENTS } from "./delivery-events";
import { dueRefusalText, readDueTime } from "./due-time";
import { DELIVERY_ITEM_KINDS, type EvidenceGate } from "./evidence-gate";
import type { TaskProjector, TriggerSource } from "./projector";
import { entryCardRefOf, roundOnCard } from "./turn-cards";

/**
 * A coworker's three steps of the delivery loop (spec 2026-11-15-delivery-loop §4): take the work on
 * (`accept_task`), hand it in (`deliver_task`), ask for more time (`request_extension`).
 *
 * Built per person and coworker, like every tool a run is granted, and found at call time by the run
 * they are called in: the run's id and thread (`currentModelRun()`) name the card. A call outside a
 * run changes nothing. Every write goes through `tasks/delivery.ts`; a hand-in passes the server's
 * evidence gate (`tasks/evidence-gate.ts`) first. What the person should see -- the 接活回执, the
 * 延期申请, the 交付卡, a 挡回 line -- goes into the run's own stream as a `CUSTOM` event, so it is
 * stored and replayed with the run like everything else it said.
 */

export const ACCEPT_TASK = "accept_task";
export const DELIVER_TASK = "deliver_task";
export const REQUEST_EXTENSION = "request_extension";
/** The `<server>/<tool>` spelling a rule disables them by, as for every other tool. */
export const DELIVERY_TOOLS_SERVER = "delivery";
export const ACCEPT_TASK_REF = `${DELIVERY_TOOLS_SERVER}/${ACCEPT_TASK}`;
export const DELIVER_TASK_REF = `${DELIVERY_TOOLS_SERVER}/${DELIVER_TASK}`;
export const REQUEST_EXTENSION_REF = `${DELIVERY_TOOLS_SERVER}/${REQUEST_EXTENSION}`;

/**
 * The four rules, word for word as the design shows them, under this deployment's own name (the
 * brand exit, `brand.ts`); also the external coworkers' prefix.
 */
export function deliveryProtocol(): string {
  return `【${shortName()}交付规约】1 接活先回：已接下 + 预计几点交　2 做完再交：交付物 + 你怎么查过的　3 交不了就说：缺什么、要延到几点　4 没被验收前，不要说「做完了」`;
}
const PLAIN_QUESTIONS = "问一句答一句的普通对话不要用这三个工具";
/**
 * Appended after the rules, for a built-in coworker only (the rules themselves are shared with the external
 * coworkers' first prompt, which holds no tools): which tool hands the work in, and how the files it wrote
 * in its workspace go on the hand-in. Without it a coworker that wrote its files and said so in words left
 * a card nobody had handed in.
 */
const HAND_IN_WITH_FILES =
  "有文件产出的活，先用 accept_task 接下；做完用 deliver_task 交付，把你写在工作区里的文件用 workspace_file 逐个列上（ref 写工作区内的相对路径，如 reports/对比.xlsx）。";

/**
 * How an external employee (`device_acp`, which holds none of the three tools) walks the same steps:
 * the server reads them from its replies (`agents/acp/delivery.ts`). Said after the four rules in its
 * first prompt on a card, and in every nudge and hand-over it is sent, so nothing it is told names a
 * tool it does not have. The examples are placeholders (「HH:MM」「N 分钟」) on purpose: an employee
 * repeating them back must not be read as having given a time.
 */
export const EXTERNAL_DELIVERY_GUIDE =
  "你没有接活、交付、延期的工具，服务器按你的回复替你走这三步：接下时在回复里写「预计 HH:MM」或「预计 N 分钟」报预计时间（换成真实的钟点或时长）；做完的改动会自动当作交付物，没有改动的就写一句「结论：」开头的交付结论，都用「自查：」开头的一句写你怎么查过的；交不了就写缺什么，并写「延到 HH:MM」说要延到几点。";

/** The card-drawing events the chat renders (Task 9); named in a leaf module both sides read. */
export { DELIVERY_EVENTS };

/**
 * Said, in its instructions, to a turn that is a round of a card the person asked to follow and the
 * coworker has not taken on yet (派出 · 待接下, spec §1 「你手动跟」): one line, and only while the card
 * waits. Not a message in the conversation -- nobody said it.
 */
export const RECEIPT_ASKED =
  "这段对话里有一件活被当作一件活来跟，还在等你的接活回执：先调用 accept_task（写上预计几点交和验收标准），再接着做。";

/** A run's input, carrying {@link RECEIPT_ASKED} in its context (which the Bot's instructions include). */
export function withReceiptAsked<T extends { context?: readonly unknown[] }>(
  input: T,
): T {
  return {
    ...input,
    context: [
      ...(input.context ?? []),
      { description: "交付闭环", value: RECEIPT_ASKED },
    ],
  };
}

/**
 * Said to a built-in coworker that holds `accept_task`, and to no other: a coworker whose 接活 is
 * switched off does not work in three steps, and is not told to.
 */
export function deliveryProtocolGuidance(
  toolNames: readonly string[],
): string | undefined {
  return toolNames.includes(ACCEPT_TASK)
    ? `${deliveryProtocol()}\n${PLAIN_QUESTIONS}\n${HAND_IN_WITH_FILES}`
    : undefined;
}

/**
 * What of the three a run is offered once the person's rules have had their say: switching off
 * `accept_task` switches off the loop, so the other two go with it (nothing can be handed in that was
 * never taken on).
 */
export function offeredDeliveryTools<T extends { name: string }>(
  tools: T[],
): T[] {
  if (tools.some((tool) => tool.name === ACCEPT_TASK)) return tools;
  return tools.filter(
    (tool) => tool.name !== DELIVER_TASK && tool.name !== REQUEST_EXTENSION,
  );
}

/** Where a run that says nothing about its zone is read: the product's own. */
export const DEFAULT_TIME_ZONE = "Asia/Shanghai";

const acceptSchema = z.object({
  title: z.string().trim().max(200).optional(),
  due_at: z.string().trim().max(100).optional(),
  criteria: z.string().trim().min(1, "criteria 不能为空").max(1000),
});
const deliverSchema = z.object({
  items: z
    .array(
      z.object({
        kind: z.enum(DELIVERY_ITEM_KINDS),
        ref: z.string().max(4000),
        title: z.string().max(200).optional(),
      }),
    )
    .max(30)
    .default([]),
  checks: z.array(z.string().max(500)).max(20).default([]),
});
const extensionSchema = z.object({
  due_at: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1, "reason 不能为空").max(500),
});

/** The run a call is part of: its id and thread, or undefined outside any run. */
function currentRun(): { runId: string; threadId: string } | undefined {
  const scope = currentModelRun();
  if (scope && scope.runId !== UNSCOPED && scope.threadId !== UNSCOPED)
    return { runId: scope.runId, threadId: scope.threadId };
  /*
   * A built-in Bot's tools run where Bun has dropped the model run's frame (see
   * `@openbot/toolkit/native-approval`); the call's own context, re-entered for every native call,
   * names the same run.
   */
  const call = currentApprovalContext();
  if (call?.runId && call.threadId)
    return { runId: call.runId, threadId: call.threadId };
  return undefined;
}

const OUTSIDE_A_RUN = `${REFUSAL_MARKER} 这个工具只能在一轮对话里用：现在不在任何一轮里，什么都没改。`;

export function deliveryTools(options: {
  delivery: Delivery;
  gate: EvidenceGate;
  board: Pick<TaskProjector, "opened">;
  /** The person the card is for: its tenant. */
  ownerUserId: string;
  agentId: string;
  now?: () => Date;
  /** The person's zone for this call; the run's own, read from the call, by default. */
  timeZone?: () => string | undefined;
  /**
   * The zone the person saved (`readWorkHours`), for a round that carries none of its own: a nudge,
   * a hand-over, any round the server starts without a browser behind it. Read only when needed.
   */
  savedTimeZone?: () => Promise<string>;
  /** Where the card-drawing events go; the run's own stream by default. */
  emit?: (runId: string, event: BaseEvent) => void;
}): GrantedTool[] {
  const { delivery, gate, board, ownerUserId: tenantId, agentId } = options;
  const now = options.now ?? (() => new Date());
  /*
   * The zone a time the coworker writes is read on: the call's own, else the one the round's browser
   * said, else the one the person saved -- so 「下午三点」 in a nudge round is the person's 3pm, not
   * the product's -- and only then the product's.
   */
  const zone = async (): Promise<string> =>
    options.timeZone?.() ??
    runTimeZone(currentApprovalContext()?.forwardedProps) ??
    (await options.savedTimeZone?.().catch(() => undefined)) ??
    DEFAULT_TIME_ZONE;
  const emit =
    options.emit ??
    ((runId: string, event: BaseEvent) => {
      emitRunEvent(runId, event);
    });
  const actor = `agent:${agentId}` as const;
  const said = (runId: string, name: string, value: Record<string, unknown>) =>
    emit(runId, { type: EventType.CUSTOM, name, value } as BaseEvent);
  const localTime = (instant: Date, timeZone: string) =>
    new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(instant);
  const cardOf = (run: { runId: string }) =>
    delivery.cardOfRun(tenantId, {
      runId: run.runId,
      agentId,
      ...(entryCardRefOf(run.runId)
        ? { entryRef: entryCardRefOf(run.runId) }
        : {}),
    });

  function tool<T>(
    name: string,
    description: string,
    parameters: z.ZodType<T>,
    execute: (value: T) => Promise<string>,
  ): GrantedTool {
    return {
      name,
      ref: `${DELIVERY_TOOLS_SERVER}/${name}`,
      description,
      parameters,
      async execute(args) {
        const value = parameters.safeParse(args ?? {});
        if (!value.success)
          return `${REFUSAL_MARKER} ${value.error.issues[0]?.message ?? "参数不对。"}`;
        try {
          return await execute(value.data);
        } catch (error) {
          if (error instanceof TenantContextError)
            return `${REFUSAL_MARKER} 只能替这一轮对话的人接活和交付。`;
          throw error;
        }
      },
    };
  }

  return [
    tool(
      ACCEPT_TASK,
      "接活回执：判断对方交给你的是一件有交付物的活时调用（规约第 1 条）。due_at 写预计几点交，可以是「40 分钟」「2 小时」「15:00」「下午三点」「明早 10 点」，按对方的时区算；不知道就不填，按接下后 2 小时核对。criteria 是你根据对方的话整理的验收标准，一两句；有必须交的项就在末尾写「必需：A、B、C」。同一个对话里再接另一件活，再调一次，会另开一张卡。",
      acceptSchema,
      async (value) => {
        const run = currentRun();
        if (!run) return OUTSIDE_A_RUN;
        const timeZone = await zone();
        const due = value.due_at
          ? readDueTime(value.due_at, now(), timeZone)
          : null;
        const dueAt = due?.at ?? null;
        const card = await cardOf(run);
        let taskId: string;
        if (card && !(card.tracked && card.acceptedAt)) taskId = card.id;
        else {
          /*
           * A second piece of work taken on in this thread (spec §2: its own card, and later rounds
           * hang on the newest), or a turn whose own card was never filed.
           */
          try {
            taskId = await board.opened({
              tenantId,
              title: value.title || card?.title || "对话任务",
              executorAgentId: agentId,
              source: card?.source ?? "chat",
              triggerSource: (card?.triggerSource ??
                null) as TriggerSource | null,
              channelRef: card?.channelRef ?? run.threadId,
              // The run's own card is filed under the run id; a second card must not be found by it.
              ...(card ? {} : { runRef: run.runId }),
              /*
               * Taken on during a crew's step: the board reaches a crew's card only through the run it
               * belongs to (`tasks/routes.ts` `openTargetsFor`), so the new card hangs under the same
               * crew card as the step -- or under the card itself when it is the crew's -- and opens
               * the run as the step does. It is charged on its own, not out of the steps' reservation.
               */
              ...(card?.source === "group_run"
                ? {
                    parentTaskId: card.parentTaskId ?? card.id,
                    outsideReservation: true,
                  }
                : {}),
              deviceId: card?.deviceId ?? null,
            });
          } catch (error) {
            return `${REFUSAL_MARKER} 没能另开一件活：${error instanceof Error ? error.message : String(error)}`;
          }
        }
        // The 接下 line's id, named here so the chat's 接活回执 finds that line by it (not by its due time).
        const acceptedLine = randomUUID();
        const accepted = await delivery.accept(tenantId, taskId, {
          eventId: acceptedLine,
          at: now(),
          runId: run.runId,
          threadRef: run.threadId,
          actor,
          ...(value.title ? { title: value.title } : {}),
          dueAt,
          criteria: value.criteria,
        });
        if (!accepted)
          return `${REFUSAL_MARKER} 这件活现在接不了：它已经结束或已经被接下了。`;
        // This round now belongs to the card, whichever entry started the turn: its end is written there.
        roundOnCard(run.runId, tenantId, taskId);
        said(run.runId, DELIVERY_EVENTS.accepted, {
          taskId,
          eventId: acceptedLine,
          dueAt: accepted.dueAt?.toISOString() ?? null,
          criteria: accepted.criteria,
        });
        // The person's own criteria, set while the card waited, stand: the coworker is told which.
        const theirs = accepted.criteria !== value.criteria;
        return JSON.stringify({
          accepted: true,
          taskId,
          dueAt: accepted.dueAt?.toISOString() ?? null,
          dueReported: dueAt !== null,
          ...(theirs
            ? {
                criteria: accepted.criteria,
                criteriaNote:
                  "对方在你接下前改过验收标准，按对方的为准（含其中的必需项）。",
              }
            : {}),
          note: dueAt
            ? `已接下，预计 ${localTime(dueAt, timeZone)} 交。做完用 deliver_task 交付物和自查；交不了就用 request_extension。`
            : due && due.at === null
              ? `已接下，但预计时间「${value.due_at}」没有记上（${dueRefusalText(due.why)}）：这件活按没报时间处理，接下后 2 小时核对。可以在回复里告诉对方大概几点交。`
              : "已接下，没报预计时间：接下后 2 小时核对。",
        });
      },
    ),
    tool(
      DELIVER_TASK,
      "交付（规约第 2 条）：做完接下的活时调用。items 列出交付物：attachment（这个对话里的附件 id）、component（这件活里画过的组件，ref 写组件名或它那次调用的 id）、link（http(s) 地址）、workspace_file（写在你自己工作区里的文件，ref 写工作区内的相对路径，如 reports/对比.xlsx，任务卡会把它念成一行产物）、note（只有文字结论时，ref 写结论）；title 写清是什么。checks 写你怎么查过的，每条一句。验收标准写了「必需：…」时，每个必需项都要在 title 或 checks 里提到。服务器会核对，不过会被挡回并告诉你缺什么；补齐再交。交了以后等对方验收，没被验收前不要说「做完了」。",
      deliverSchema,
      async (value) => {
        const run = currentRun();
        if (!run) return OUTSIDE_A_RUN;
        const card = await cardOf(run);
        if (!card?.tracked)
          return `${REFUSAL_MARKER} 这一轮没有接下的活：先用 accept_task 接下，再交付。`;
        if (!card.acceptedAt)
          return `${REFUSAL_MARKER} 这件活还没接下：先用 accept_task 回执（预计几点交、验收标准），再交付。`;
        if (card.status === "needs_action")
          return `${REFUSAL_MARKER} 这件活还在等对方处理（审批或提问），处理完再交。`;
        const verdict = await gate.checkEvidence({
          tenantId,
          taskId: card.id,
          threadRef: card.threadRef,
          items: value.items,
          checks: value.checks,
          criteria: card.criteria,
        });
        if (!verdict.ok) {
          const bouncedLine = randomUUID();
          await delivery.bounced(tenantId, card.id, {
            eventId: bouncedLine,
            runId: run.runId,
            actor,
            reason: verdict.reason,
            ...(verdict.missing ? { missing: verdict.missing } : {}),
          });
          said(run.runId, DELIVERY_EVENTS.bounced, {
            taskId: card.id,
            eventId: bouncedLine,
            reason: verdict.reason,
          });
          return JSON.stringify({
            bounced: true,
            reason: verdict.reason,
            ...(verdict.missing?.length ? { missing: verdict.missing } : {}),
            note: "没交上：卡片没动。补齐后再调用 deliver_task。",
          });
        }
        // Each hand-in its own line id: a second, identical hand-in after a 退回 is its own card.
        const deliveredLine = randomUUID();
        const merged = await delivery.delivered(tenantId, card.id, {
          eventId: deliveredLine,
          runId: run.runId,
          agentId,
          actor,
          deliverable: verdict.ref,
        });
        if (!merged)
          return `${REFUSAL_MARKER} 这件活现在交不了：它已经结束、还在等对方处理，或已经换给别的员工。`;
        said(run.runId, DELIVERY_EVENTS.delivered, {
          taskId: card.id,
          eventId: deliveredLine,
          deliverable: verdict.ref,
        });
        return JSON.stringify({
          delivered: true,
          taskId: card.id,
          note: "已交成果，等对方验收。没被验收前，不要说「做完了」。",
        });
      },
    ),
    tool(
      REQUEST_EXTENSION,
      "申请延期（规约第 3 条）：接下的活到预计时间交不了时调用。due_at 写想延到几点（「1 小时」「明早 10 点」…），reason 写缺什么、为什么。对方准许前，预计时间不变。",
      extensionSchema,
      async (value) => {
        const run = currentRun();
        if (!run) return OUTSIDE_A_RUN;
        const card = await cardOf(run);
        if (!card?.tracked)
          return `${REFUSAL_MARKER} 这一轮没有接下的活，不用申请延期。`;
        const timeZone = await zone();
        const due = readDueTime(value.due_at, now(), timeZone);
        if (due.at === null)
          return `${REFUSAL_MARKER} 「${value.due_at}」不能用来申请延期（${dueRefusalText(due.why)}）：换成「1 小时」「17:30」「明早 10 点」这样、30 天以内的时间再申请。`;
        const dueAt = due.at;
        const askedLine = randomUUID();
        const asked = await delivery.requestExtension(tenantId, card.id, {
          eventId: askedLine,
          dueAt,
          reason: value.reason,
          runId: run.runId,
          actor,
        });
        if (!asked) return `${REFUSAL_MARKER} 这件活已经结束，不用申请延期。`;
        said(run.runId, DELIVERY_EVENTS.extensionRequested, {
          taskId: card.id,
          eventId: askedLine,
          dueAt: dueAt.toISOString(),
          reason: value.reason,
        });
        return JSON.stringify({
          requested: true,
          taskId: card.id,
          dueAt: dueAt.toISOString(),
          note: `已申请延到 ${localTime(dueAt, timeZone)}；对方准许前，预计时间不变。`,
        });
      },
    ),
  ];
}
