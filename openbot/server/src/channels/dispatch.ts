/**
 * `@` a coworker inside a one-to-one conversation, and have THAT coworker do the work (spec B2, B3).
 *
 * A 1:1 channel is pinned to one coworker for the life of its thread. A person who types `@阿审` in
 * it is not asking to re-pin the conversation; they are handing one piece of work to somebody else
 * and expecting to see the answer where they asked. So a mention of anyone but the pinned coworker
 * does not go through the browser's run at all: it is posted here, a card is opened on the board
 * (source `chat`, executor = the coworker named), and the turn itself runs on the server.
 *
 * WHERE THE TURN RUNS — THE SPIKE'S ANSWER. In the channel's OWN thread, not in a side thread per
 * (channel, coworker). The 1:1 transcript reads exactly one thread (`channel.threadId`) and has no
 * per-message speaker, so a side thread would put the answer somewhere the person never looks, and
 * B3 says it must appear in the channel. On the channel thread the existing refresh carries it: the
 * reply is recorded as channel activity, the roster cache moves, and `channel-chat.tsx` re-reads the
 * thread exactly as it does for a relayed handoff. What the transcript cannot show is WHO answered,
 * so the turn's persisted user line is the person's own words — which begin with `@Name` — and the
 * roster preview names the coworker. Per-message attribution needs a speaker field in the stored
 * messages and is left for a later change; see the package notes.
 *
 * NOTHING IS REPLAYED. The queue hands an item out at most once (`maxAttempts: 1`): a turn may already
 * have spent money or called a tool when its process died, so a crashed dispatch is closed by the
 * restart sweep (`tasks/reclaim.ts`, which recognises a dispatch card by this queue's ledger row)
 * rather than run a second time.
 *
 * TENANCY (G01). The request offers the item inside the person's own frame, so the row is stamped with
 * their tenant. The worker claims as `platform` (the queue's job) and then runs every write — card,
 * thread, activity — inside `item.tenantId`, the claimed record's tenant, and refuses an item whose
 * payload names somebody else.
 */
import { createHash } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AgentActor } from "../agents/profile-types";
import { PERSON_INITIATOR } from "../audit";
import type { AppVariables } from "../auth/guards";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import { QuotaExceeded } from "../quota/limits";
import type { TurnRunner } from "../routines/runner";
import type { TaskProjector } from "../tasks/projector";
import { DISPATCH_LEDGER_KIND } from "../tasks/reclaim";
import { runAsTenant } from "../tenant/context";
import type { WorkQueue } from "../work/queue";

/** The work-queue kind of a dispatched turn. `tasks/reclaim.ts` reads it as the dispatch ledger. */
export const CHANNEL_DISPATCH_KIND = DISPATCH_LEDGER_KIND;

/** Long enough for a whole turn and its grace (`run-turn.ts`: five minutes plus five seconds). */
export const CHANNEL_DISPATCH_LEASE_MS = 15 * 60_000;

/** A non-member, an unknown channel and a coworker the caller cannot use all read the same. */
export class ChannelDispatchNotFoundError extends Error {
  constructor(message = "找不到这段对话或这位员工。") {
    super(message);
    this.name = "ChannelDispatchNotFoundError";
  }
}

export class ChannelDispatchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelDispatchRefusedError";
  }
}

export type DispatchChannel = {
  id: string;
  threadId: string;
  agentIds: string[];
};

export type DispatchBot = { id: string; name: string };

/**
 * The run id a dispatch is filed under, derived from who asked, where, and the client's message id.
 *
 * Deterministic so a replay of the same POST is the same work: the queue key, the card's `runRef` and
 * the turn's run id are all this one value, which is also what lets the restart sweep join a card to
 * its ledger row. Shaped as a uuid because the platform's thread lock wants one.
 */
