import { buildResponsibilityTurn } from "@openbot/shared/responsibility-turn";
import type { ComponentCatalog } from "@openbot/toolkit/ports";
import { z } from "zod";
import { canUseComputer } from "../agents/computer-access";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import { serverTurnAdmission } from "../agents/turn-admission";
import {
  parseApprovalContinuation,
  parseApprovalResult,
} from "../approvals/types";
import type { AuditInitiator, AuditStore } from "../audit";
import type { ChannelStore } from "../channels/routes";
import type { ComputerGateway } from "../computer/gateway";
import { createHeadlessComputerTools } from "../computer/headless-tools";
import type { Database } from "../db/client";
import type { DeliveryScope } from "../delivery/types";
import type { LearningThread } from "../learning/runtime";
import type { QuotaService } from "../quota/limits";
import {
  createTurnRunner,
  type IntelligenceLike,
  type RunnerLike,
} from "../routines/run-turn";
import type { TaskProjector } from "../tasks/projector";
import { productHeadlessBoundary } from "../telemetry/product-boundaries";
import { markUntrusted } from "../untrusted-content";
import { createWorkQueue } from "../work/queue";
import {
  type BusyRetry,
  createResponsibilityEngine,
  type ResponsibilityEngine,
} from "./engine";
import { responsibilityTools } from "./tools";
import { type ResponsibilityStore, whyItRepeats } from "./types";

/**
 * The deployment's responsibility engine: a responsibility's turn, with the computer when the Bot
 * may use it and the responsibility's own tools, and its reply posted to the channel it watches.
 *
 * Moved out of index.ts verbatim. `notify` is taken as a function because delivery is assigned after
 * this is created, and a reply reads it when it is posted, never when this is built.
 *
 * The fork's additions ride along, each optional so a test can leave them out: a responsibility run
 * is board work (ticket 020: `board`, `quota`, `deviceIdOf`), frozen for a banned workspace (spec J5:
 * `accessRevokedOf`), and its computer tools say where they act and what the person disabled
 * (`machine`, `appsFor`, `disabledFor`). The turn runner is the server's (routines/run-turn.ts), so
 * its usage row and card ports are always filled in.
 */
