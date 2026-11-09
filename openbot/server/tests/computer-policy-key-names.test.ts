import { describe, expect, test } from "bun:test";
import type { AuditEvent, AuditEventInput, AuditStore } from "../src/audit";
import { botSeat } from "../src/computer/computer-key";
import { createComputerGateway } from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import { dryRunAgainstHistory } from "../src/computer/policy-dry-run";
import type { ComputerProvider } from "../src/computer/provider";
import type { SnapshotResult } from "../src/computer/schema";

/**
 * 部署策略里的键名（阶段 2f，#398 实现报告遗留）：管理员写 `key == "Enter"`、`intent == "activate"`，
 * Bot 按 `"\r"`、`"\n"`、`ControlLeft+Enter` 这类同一个键的别的写法，不能绕过去。判定前按 Playwright
 * 的规则规范化（审批策略里的同一个函数），原始写法照样判定一次，哪次拒绝就拒绝；发给浏览器的键和
 * 审计行里记的键都是原样的。
 */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://example.com/order",
  title: "Order",
  truncated: false,
  elements: [
    { ref: "e1", role: "input", name: "Customer name:", type: "text" },
    { ref: "e9", role: "button", name: "Submit order" },
  ],
};

async function gatewayWith(policy: ActionPolicy) {
  const calls: string[] = [];
  const sentKeys: string[] = [];
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-person",
    locate: async () => "http://agent-computer:4100",
    status: async (seat) => ({ botId: seat.botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/snapshot") return Response.json(SNAPSHOT);
    calls.push(path.slice(1));
    if (path === "/key")
      sentKeys.push(
        (JSON.parse(String(init?.body ?? "{}")) as { key?: string }).key ?? "",
      );
    return Response.json({
      action: path.slice(1),
      url: SNAPSHOT.url,
      elapsedMs: 1,
    });
  }) as unknown as typeof fetch;
  const gateway = createComputerGateway({
    provider,
    fetchImpl,
    auditStore,
    policy: () => policy,
  });
  await gateway.snapshot(botSeat("bot-1"));
  return { gateway, calls, sentKeys, rows };
}

const ACTOR = { id: "dev-local-user" };
const denying = (...deny: string[]): ActionPolicy => ({
  mode: "enforce",
  deny,
  allow: ["true"],
});

/** 按一次键，返回它有没有到达电脑。 */
async function press(policy: ActionPolicy, key: string, ref = "e1") {
  const { gateway, calls, sentKeys, rows } = await gatewayWith(policy);
  const reached = await gateway
    .key(botSeat("bot-1"), ACTOR, { ref, snapshotId: 7, key })
    .then(
      () => true,
      () => false,
    );
  return { reached, calls, sentKeys, rows };
}

