import { describe, expect, test } from "bun:test";
import {
  createApprovalService,
  NOT_ASKED,
  withoutAsking,
} from "../src/approvals/service";
import type { ApprovalCandidate } from "../src/approvals/types";

/**
 * `wouldAllow`：交付复跑前的只读预判（规格 2026-11-25-borrowed-improvements §5.5）。和 `gate` 同一套判断，
 * 但不开审批请求、不记决定、不调审查模型；只有直接放行才答 true。`withoutAsking` 里的 `gate` 永远不开请求。
 */

const OWNER = "person-1";

const command = (text: string): ApprovalCandidate => ({
  actorId: OWNER,
  botId: "bot-1",
  toolRef: "computer_run_command",
  effect: "write",
  scope: "workspace",
  args: { command: text },
  target: { pageUrl: "" },
  subject: { command: text, runner: false },
});

type Seen = {
  opened: unknown[];
  recorded: unknown[];
  reviewed: number;
};

function service(
  options: {
    askBeforeChanges?: boolean;
    autoReview?: boolean;
    inTask?: boolean;
    prior?: unknown;
  } = {},
) {
  const seen: Seen = { opened: [], recorded: [], reviewed: 0 };
  const store = {
    policy: {
      preferences: async () => ({
        enabled: options.askBeforeChanges ?? false,
        autoReview: options.autoReview ?? false,
      }),
      teamSettings: async () => ({
        customRulesEnabled: true,
        enforceAutoReview: false,
        enforceDangerousCommands: false,
        hostCommandsCap: "allow",
      }),
      teamRules: async () => [],
      employee: async () => undefined,
      reviewerGuidance: async () => null,
      conversationGrants: async () => [],
      findEquivalent: async () => options.prior,
      recordDecision: async (decision: unknown) => {
        seen.recorded.push(decision);
      },
    },
    rules: async () => [],
    enabled: async () => options.askBeforeChanges ?? false,
    asksEveryChange: async () => options.inTask ?? false,
    open: async (action: unknown) => {
      seen.opened.push(action);
      return { id: "req-1", status: "pending", action };
    },
  };
  const approvals = createApprovalService(
    store as never,
    undefined,
    undefined,
    {
      review: async () => {
        seen.reviewed++;
        return JSON.stringify({ verdict: "approve", reason: "ok" });
      },
    },
  );
  return { approvals, seen };
}

const inConversation = (candidate: ApprovalCandidate): ApprovalCandidate => ({
  ...candidate,
  continuation: {
    threadId: "thread-1",
    runId: "run-1",
    toolCallId: "call-deliver",
    toolName: "deliver_task",
    args: {},
    messages: [{ id: "u1", role: "user", content: "做吧" }],
  } as never,
});

describe("wouldAllow", () => {
  test("规则直接放行：true，什么都不写", async () => {
    const { approvals, seen } = service();
    expect(await approvals.wouldAllow(command("bun test"))).toBe(true);
    expect(seen).toEqual({ opened: [], recorded: [], reviewed: 0 });
  });

  test("本人开着「改动前先问」：false，不开请求、不记决定", async () => {
    const { approvals, seen } = service({ askBeforeChanges: true });
    expect(await approvals.wouldAllow(command("bun test"))).toBe(false);
    expect(seen).toEqual({ opened: [], recorded: [], reviewed: 0 });
  });

  test("要审查的：不调审查模型，答 false", async () => {
    const { approvals, seen } = service({ autoReview: true });
    expect(await approvals.wouldAllow(command("bun test"))).toBe(false);
    expect(seen.reviewed).toBe(0);
    expect(seen.opened).toEqual([]);
    expect(seen.recorded).toEqual([]);
  });

  test("危险命令的底线要问：false", async () => {
    const { approvals, seen } = service();
    expect(await approvals.wouldAllow(command("rm -rf / && bun test"))).toBe(
      false,
    );
    expect(seen.opened).toEqual([]);
  });

  test("从例行检查开出的任务每次改动都问：false", async () => {
    const { approvals } = service({ inTask: true });
    expect(
      await approvals.wouldAllow(inConversation(command("bun test"))),
    ).toBe(false);
  });

  test("这段对话里同样的动作还在等审批或被拒绝过：false", async () => {
    for (const prior of [
      { status: "pending", action: {} },
      { status: "denied", decision: "deny", action: { userTurns: 1 } },
    ]) {
      const { approvals } = service({ prior });
      expect(
        await approvals.wouldAllow(inConversation(command("bun test"))),
      ).toBe(false);
    }
  });
});

describe("withoutAsking", () => {
  test("规则要问的动作：拒绝，不开审批请求", async () => {
    const { approvals, seen } = service({ askBeforeChanges: true });
    await expect(
      withoutAsking(() => approvals.gate(inConversation(command("bun test")))),
    ).rejects.toThrow(NOT_ASKED);
    expect(seen.opened).toEqual([]);
  });

  test("规则放行的动作照常放行", async () => {
    const { approvals, seen } = service();
    expect(
      await withoutAsking(() => approvals.gate(command("bun test"))),
    ).toBeUndefined();
    expect(seen.opened).toEqual([]);
  });

  test("外面照旧开请求", async () => {
    const { approvals, seen } = service({ askBeforeChanges: true });
    await expect(
      approvals.gate(inConversation(command("bun test"))),
    ).rejects.toThrow("waiting for your approval");
    expect(seen.opened).toHaveLength(1);
  });
});