export function dispatchRunId(
  ownerUserId: string,
  channelId: string,
  messageId: string,
): string {
  const hex = createHash("sha256")
    .update(`channel.dispatch\n${ownerUserId}\n${channelId}\n${messageId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const bodySchema = z.strictObject({
  id: z.string().min(1).max(160),
  agentId: z.string().min(1).max(200),
  text: z.string().trim().min(1).max(16000),
});

const payloadSchema = z.object({
  ownerUserId: z.string().min(1),
  channelId: z.string().min(1),
  agentId: z.string().min(1),
  text: z.string().min(1),
  messageId: z.string().min(1),
});

export type ChannelDispatchDeps = {
  queue: Pick<WorkQueue, "offer" | "claim" | "finish">;
  /** This replica's name on the queue. */
  owner: string;
  board: Pick<TaskProjector, "opened" | "finished" | "needsAction">;
  /** The channel as this person sees it: null for a non-member, a deleted channel, or no such id. */
  channel(
    actor: AgentActor,
    channelId: string,
  ): Promise<DispatchChannel | null>;
  /** The coworker, when this person may use it; null otherwise. Asked again when the turn runs. */
  bot(actor: AgentActor, agentId: string): Promise<DispatchBot | null>;
  /** The person, as the turn runs them. The role is read rather than assumed. */
  actorFor(ownerUserId: string): Promise<AgentActor>;
  runTurn: TurnRunner;
  /**
   * Say in the channel what came of it, as the channel's own coworker (the only one a 1:1 channel
   * admits on its roster line). This is what moves the roster and makes an open transcript re-read
   * the thread the turn just wrote.
   */
  activity?(input: {
    actor: AgentActor;
    channelId: string;
    pinnedAgentId: string;
    text: string;
    sourceId: string;
  }): Promise<void>;
  busy?(threadId: string, busy: boolean): Promise<void>;
  deviceIdOf?(agentId: string): Promise<string | null>;
};

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createChannelDispatch(deps: ChannelDispatchDeps) {
  const log = (type: string, detail: Record<string, unknown>) =>
    console.error(JSON.stringify({ type, ...detail }));

  /** Open (or find) the card. Idempotent on the run id, so the request and the worker may both ask. */
  const openCard = (input: {
    tenantId: string;
    runId: string;
    channelId: string;
    agentId: string;
    text: string;
    deviceId: string | null;
  }) =>
    deps.board.opened({
      tenantId: input.tenantId,
      title: input.text,
      executorAgentId: input.agentId,
      source: "chat",
      channelRef: input.channelId,
      runRef: input.runId,
      deviceId: input.deviceId,
    });

  /** Close the card; a card that was never opened matches nothing, which is not an error. */
  const closeCard = async (
    tenantId: string,
    runId: string,
    failed: boolean,
  ) => {
    try {
      await deps.board.finished({
        tenantId,
        runRef: runId,
        failed,
        onlyUnsettled: true,
      });
    } catch (error) {
      log("channel-dispatch-board-close-failed", {
        runId,
        reason: reasonOf(error),
      });
    }
  };

  async function say(
    actor: AgentActor,
    channel: DispatchChannel,
    runId: string,
    text: string,
  ) {
    const pinnedAgentId = channel.agentIds[0];
    if (!deps.activity || !pinnedAgentId) return;
    try {
      await deps.activity({
        actor,
        channelId: channel.id,
        pinnedAgentId,
        text,
        sourceId: `dispatch:${runId}`,
      });
    } catch (error) {
      // The card and the thread are the record; a roster line that did not move is a courtesy lost.
      log("channel-dispatch-activity-failed", {
        runId,
        reason: reasonOf(error),
      });
    }
  }

  async function run(
    tenantId: string,
    runId: string,
    payload: z.infer<typeof payloadSchema>,
  ) {
    const actor = await deps.actorFor(payload.ownerUserId);
    const channel = await deps.channel(actor, payload.channelId);
    const bot = channel ? await deps.bot(actor, payload.agentId) : null;
    if (!channel || !bot) {
      // Left the conversation, or lost the coworker, while this waited: nothing runs, and the card
      // (if the request opened one) says so instead of staying "in progress".
      await closeCard(tenantId, runId, true);
      return;
    }
    let carded = false;
    try {
      await openCard({
        tenantId,
        runId,
        channelId: channel.id,
        agentId: bot.id,
        text: payload.text,
        deviceId: (await deps.deviceIdOf?.(bot.id).catch(() => null)) ?? null,
      });
      carded = true;
    } catch (error) {
      // Over the month's ceiling: the request already answered 402, and the turn must not happen.
      if (error instanceof QuotaExceeded) return;
      // Any other board fault: the person asked the coworker, and the runner files its own card.
      log("channel-dispatch-board-open-failed", {
        runId,
        reason: reasonOf(error),
      });
    }

    await deps.busy?.(channel.threadId, true).catch(() => undefined);
    try {
      const userMessage: Message = {
        id: `dispatch-user:${runId}`,
        role: "user",
        content: payload.text,
      };
      const result = await deps.runTurn({
        ownerUserId: payload.ownerUserId,
        routineId: `dispatch:${channel.id}`,
        agentId: bot.id,
        threadId: channel.threadId,
        instruction: payload.text,
        userMessage,
        runId,
        initiator: PERSON_INITIATOR,
        // The card above is this turn's record; the runner must not file a second one.
        cardOwnedByCaller: carded,
      });
      if (carded) await closeCard(tenantId, runId, false);
      await say(actor, channel, runId, `${bot.name}：${result.replyText}`);
    } catch (error) {
      if (error instanceof HeadlessToolSuspension) {
        const approvalId = error.waiting.approvalId;
        const awaitsApproval =
          typeof approvalId === "string" && approvalId.length > 0;
        if (carded && typeof approvalId === "string" && awaitsApproval) {
          // Parked on a person's decision: 需要操作, and answering it moves the card on.
          await deps.board
            .needsAction({ tenantId, runRef: runId, approvalId })
            .catch((boardError) =>
              log("channel-dispatch-board-park-failed", {
                runId,
                reason: reasonOf(boardError),
              }),
            );
        } else if (carded) {
          // A durable wait with no approval row to hold the card against: the review lane, as a
          // routine's suspension does (`routines/runner.ts`).
          await closeCard(tenantId, runId, false);
        }
        // The suspension's own message is the runtime's English, written for a model's transcript; the
        // roster line a person reads is said here, in the product's words.
        await say(
          actor,
          channel,
          runId,
          awaitsApproval
            ? `${bot.name} 在等你批准，请到"需要操作"里处理。`
            : `${bot.name} 在等你处理一件事，请到任务看板查看。`,
        );
        return;
      }
      if (carded) await closeCard(tenantId, runId, true);
      await say(
        actor,
        channel,
        runId,
        `${bot.name} 没有完成这次任务：${reasonOf(error)}`,
      );
    } finally {
      await deps.busy?.(channel.threadId, false).catch(() => undefined);
    }
  }

  return {
    /**
     * Accept one dispatch: check, queue, open the card. Safe to replay with the same `id`.
     *
     * Queued BEFORE the card is opened, so every dispatch card has a ledger row from its first moment
     * — which is what lets the restart sweep tell a dead dispatch from a person's open conversation.
     */
    async submit(actor: AgentActor, channelId: string, input: unknown) {
      const body = bodySchema.parse(input);
      const channel = await deps.channel(actor, channelId);
      if (!channel) throw new ChannelDispatchNotFoundError();
      if (channel.agentIds.length !== 1)
        throw new ChannelDispatchRefusedError(
          "多人对话里请直接在群组中 @ 员工。",
        );
      const bot = await deps.bot(actor, body.agentId);
      if (!bot) throw new ChannelDispatchNotFoundError();

      const runId = dispatchRunId(actor.id, channel.id, body.id);
      const offered = await deps.queue.offer({
        kind: CHANNEL_DISPATCH_KIND,
        key: runId,
        payload: {
          ownerUserId: actor.id,
          channelId: channel.id,
          agentId: bot.id,
          text: body.text,
          messageId: body.id,
        },
      });
      // Quota is asked inside this write (`tasks/projector.ts`), so a refusal surfaces as 402 here and
      // the worker's own `opened` refuses the queued item the same way.
      const taskId = await openCard({
        tenantId: actor.id,
        runId,
        channelId: channel.id,
        agentId: bot.id,
        text: body.text,
        deviceId: (await deps.deviceIdOf?.(bot.id).catch(() => null)) ?? null,
      });
      return { taskId, runId, queued: offered === "queued" };
    },

    /** Claim and run one dispatched turn. Returns whether there was one, so a caller can drain. */
    async sweep(): Promise<boolean> {
      const [item] = await deps.queue.claim({
        kind: CHANNEL_DISPATCH_KIND,
        owner: deps.owner,
        leaseMs: CHANNEL_DISPATCH_LEASE_MS,
        limit: 1,
        // Handed out once, ever: a second attempt could only be a replay of a turn that may have run.
        maxAttempts: 1,
      });
      if (!item) return false;
      const tenantId = item.tenantId;
      await runAsTenant(tenantId, async () => {
        try {
          const parsed = payloadSchema.safeParse(item.payload);
          if (!parsed.success) {
            log("channel-dispatch-bad-payload", { runId: item.key });
            await closeCard(tenantId, item.key, true);
          } else if (parsed.data.ownerUserId !== tenantId) {
            // The claimed row's tenant is the authority; a payload naming anybody else is not run.
            log("channel-dispatch-tenant-mismatch", { runId: item.key });
            await closeCard(tenantId, item.key, true);
          } else {
            await run(tenantId, item.key, parsed.data);
          }
        } catch (error) {
          log("channel-dispatch-error", {
            runId: item.key,
            reason: reasonOf(error),
          });
          await closeCard(tenantId, item.key, true);
        } finally {
          await deps.queue.finish({
            kind: item.kind,
            key: item.key,
            owner: deps.owner,
          });
        }
      });
      return true;
    },
  };
}

export type ChannelDispatch = ReturnType<typeof createChannelDispatch>;

/** `POST /api/channels/:channelId/dispatch` — mounted beside the channel routes. */
export function createChannelDispatchRoutes(
  service: Pick<ChannelDispatch, "submit">,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.onError((error, context) => {
    if (error instanceof QuotaExceeded) return context.json(error.body, 402);
    if (error instanceof ChannelDispatchNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof ChannelDispatchRefusedError)
      return context.json({ error: error.message }, 400);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return context.json({ error: "请求内容不正确。" }, 400);
    console.error(
      JSON.stringify({
        type: "channel-dispatch-route-error",
        reason: reasonOf(error),
      }),
    );
    return context.json({ error: "派活没有成功，请稍后再试。" }, 500);
  });
  routes.post("/:channelId/dispatch", requireUser, async (context) =>
    context.json(
      await service.submit(
        context.var.actor,
        context.req.param("channelId"),
        await context.req.json(),
      ),
      202,
    ),
  );
  return routes;
}
