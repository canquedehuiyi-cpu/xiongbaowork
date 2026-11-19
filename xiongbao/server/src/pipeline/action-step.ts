import type { Message } from "@ag-ui/client";
import type { AuditInitiator } from "../audit";
import {
  type ApprovalContinuation,
  withApprovalContext,
} from "../approvals/types";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import type { StepResult } from "./store";

/**
 * WF7 action steps (spec 2026-11-04-wf7 §3.5, D6 = A-1; ADR-0001 补充（2026-11-04）).
 *
 * The one exception to ADR-0001's "every step is a coworker's turn": a fixed MCP tool call, made as
 * the step's coworker with the arguments written in the editor, with no turn and no model. The
 * exception is only that; every gate a turn passes is passed here, in the ADR's order, and a gate
 * that refuses means the tool is not called at all:
 *
 *  1. `guardBotTurn` — the coworker is paused (the same function a turn asks).
 *  2. `headlessTurnRefusal` — Use Bots is off, or another enterprise control refuses.
 *  3. I6 — asked by the orchestrator before this runner, with the same check as a worker step.
 *  4. MCP only — a `<serverId>/<toolName>` reference to a tool granted to this coworker; never a
 *     computer action, a `host/*` command, a hand-off (`bot/*`) or one of this product's own tools.
 *  5. The approval gate inside `callTool`, asked as the run's initiator. When it asks, the step parks
 *     with the approval's id; the run is driven again after the decision and the gate's own
 *     re-entry (the same run, thread and call id) carries the approved call out exactly once, or
 *     refuses it. SEC1's "disabled" is refused there too.
 *
 * Arguments are the step's templates with `{{key}}` replaced by the declared inputs and earlier
 * outputs, as text only (never evaluated): those outputs may have been written by a model.
 */

/** Servers that are not someone's MCP server: hand-offs, host commands, this product's own tools. */
const RESERVED_SERVERS = new Set(["bot", "host", "openbot", "computer"]);

/** Whether a tool reference names an MCP tool an action step may call (gate 4, its static half). */
export function isMcpToolRef(ref: string): boolean {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return false;
  const server = ref.slice(0, slash);
  const tool = ref.slice(slash + 1);
  if (/\s/.test(ref)) return false;
  if (RESERVED_SERVERS.has(server.toLowerCase())) return false;
  return !/^(computer|host)_/i.test(tool);
}

/** The longest an argument may be once its template is filled. */
export const MAX_ARGUMENT_LENGTH = 10000;

/**
 * Fill each argument's `{{key}}` from `values`, as plain text. A key with no value (its step was
 * skipped or failed) is a refusal, never an empty string: a call made on a gap is a guess.
 */
export function fillArguments(
  templates: Record<string, string>,
  values: Record<string, string | undefined>,
): { ok: true; args: Record<string, string> } | { ok: false; error: string } {
  const args: Record<string, string> = {};
  for (const [name, template] of Object.entries(templates)) {
    let missing: string | undefined;
    const filled = template.replace(
      /\{\{\s*([^{}\s]*)\s*\}\}/g,
      (_match, key: string) => {
        const value = values[key];
        if (value === undefined) {
          missing ??= key;
          return "";
        }
        return value;
      },
    );
    if (missing !== undefined)
      return {
        ok: false,
        error: `参数 ${name} 引用的 ${missing} 没有产出（被跳过或已失败），动作没有执行。`,
      };
    if (filled.length > MAX_ARGUMENT_LENGTH)
      return {
        ok: false,
        error: `参数 ${name} 填入后超过 ${MAX_ARGUMENT_LENGTH} 字，动作没有执行。`,
      };
    args[name] = filled;
  }
  return { ok: true, args };
}

/** Which gate refused an action, as the audit row and the step's error name it. */
export type ActionGate =
  | "guardBotTurn"
  | "headlessTurnRefusal"
  | "mcp_only"
  | "not_granted"
  | "arguments";

export type ActionStepDependencies = {
  /** `agents/lifecycle.ts` `guardBotTurn`: throws when the coworker is paused. */
  guardTurn(input: { ownerUserId: string; agentId: string }): Promise<unknown>;
  /** `admin/controls.ts` `headlessTurnRefusal`: a sentence when the turn would be refused. */
  refusal(input: {
    ownerUserId: string;
    agentId: string;
  }): Promise<string | null>;
  /** Whether this MCP tool is granted to this coworker (the plugin grant `callTool` also asks). */
  granted(input: { agentId: string; tool: string }): Promise<boolean>;
  /** `plugins/store.ts` `callTool`, the governed call with the approval gate inside it. */
  callTool(input: {
    ref: string;
    args: Record<string, unknown>;
    botId: string;
    actorId: string;
    initiator: AuditInitiator;
  }): Promise<{ text: string; isError: boolean }>;
  /** One audit row for a refusal before `callTool` (which writes its own rows). */
  audit?(event: {
    tool: string;
    botId: string;
    actorId: string;
    initiator: AuditInitiator;
    gate: ActionGate;
    reason: string;
  }): Promise<void>;
};

