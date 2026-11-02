/**
 * D06 AUT3 + C2 + C3: carrying out one automation firing whose target is a Waker.
 *
 * THE SAME GATES AS A ROUTINE FIRING, IN THE SAME ORDER (`routines/runner.ts`): the conversation
 * the reply lands in, an administrator's ban (J5), a paused Waker, the month's task ceiling, then
 * the card, then the turn. A refused gate is `skipped`, never `failed`, so a ban, a pause or a full
 * month never trips the breaker. Whether the automation is switched on, spent or deleted was already
 * answered by `beginFiring`, under the automation's row lock, before this file is reached.
 *
 * ITS OWN CARD (C2). Every firing opens one board card before the turn — lane `routine` (the board's
 * 自主工作), trigger source `automation:<trigger kind>`, keyed by the firing id — and tells the turn
 * runner the card is taken (`cardOwnedByCaller`), so one firing is one card and one unit of the month.
 *
 * THE BREAKER (C3). Ten failed firings in a row switch the automation off. The tenth firing's card is
 * finished as failed with `deliverableRef.kind = 'circuit_breaker'`, so it reads 已结束-失败 and sits
 * in 需要关注 until a person files it away; the conversation is told once, in Chinese.
 *
 * THE TENANT comes from the claimed automation row (D12: tenant = owner), never from a default.
 */
import { isBotPaused as defaultIsBotPaused } from "../agents/lifecycle";
import type { AgentActor } from "../agents/profile-types";
import type { AuditInitiator } from "../audit";
import type { AgentChannel, ChannelStore } from "../channels/routes";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import { QuotaExceeded, type QuotaService } from "../quota/limits";
import type { TurnRunner } from "../routines/runner";
import type { TaskProjector } from "../tasks/projector";
import { assertPersonTenant, runAsTenant } from "../tenant/context";
import type { AutomationFiring, AutomationStore } from "./store";

/** Consecutive failed firings after which an automation stops being fired (C3). */
export const AUTOMATION_BREAKER_LIMIT = 10;

export const AUTOMATION_SKIPPED_ACCESS_REVOKED =
  "这个账号的访问权限已被收回，本次自动任务没有执行。";
export const AUTOMATION_SKIPPED_BOT_PAUSED =
  "这位 Waker 已暂停，本次自动任务没有执行。";
export const AUTOMATION_NOT_A_WAKER = "这个自动任务的执行对象不是 Waker。";

const MAX_NOTIFIED_REASON = 160;

type CardSource = Parameters<TaskProjector["opened"]>[0]["source"];

/**
 * The board, as this executor writes it.
 *
 * Method syntax on purpose: `TaskProjector.opened` types `triggerSource` as the one value its first
 * caller needed (`"proactive"`), while the column is free text and the projector writes whatever it
 * is given. Declared as methods, the real projector is accepted here and `automation:<kind>` is
 * passed through without widening that type in this package.
 */
export type AutomationBoard = {
  opened(input: {
    tenantId: string;
    title: string;
    executorAgentId?: string | null;
    source: CardSource;
    triggerSource?: string | null;
    channelRef?: string;
    runRef?: string;
    deviceId?: string | null;
  }): Promise<string>;
  finished(input: {
    tenantId: string;
    runRef: string;
    deliverableRef?: unknown;
    failed?: boolean;
  }): Promise<void>;
};

export type WakerAutomationExecutorDeps = {
  store: Pick<
    AutomationStore,
    "finishFiring" | "consecutiveFailures" | "tripBreaker"
  >;
  channels: Pick<ChannelStore, "direct" | "recordActivity">;
  /** Who the owner is as an actor: their grants and connections resolve to them. */
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  runTurn: TurnRunner;
  board?: AutomationBoard;
  quota?: Pick<QuotaService, "assertCapacity">;
  accessRevokedOf?: (userId: string) => Promise<boolean>;
  isBotPaused?: (ownerUserId: string, agentId: string) => Promise<boolean>;
  deviceIdOf?: (agentId: string) => Promise<string | null>;
};

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shorten(reason: string): string {
  const codePoints = Array.from(reason);
  if (codePoints.length <= MAX_NOTIFIED_REASON) return reason;
  return `${codePoints.slice(0, MAX_NOTIFIED_REASON - 1).join("")}…`;
}

/** The turn's user message. The automation's name is the job a person described. */
export function automationInstruction(name: string): string {
  return `自动任务「${name}」已触发，请完成这项任务。`;
}

export function breakerMessage(name: string): string {
  return `自动任务「${name}」已连续失败 ${AUTOMATION_BREAKER_LIMIT} 次，已自动停用。请排查原因后重新启用。`;
}

