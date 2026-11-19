import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import {
  createAcpSessionHints,
  DeviceAcpAgent,
  type DeviceAcpAgentConfig,
  type DeviceAcpEmployee,
  deviceAcpAgentFor,
  useDeviceAcp,
} from "../src/agents/acp/agent";
import { createAcpRelay } from "../src/agents/acp/relay";
import {
  type AcpModelAccess,
  createAcpModelAccess,
} from "../src/agents/model-proxy/access";
import { createAgentModelTokens } from "../src/agents/model-proxy/token";
import { createMemoryAcpTurnStore } from "./support/acp-turns-memory";

/*
 * `acp.open` 带不带 `model` 块：员工在熊宝里有自己的模型就带（短期令牌，不是 key），没有就和以前
 * 一模一样。真 relay、内存轮次存储、假设备通道。
 */

type Frame = Record<string, unknown>;

function setup() {
  const turns = createMemoryAcpTurnStore();
  const down: Frame[] = [];
  const relay = createAcpRelay({
    channel: {
      notify: (_target, frame) => {
        down.push(frame);
        return true;
      },
      isReachable: () => true,
      connectionOf: () => "conn-1",
    },
    turns,
    startQueuedTurn: async () => {
      throw new Error("no starter");
    },
    log: () => undefined,
  });
  const base: DeviceAcpAgentConfig = {
    agentId: "agent-1",
    ownerUserId: "user-1",
    tenantId: "tenant-a",
    deviceId: "laptop",
    harness: "codex",
    workdirRef: "fld_work",
    name: "小码",
    relay,
    turns,
    reachable: () => true,
    context: async () => [],
    sessions: createAcpSessionHints(),
    every: () => () => undefined,
    newTurnId: () => "turn-1",
    log: () => undefined,
  };
  const run = async (agent: DeviceAcpAgent, keepRunning = false) => {
    const input: RunAgentInput = {
      threadId: "thread-1",
      runId: "run-1",
      messages: [{ id: "m1", role: "user", content: "把登录页修好" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    const subscription = agent.run(input).subscribe({ error: () => undefined });
    for (let i = 0; i < 400 && !down.some((f) => f.type === "acp.open"); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 2));
    if (!keepRunning) subscription.unsubscribe();
    return down.find((frame) => frame.type === "acp.open");
  };
  return { base, down, relay, run };
}

const model = {
  baseUrl: "https://xiongbao.test/api/agent-model",
  token: "xbm_short-lived-pass",
  model: "deepseek-chat",
  wire: "responses" as const,
  expiresAt: 1_900_000_000_000,
};

describe("acp.open and the employee's model", () => {
  test("carries the model block the employee's config hands out, for this thread", async () => {
    const t = setup();
    const asked: string[] = [];
    const open = await t.run(
      new DeviceAcpAgent({
        ...t.base,
        model: async (threadId) => {
          asked.push(threadId);
          return model;
        },
      }),
    );
    expect(asked).toEqual(["thread-1"]);
    expect(open).toEqual({
      type: "acp.open",
      agentId: "agent-1",
      threadId: "thread-1",
      harness: "codex",
      workdirRef: "fld_work",
      model,
    });
  });

  test("with no model of its own it is exactly the open it always was", async () => {
    for (const config of [
      {},
      { model: async () => null },
      {
        model: async (): Promise<never> => {
          throw new Error("database down");
        },
      },
    ] as Partial<DeviceAcpAgentConfig>[]) {
      const t = setup();
      const open = await t.run(new DeviceAcpAgent({ ...t.base, ...config }));
      expect(open).toEqual({
        type: "acp.open",
        agentId: "agent-1",
        threadId: "thread-1",
        harness: "codex",
        workdirRef: "fld_work",
      });
      expect(open).not.toHaveProperty("model");
    }
  });

  test("an employee built for a tenant asks the runtime's access with its own tenant, id and harness", async () => {
    const t = setup();
    const issued: unknown[] = [];
    const access: AcpModelAccess = {
      issue: async (input) => {
        issued.push(input);
        return model;
      },
    };
    useDeviceAcp({
      relay: t.relay,
      turns: t.base.turns,
      channel: { isReachable: () => true },
      sessions: createAcpSessionHints(),
      context: async () => [],
      model: access,
    });
    try {
      const employee: DeviceAcpEmployee = {
        id: "agent-9",
        name: "小克",
        ownerUserId: "tenant-a",
        deviceId: "laptop",
        harness: "claude-code",
        workdirRef: "fld_work",
        persona: "后端工程师",
      };
      const agent = deviceAcpAgentFor(employee, { tenantId: "tenant-a" });
      const open = await t.run(agent as DeviceAcpAgent);
      expect(issued).toEqual([
        {
          tenantId: "tenant-a",
          agentId: "agent-9",
          threadId: "thread-1",
          harness: "claude-code",
        },
      ]);
      expect(open?.model).toEqual(model);
    } finally {
      useDeviceAcp(null);
    }
  });

  test("the real access hands the pass over only in the open, never in the prompt", async () => {
    const t = setup();
    const tokens = createAgentModelTokens({ encryptionKey: "k".repeat(32) });
    const access = createAcpModelAccess({
      tokens,
      baseUrl: "https://xiongbao.test/api/agent-model",
      boundModel: async () => "deepseek-chat",
    });
    const agent = new DeviceAcpAgent({
      ...t.base,
      model: (threadId) =>
        access.issue({
          tenantId: "tenant-a",
          agentId: "agent-1",
          threadId,
          harness: "codex",
        }),
    });
    const open = (await t.run(agent, true)) as { model?: { token: string } };
    // The device answers the open, and the turn's prompt goes down.
    const from = {
      tenantId: "tenant-a",
      deviceId: "laptop",
      connectionId: "conn-1",
    };
    t.relay.fromRunner(from, {
      type: "acp.session",
      agentId: "agent-1",
      threadId: "thread-1",
      sessionId: "sess-1",
      loaded: true,
    });
    await t.relay.drain(from);
    for (
      let i = 0;
      i < 400 && !t.down.some((f) => f.type === "acp.prompt");
      i += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(t.down.some((frame) => frame.type === "acp.prompt")).toBe(true);
    expect(tokens.verify(open.model?.token)).toMatchObject({
      tenantId: "tenant-a",
      agentId: "agent-1",
      threadId: "thread-1",
    });
    const others = t.down.filter((frame) => frame.type !== "acp.open");
    expect(JSON.stringify(others)).not.toContain(open.model?.token ?? "xx");
  });
});