describe("部署策略按规范化的键名判定", () => {
  test.each([
    ["\r"],
    ["\n"],
    ["NumpadEnter"],
    ["enter"],
    ["ENTER"],
    ["Return"],
  ])('`key == "Enter"` 拦下 %j', async (key) => {
    const { reached, calls } = await press(denying('key == "Enter"'), key);
    expect({ key, reached, calls }).toEqual({ key, reached: false, calls: [] });
  });

  test.each([
    ['key == "Control+Enter"', "ControlLeft+Enter"],
    ['key == "Control+Enter"', "ControlRight+Enter"],
    ['key == "Control+Enter"', "ControlLeft+\n"],
    ['key == "Control+Enter"', "Control+\r"],
    ['key == "Control+Enter"', "Ctrl+Enter"],
    ['key == "Control+Enter"', "control+enter"],
    ['key == "Meta+Enter"', "MetaLeft+Enter"],
    ['key == "Meta+Enter"', "MetaRight+\n"],
    ['key == "Alt+Enter"', "AltLeft+Enter"],
    ['key == "Alt+Enter"', "AltRight+\r"],
    ['key == "Shift+Enter"', "ShiftLeft+Enter"],
    ['key == "Shift+Enter"', "ShiftRight+\n"],
    ['key == "Control+Shift+Enter"', "Shift+Control+Enter"],
    ['key == "Control+Shift+Enter"', "ShiftLeft+ControlRight+\r"],
    ['key == "Control+Alt+Enter"', "Alt+Control+Enter"],
    ['key == "Control+Meta+Alt+Shift+Enter"', "Shift+Alt+Meta+Control+Enter"],
    ['key == "Control+Enter"', "Control+ControlLeft+Enter"],
  ])("`%s` 拦下 %j", async (rule, key) => {
    const { reached, calls } = await press(denying(rule), key);
    expect({ key, reached, calls }).toEqual({ key, reached: false, calls: [] });
  });

  test.each([["\r"], ["\n"], ["NumpadEnter"], ["Return"], ["Spacebar"]])(
    '`intent == "activate"` 拦下 %j',
    async (key) => {
      const { reached } = await press(
        denying('intent == "activate"'),
        key,
        "e9",
      );
      expect({ key, reached }).toEqual({ key, reached: false });
    },
  );

  test("只允许输入文字的部署，`\\r` 不再按输入文字放行", async () => {
    const { reached } = await press(
      { mode: "enforce", deny: [], allow: ['intent == "type"'] },
      "\r",
    );
    expect(reached).toBeFalse();
  });

  test("随 shipped 预设：在提交按钮上按 \\r 拦下", async () => {
    const shipped =
      '(intent == "activate" && contains(element.name, "submit")) || ((tool.name == "computer_key" || tool.name == "computer_type") && key == "Enter")';
    for (const key of ["\r", "\n", "NumpadEnter"]) {
      const onField = await press(denying(shipped), key, "e1");
      const onButton = await press(denying(shipped), key, "e9");
      expect({ key, field: onField.reached, button: onButton.reached }).toEqual(
        { key, field: false, button: false },
      );
    }
  });
});

describe("规范化只用于判定", () => {
  test("发给浏览器的键和审计行里的键都是原样", async () => {
    for (const key of ["ControlLeft+Enter", "\r", "Shift+Control+a"]) {
      const { reached, sentKeys, rows } = await press(denying(), key);
      expect(reached).toBeTrue();
      expect(sentKeys).toEqual([key]);
      const keyRow = rows.find(
        (row) =>
          (row.payload as { action?: string } | undefined)?.action ===
          "computer_key",
      );
      expect((keyRow?.payload as { key?: string } | undefined)?.key).toBe(key);
    }
  });

  test("写着原始写法的规则照样生效：只会更严", async () => {
    for (const [rule, key] of [
      ['key == "ControlLeft+Enter"', "ControlLeft+Enter"],
      ['key == " "', " "],
      ['contains(key, "Left")', "ShiftLeft+a"],
      ['key == "Shift+Control+Enter"', "Shift+Control+Enter"],
    ] as const) {
      const { reached } = await press(denying(rule), key);
      expect({ rule, key, reached }).toEqual({ rule, key, reached: false });
    }
  });

  test("不相干的键不受影响", async () => {
    for (const [rule, key] of [
      ['key == "Enter"', "Shift+Enter"],
      ['key == "Enter"', "Tab"],
      ['key == "Enter"', "a"],
      ['key == "Control+Enter"', "Control+a"],
      ['intent == "activate"', "Escape"],
    ] as const) {
      const { reached } = await press(denying(rule), key);
      expect({ rule, key, reached }).toEqual({ rule, key, reached: true });
    }
  });
});

describe("策略预演和网关判定一致", () => {
  const row = (key: string): AuditEvent => ({
    id: `evt-${JSON.stringify(key)}`,
    actorUserId: null,
    eventType: "computer.action_allowed",
    targetType: "computer",
    targetId: "bot-1",
    createdAt: "2026-11-01T00:00:00.000Z",
    initiatorKind: "person",
    initiatorId: null,
    payload: {
      action: "computer_key",
      bot: "bot-1",
      actor: "dev-local-user",
      page: "https://example.com/order",
      ref: "e1",
      element: { role: "input", name: "Customer name:", type: "text" },
      key,
    },
  });

  test("预演把 \\r、ControlLeft+Enter 也算作会被拦下", () => {
    const report = dryRunAgainstHistory(
      denying('key == "Enter"', 'key == "Control+Enter"'),
      [row("\r"), row("\n"), row("ControlLeft+Enter"), row("Tab")],
    );
    expect(report).toMatchObject({
      scanned: 4,
      wouldRefuse: 3,
      unchanged: 1,
    });
  });
});