export function createServerResponsibilityEngine(deps: {
  productTelemetry?: import("../telemetry/product").ProductTelemetry;
  database: Database;
  responsibilityStore: ResponsibilityStore;
  routineIntelligence: IntelligenceLike;
  routineAgentRunner: RunnerLike;
  componentCatalog: ComponentCatalog;
  buildAgentFor: Parameters<typeof createTurnRunner>[0]["buildAgentFor"];
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  computerGateway: ComputerGateway | undefined;
  agentProfileStore: AgentProfileStore;
  bootAuditStore: AuditStore;
  signInService: Parameters<typeof createHeadlessComputerTools>[0]["signIn"];
  /** Automatic Learning, when this deployment has the optional Intelligence: which space a thread joins. */
  copilotRuntime?: {
    learning?: {
      containerForThread(input: LearningThread): Promise<string | undefined>;
    };
  };
  channelStore: ChannelStore;
  notify: (
    scope: DeliveryScope,
    input: { id: string; kind: "reply"; text: string },
  ) => Promise<void>;
  /** How long a run waits for a busy conversation. `BUSY_RETRY` unless a test says otherwise. */
  busyRetry?: BusyRetry;
  /** An event that woke a coworker is board work too (ticket 020): same projector, same ceiling. */
  board?: Pick<TaskProjector, "opened" | "finished">;
  quota?: QuotaService;
  deviceIdOf?: (agentId: string, taskRef?: string) => Promise<string | null>;
  /** Spec J5: a responsibility woken for a banned workspace stays in place until the ban is lifted. */
  accessRevokedOf?: (userId: string) => Promise<boolean>;
  /** Where the computer tools act, so their descriptions tell the model the truth (G5). */
  machine?: "device" | "workspace";
  /** Whether this run gets the local-app tools (device MCP bridge §4.1). */
  appsFor?: (agentId: string, actorId: string) => Promise<boolean>;
  /** The tools this person disabled for this Bot (SEC1 D4). */
  disabledFor?: (
    actorId: string,
    agentId: string,
  ) => Promise<(toolRef: string) => boolean>;
}): ResponsibilityEngine {
  const {
    database,
    responsibilityStore,
    routineIntelligence,
    routineAgentRunner,
    componentCatalog,
    buildAgentFor,
    actorFor,
    computerGateway,
    agentProfileStore,
    bootAuditStore,
    signInService,
    copilotRuntime,
    channelStore,
  } = deps;
  const responsibilityQueue = createWorkQueue(database);
  const responsibilityEngine: ResponsibilityEngine = createResponsibilityEngine(
    {
      store: responsibilityStore,
      queue: responsibilityQueue,
      ...(deps.busyRetry ? { busyRetry: deps.busyRetry } : {}),
      ...(deps.board ? { board: deps.board } : {}),
      ...(deps.quota ? { quota: deps.quota } : {}),
      ...(deps.deviceIdOf ? { deviceIdOf: deps.deviceIdOf } : {}),
      ...(deps.accessRevokedOf
        ? { accessRevokedOf: deps.accessRevokedOf }
        : {}),
      runTurn: async (context) => {
        const initiator: AuditInitiator = {
          kind: "responsibility",
          id: context.responsibilityId,
        };
        const tools = responsibilityTools({
          store: responsibilityStore,
          engine: responsibilityEngine,
          ownerUserId: context.ownerUserId,
          agentId: context.agentId,
          channelId: context.channelId,
          responsibilityRunId: context.runId,
        });
        const runner = createTurnRunner({
          ...(deps.productTelemetry
            ? {
                prepareRunInput: productHeadlessBoundary(deps.productTelemetry),
                onKnownStop: deps.productTelemetry.stopKnown,
              }
            : {}),
          admission: serverTurnAdmission,
          intelligence: routineIntelligence,
          runner: routineAgentRunner,
          components: componentCatalog,
          buildAgentFor: (input) => buildAgentFor({ ...input, initiator }),
          toolsForTurn: async () => {
            const actor = await actorFor(context.ownerUserId);
            // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
            const computer =
              computerGateway &&
              canUseComputer(
                await agentProfileStore
                  .get(actor, context.agentId)
                  .catch(() => null),
                actor,
              )
                ? createHeadlessComputerTools({
                    gateway: computerGateway,
                    seat: await computerGateway.seatFor(
                      context.agentId,
                      actor.id,
                    ),
                    actor: { id: actor.id, userId: actor.id, initiator },
                    auditStore: bootAuditStore,
                    ...(signInService ? { signIn: signInService } : {}),
                    ...(deps.machine ? { machine: deps.machine } : {}),
                    ...(deps.appsFor
                      ? { apps: await deps.appsFor(context.agentId, actor.id) }
                      : {}),
                    ...(deps.disabledFor
                      ? {
                          disabled: await deps.disabledFor(
                            actor.id,
                            context.agentId,
                          ),
                        }
                      : {}),
                  })
                : [];
            return [
              ...computer,
              ...tools.map((tool) => ({
                definition: {
                  name: tool.name,
                  description: tool.description,
                  parameters: z.toJSONSchema(tool.parameters),
                },
                execute: (args: unknown) => tool.execute(args),
              })),
            ];
          },
          learningContainerForThread: (input) =>
            copilotRuntime?.learning?.containerForThread(input) ??
            Promise.resolve(undefined),
        });
        const saved = context.continuation;
        const snapshot = saved
          ? parseApprovalContinuation(saved.waiting.continuation)
          : undefined;
        const toolResult = saved
          ? parseApprovalResult(saved.response)
          : undefined;
        return runner({
          ownerUserId: context.ownerUserId,
          routineId: context.responsibilityId,
          agentId: context.agentId,
          threadId: context.threadId,
          initiator,
          signal: context.signal,
          ...(snapshot && toolResult
            ? {
                continuation: {
                  snapshot,
                  result: toolResult,
                  messageId: `responsibility-result:${context.runId}:${snapshot.toolCallId}`,
                },
              }
            : {}),
          instruction: buildResponsibilityTurn({
            instruction: context.instruction,
            successCriteria: context.successCriteria,
            progress: context.progress,
            trigger: context.event,
            eventData: markUntrusted(
              JSON.stringify(context.event.payload),
              `${context.event.source} event`,
            ),
            responsibilityId: context.responsibilityId,
            ...(context.repeats
              ? { repeats: whyItRepeats(context.repeats) }
              : {}),
          }),
        });
      },
      onReply: async (context, text) => {
        await channelStore.recordActivity(
          await actorFor(context.ownerUserId),
          context.channelId,
          { text, agentId: context.agentId, at: new Date() },
          { id: `responsibility:${context.runId}` },
        );
        await deps.notify(
          {
            ownerUserId: context.ownerUserId,
            channelId: context.channelId,
            agentId: context.agentId,
            threadId: context.threadId,
          },
          { id: `responsibility:${context.runId}`, kind: "reply", text },
        );
      },
    },
  );
  return responsibilityEngine;
}