export function createWakerAutomationExecutor(
  deps: WakerAutomationExecutorDeps,
): { run(firing: AutomationFiring): Promise<void> } {
  const { store, channels, board } = deps;
  const isBotPaused = deps.isBotPaused ?? defaultIsBotPaused;

  function log(type: string, firing: AutomationFiring, error: unknown) {
    console.error(
      JSON.stringify({
        type,
        automationId: firing.automation.id,
        firingId: firing.id,
        reason: reasonOf(error),
      }),
    );
  }

  async function runAsOwner(
    firing: AutomationFiring,
    ownerUserId: string,
  ): Promise<void> {
    const { automation } = firing;
    if (automation.target.kind !== "waker") {
      await store.finishFiring(firing.id, "failed", AUTOMATION_NOT_A_WAKER);
      return;
    }
    const agentId = automation.target.agentId;
    const runRef = firing.id;
    let actor: AgentActor | null = null;
    let channel: AgentChannel | null = null;
    let carded = false;

    /** One line in the owner's conversation with the Waker. Never a throw. */
    async function say(text: string): Promise<void> {
      if (!channel || !actor) return;
      try {
        await channels.recordActivity(actor, channel.id, {
          text,
          agentId,
          at: new Date(),
        });
      } catch (error) {
        log("automation-activity-unrecorded", firing, error);
      }
    }

    async function openCard(): Promise<void> {
      if (!board) return;
      await board.opened({
        tenantId: ownerUserId,
        title: automation.name,
        executorAgentId: agentId,
        source: "routine",
        triggerSource: `automation:${firing.triggerKind}`,
        ...(channel ? { channelRef: channel.id } : {}),
        runRef,
        deviceId: (await deps.deviceIdOf?.(agentId)) ?? null,
      });
      carded = true;
    }

    async function closeCard(
      input: { failed?: boolean; deliverableRef?: unknown } = {},
    ) {
      if (!carded || !board) return;
      try {
        await board.finished({ tenantId: ownerUserId, runRef, ...input });
      } catch (error) {
        log("automation-board-close-failed", firing, error);
      }
    }

    /** A failure: recorded, counted by the breaker, and the card closed accordingly. */
    async function fail(reason: string): Promise<void> {
      await store.finishFiring(firing.id, "failed", reason);
      let failures = 0;
      let tripped = false;
      try {
        failures = await store.consecutiveFailures(automation.id);
        if (failures >= AUTOMATION_BREAKER_LIMIT) {
          await store.tripBreaker(automation.id, firing.id);
          tripped = true;
        }
      } catch (error) {
        log("automation-breaker-failed", firing, error);
      }
      if (tripped) {
        // C3 needs a card to show: a firing that failed before its card was opened gets one now.
        if (!carded) {
          try {
            await openCard();
          } catch (error) {
            log("automation-board-open-failed", firing, error);
          }
        }
        await closeCard({
          failed: true,
          deliverableRef: {
            kind: "circuit_breaker",
            automationId: automation.id,
            consecutiveFailures: failures,
            reason: shorten(reason),
          },
        });
        await say(breakerMessage(automation.name));
        return;
      }
      await closeCard({ failed: true });
      // Only the first failure after a success is said out loud; the firings carry the rest.
      if (failures === 1) {
        await say(`自动任务「${automation.name}」执行失败：${shorten(reason)}`);
      }
    }

    // 1. The conversation the reply lands in: the owner's own with this Waker. An owner who can no
    // longer be resolved as an actor is a failure like any other, so the breaker can see it.
    try {
      actor = await deps.actorFor(ownerUserId);
      channel = await channels.direct(actor, agentId);
    } catch (error) {
      await fail(reasonOf(error));
      return;
    }

    // 2. Spec J5: a ban freezes the work.
    if (await deps.accessRevokedOf?.(ownerUserId)) {
      await store.finishFiring(
        firing.id,
        "skipped",
        AUTOMATION_SKIPPED_ACCESS_REVOKED,
      );
      return;
    }

    // 3. A paused Waker's firing is skipped, so a long pause never trips the breaker.
    if (await isBotPaused(ownerUserId, agentId)) {
      await store.finishFiring(
        firing.id,
        "skipped",
        AUTOMATION_SKIPPED_BOT_PAUSED,
      );
      return;
    }

    // 4. The month's ceiling, asked before the model is dialled.
    try {
      await deps.quota?.assertCapacity(ownerUserId, "tasksPerMonth");
    } catch (error) {
      if (error instanceof QuotaExceeded) {
        await store.finishFiring(firing.id, "skipped", error.message);
        await say(error.message);
        return;
      }
      throw error;
    }

    // 5. The firing's own card (C2). Under a ceiling, a card refused is a firing refused.
    try {
      await openCard();
    } catch (error) {
      if (deps.quota) {
        if (error instanceof QuotaExceeded) {
          await store.finishFiring(firing.id, "skipped", error.message);
          await say(error.message);
        } else {
          await fail(reasonOf(error));
        }
        return;
      }
      log("automation-board-open-failed", firing, error);
    }

    // 6. The turn.
    let replyText: string;
    try {
      ({ replyText } = await deps.runTurn({
        ownerUserId,
        routineId: `automation:${automation.id}`,
        agentId,
        threadId: channel.threadId,
        instruction: automationInstruction(automation.name),
        initiator: {
          kind: "routine",
          id: `automation:${automation.id}`,
        } satisfies AuditInitiator,
        // The card opened above is this firing's record; the runner files none of its own.
        cardOwnedByCaller: carded,
      }));
    } catch (error) {
      if (error instanceof HeadlessToolSuspension) {
        await store.finishFiring(firing.id, "waiting", error.message);
        await closeCard();
        await say(error.message);
        return;
      }
      await fail(reasonOf(error));
      return;
    }

    await say(replyText);
    await store.finishFiring(firing.id, "succeeded");
    await closeCard();
  }

  return {
    async run(firing) {
      try {
        const ownerUserId = assertPersonTenant(firing.automation.tenantId);
        await runAsTenant(ownerUserId, async () => {
          await runAsOwner(firing, ownerUserId);
        });
      } catch (error) {
        // `run` never throws: an outcome that could not be recorded is said out loud instead.
        log("automation-run-crashed", firing, error);
        await store
          .finishFiring(firing.id, "failed", reasonOf(error))
          .catch(() => undefined);
      }
    },
  };
}