/** What the orchestrator hands the runner for one action step. */
export type ActionStepInput = {
  tenantId: string;
  runId: string;
  /** The step's card reference: the approval's run id, so a park lands on this step's card. */
  stepRunRef: string;
  stepId: string;
  agentId: string;
  tool: string;
  args: Record<string, string>;
  /** The declared inputs' values; `undefined` for one that was never produced. */
  values: Record<string, string | undefined>;
  initiatedBy: string;
};

export type ActionStepRunner = (input: ActionStepInput) => Promise<StepResult>;

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split("\n")[0] ?? "").slice(0, 400);
}

export function createActionStepRunner(
  deps: ActionStepDependencies,
): ActionStepRunner {
  return async (input) => {
    // The trail names this run as what caused the call, as a step's turn does (`group-run:<id>`).
    const initiator: AuditInitiator = {
      kind: "routine",
      id: `group-run:${input.runId}`,
    };
    const refuse = async (
      gate: ActionGate,
      reason: string,
    ): Promise<StepResult> => {
      await deps
        .audit?.({
          tool: input.tool,
          botId: input.agentId,
          actorId: input.initiatedBy,
          initiator,
          gate,
          reason,
        })
        .catch(() => undefined);
      return { status: "failed", error: reason };
    };
    try {
      await deps.guardTurn({
        ownerUserId: input.initiatedBy,
        agentId: input.agentId,
      });
    } catch (error) {
      return refuse(
        "guardBotTurn",
        `员工 ${input.agentId} 已暂停或当前不能工作，动作没有执行（${message(error)}）。`,
      );
    }
    const refused = await deps
      .refusal({ ownerUserId: input.initiatedBy, agentId: input.agentId })
      .catch((error: unknown) => `管控检查失败：${message(error)}`);
    if (refused)
      return refuse("headlessTurnRefusal", `动作没有执行：${refused}`);
    if (!isMcpToolRef(input.tool))
      return refuse(
        "mcp_only",
        `动作步骤只能调用 MCP 工具，${input.tool} 不是，动作没有执行。`,
      );
    const granted = await deps
      .granted({ agentId: input.agentId, tool: input.tool })
      .catch(() => false);
    if (!granted)
      return refuse(
        "not_granted",
        `员工 ${input.agentId} 没有被授权使用工具 ${input.tool}，动作没有执行。`,
      );
    const filled = fillArguments(input.args, input.values);
    if (!filled.ok) return refuse("arguments", filled.error);

    /*
     * The approval gate's identity for this call: the step's card reference as the run, a thread
     * named after it (as a step's turn is), and the step id as the call. Driven again after the
     * person's decision, the same three find the same request, so the approved call is carried out
     * once and a repeat replays its saved result.
     */
    const continuation: ApprovalContinuation = {
      runId: input.stepRunRef,
      threadId: `group-run-${input.stepRunRef}`,
      toolCallId: input.stepId,
      toolName: input.tool,
      args: filled.args,
      messages: [] as Message[],
      state: {},
      context: [],
      forwardedProps: {},
      initiator,
    };
    try {
      const result = await withApprovalContext(continuation, () =>
        deps.callTool({
          ref: input.tool,
          args: filled.args,
          botId: input.agentId,
          actorId: input.initiatedBy,
          initiator,
        }),
      );
      if (result.isError)
        return {
          status: "failed",
          error: `工具 ${input.tool} 报告失败：${result.text.slice(0, 400)}`,
        };
      return { status: "done", output: result.text };
    } catch (error) {
      if (error instanceof HeadlessToolSuspension) {
        const approvalId =
          typeof error.waiting.approvalId === "string"
            ? error.waiting.approvalId
            : undefined;
        if (approvalId) return { status: "awaiting_action", approvalId };
        return {
          status: "failed",
          error: `工具 ${input.tool} 在等待无法在流程里处理的操作，动作没有执行。`,
        };
      }
      return {
        status: "failed",
        error: `工具 ${input.tool} 没有执行：${message(error)}`,
      };
    }
  };
}
