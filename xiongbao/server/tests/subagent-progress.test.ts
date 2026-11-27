import { describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type AgentSubscriber,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
  type RunAgentParameters,
  type RunAgentResult,
} from "@ag-ui/client";
import { SEGMENT_LIMIT_MESSAGE } from "@xiongbao/toolkit/headless-tools";
import type { RunnerLike } from "@xiongbao/toolkit/run-turn";
import { Observable } from "rxjs";
import { readSubagentResult } from "../../shared/subagent";
import { createSubagents } from "../src/agents/subagent";
import { FAILURE_HANDOFF_CHARS } from "../src/tasks/failure-handoff";
import { runAsTenant } from "../src/tenant/context";

/*
 * 子代理没做完时交回进度（设计稿 2026-11-25-borrowed-improvements 5.4）：`run_subagent` 走到 error 分支，结果里在
 * `error` 之外加 `progress`：子代理线程最后至多 5 次工具调用的摘要和写过的文件，经过脱敏，序列化后不超过
 * 1500 字。父运行被中止时照旧抛出，不返回结果。
 */

const OK = JSON.stringify({ ok: true });

/** 子代理线程里的一次工具调用：助手发起它，工具答复它。 */
function call(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  answer = OK,
): Message[] {
  return [
    {
      id: `assistant-${id}`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: { name: tool, arguments: JSON.stringify(args) },
        },
      ],
    },
    { id: `tool-${id}`, role: "tool", toolCallId: id, content: answer },
  ] as Message[];
}

/**
 * 一个子代理：做了 `calls` 这些工具调用，然后这一轮以 `error` 结束（RUN_ERROR）；`hold` 时一直做到被停下。
 */
class Scripted extends AbstractAgent {
  private stop: () => void = () => {};
  constructor(
    private readonly calls: Message[],
    private readonly options: { error?: string; hold?: boolean } = {},
  ) {
    super({ agentId: "bot" });
  }
  override async runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    const input = parameters as RunAgentInput;
    const emit = (event: Record<string, unknown>) =>
      subscriber?.onEvent?.({ event } as unknown as Parameters<
        NonNullable<AgentSubscriber["onEvent"]>
      >[0]);
    await emit({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    });
    this.messages = [...this.messages, ...this.calls] as typeof this.messages;
    if (this.options.hold)
      await new Promise<void>((resolve) => {
        this.stop = resolve;
      });
    await emit({
      type: EventType.RUN_ERROR,
      message: this.options.error ?? SEGMENT_LIMIT_MESSAGE,
    });
    return { result: undefined, newMessages: [] };
  }
  override abortRun(): void {
    this.stop();
  }
  override run(): Observable<BaseEvent> {
    throw new Error("runAgent is the only entry used here");
  }
  override clone(): Scripted {
    return this;
  }
}

function subagentTool(agent: AbstractAgent) {
  const runner: RunnerLike = {
    run: ({ agent: running, input }) =>
      new Observable((observer) => {
        running
          .runAgent(input, { onEvent: ({ event }) => observer.next(event) })
          .then(
            () => observer.complete(),
            (error) => observer.error(error),
          );
      }),
    stop: async () => {
      agent.abortRun();
      return true;
    },
  };
  return createSubagents({
    turn: {
      admission: async ({ signal }) => signal ?? new AbortController().signal,
      intelligence: {
        getOrCreateThread: async () => undefined,
        getThreadMessages: async () => ({ messages: [] }),
        ɵacquireThreadLock: async () => undefined,
        ɵrenewThreadLock: async () => undefined,
        ɵcleanupThreadLock: async () => undefined,
      },
      runner,
    },
    buildAgentFor: async () => agent,
    withdrawApprovals: async () => undefined,
  }).toolForRun({
    actorId: "owner",
    botId: "bot",
    threadId: "conversation",
    initiator: { kind: "person" },
  });
}

const ask = (agent: AbstractAgent, signal = new AbortController().signal) =>
  runAsTenant(
    "owner",
    () =>
      subagentTool(agent).execute(
        { task: "把三家的报价做成表", answer: "一张表" },
        { toolCallId: "sub-progress", signal },
      ) as Promise<string>,
  );

describe("子代理没做完时交回进度", () => {
  test("6 次工具调用后步数到顶：交回最后 5 次和写过的文件，读得回来", async () => {
    const answered = await ask(
      new Scripted([
        ...call("c1", "computer_list_files", { path: "." }),
        ...call("c2", "web_fetch", { url: "https://example.test/a" }),
        ...call("c3", "computer_write_file", {
          path: "quotes/a.md",
          contents: "A 家报价",
        }),
        ...call("c4", "web_fetch", { url: "https://example.test/b" }),
        ...call("c5", "computer_read_file", { path: "quotes/a.md" }),
        ...call(
          "c6",
          "computer_run_command",
          { command: "python table.py" },
          JSON.stringify({ ok: false, error: "exit 1" }),
        ),
      ]),
    );
    const result = readSubagentResult(answered);
    if (!result || !("error" in result))
      throw new Error(`not an error result: ${answered}`);
    expect(result.error).toContain(SEGMENT_LIMIT_MESSAGE);
    expect(result.steps).toBe(6);
    expect(result.progress?.steps).toHaveLength(5);
    expect(result.progress?.steps.map((step) => step.tool)).toEqual([
      "web_fetch",
      "computer_write_file",
      "web_fetch",
      "computer_read_file",
      "computer_run_command",
    ]);
    expect(result.progress?.steps.at(-1)?.ok).toBe(false);
    expect(result.progress?.files).toEqual(["quotes/a.md"]);
    expect(JSON.stringify(result.progress).length).toBeLessThanOrEqual(
      FAILURE_HANDOFF_CHARS,
    );
  });

  test("参数里的密钥不交回；太长时先去掉文件，再截短步骤", async () => {
    const key = `sk-${"Z1y2X3w4".repeat(4)}`;
    const answered = await ask(
      new Scripted([
        ...Array.from({ length: 12 }, (_, index) =>
          call(`w${index}`, "computer_write_file", {
            path: `out/${"很长的目录名".repeat(15)}-${index}.md`,
            contents: `token ${key}`,
          }),
        ).flat(),
        ...call("k", "computer_run_command", {
          command: `curl -H "x-api-key: ${key}" https://api.example.test`,
        }),
      ]),
    );
    expect(answered).not.toContain(key);
    const result = readSubagentResult(answered);
    if (!result || !("error" in result))
      throw new Error(`not an error result: ${answered}`);
    const progress = result.progress;
    expect(progress).toBeDefined();
    expect(JSON.stringify(progress).length).toBeLessThanOrEqual(
      FAILURE_HANDOFF_CHARS,
    );
    // 放不下时文件先让位，最后那几步还在。
    expect(progress?.files).toEqual([]);
    expect(progress?.steps.at(-1)?.tool).toBe("computer_run_command");
  });

  test("父运行中止时照旧抛出，不交回结果", async () => {
    const parent = new AbortController();
    const agent = new Scripted(
      call("c1", "computer_write_file", { path: "a.md", contents: "a" }),
      { hold: true },
    );
    const ran = ask(agent, parent.signal).then(
      (answered) => {
        throw new Error(`answered instead of throwing: ${answered}`);
      },
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );
    setTimeout(() => parent.abort(), 50);
    expect(await ran).toContain("cancelled");
  });
});
