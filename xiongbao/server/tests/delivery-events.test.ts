import { expect, test } from "bun:test";
import { deliveryMarkOf } from "../src/channels/group";
import { withinModelRun } from "../src/models/token-metering";
import { DELIVERY_EVENTS } from "../src/tasks/delivery-events";
import {
  deliveryTools,
  DELIVERY_EVENTS as FROM_TOOLS,
} from "../src/tasks/delivery-tools";

/**
 * 交付卡的事件名只写在一个不引任何东西的模块里（`tasks/delivery-events.ts`），员工工具和群聊的状态标记
 * 都从那里读，不会再出现两份。
 */
test("员工工具放的卡和群聊记标记认的是同一组事件名；答复延期的事件不记", () => {
  expect(FROM_TOOLS).toBe(DELIVERY_EVENTS);
  const at = new Date("2026-11-15T03:00:00.000Z");
  const value = {
    taskId: "t1",
    dueAt: "2026-11-15T08:00:00.000Z",
    criteria: "保密",
    reason: "保密",
    deliverable: { kind: "deliverable", notes: ["保密"] },
  };
  const { extensionDecided, ...cards } = DELIVERY_EVENTS;
  expect(deliveryMarkOf(extensionDecided, value, "a1", at)).toBeNull();
  expect(
    Object.values(cards).map((name) => deliveryMarkOf(name, value, "a1", at)),
  ).toEqual([
    {
      kind: "accepted",
      taskId: "t1",
      at: at.toISOString(),
      agentId: "a1",
      dueAt: value.dueAt,
    },
    {
      kind: "extension_requested",
      taskId: "t1",
      at: at.toISOString(),
      agentId: "a1",
      dueAt: value.dueAt,
    },
    { kind: "delivered", taskId: "t1", at: at.toISOString(), agentId: "a1" },
    { kind: "bounced", taskId: "t1", at: at.toISOString(), agentId: "a1" },
  ]);
  expect(deliveryMarkOf(cards.delivered, {}, "a1", at)).toBeNull();
});

/**
 * 标记带上流水那一行的 id（Codex 审查 P2）：派活人按它对回流水，不按预计时间、不按时刻猜。不是 uuid 的
 * 不收（一个号码，不夹带内容）。
 */
test("群聊标记带上流水行的 id，只收 uuid", () => {
  const at = new Date("2026-11-15T03:00:00.000Z");
  const eventId = "2022fc62-01f0-4b1d-a661-8af8776bc2a4";
  expect(
    deliveryMarkOf(
      DELIVERY_EVENTS.accepted,
      { taskId: "t1", eventId, dueAt: "2026-11-15T08:00:00.000Z" },
      "a1",
      at,
    ),
  ).toEqual({
    kind: "accepted",
    taskId: "t1",
    at: at.toISOString(),
    agentId: "a1",
    dueAt: "2026-11-15T08:00:00.000Z",
    eventId,
  });
  expect(
    deliveryMarkOf(
      DELIVERY_EVENTS.delivered,
      { taskId: "t1", eventId: "交付物：保密的结论" },
      "a1",
      at,
    ),
  ).toEqual({
    kind: "delivered",
    taskId: "t1",
    at: at.toISOString(),
    agentId: "a1",
  });
});

/**
 * 交付事件带上交付的员工 id：下载按钮要它指明文件在哪个员工的工作区。群聊的状态标记按同一个 id 记，
 * 不靠对话里的名字猜。
 */
test("delivery.delivered 事件带上交付的员工 id，群聊标记也带", async () => {
  const said: { name?: string; value?: unknown }[] = [];
  const [, deliver] = deliveryTools({
    delivery: {
      cardOfRun: async () => ({
        id: "t1",
        tracked: true,
        acceptedAt: new Date(),
        status: "in_progress",
        threadRef: "thread-1",
        criteria: "写好",
      }),
      delivered: async () => ({}),
    } as never,
    gate: {
      checkEvidence: async () => ({
        ok: true,
        ref: { kind: "deliverable", workspaceFiles: ["reports/a.xlsx"] },
      }),
    } as never,
    board: {} as never,
    ownerUserId: "owner",
    agentId: "bot-1",
    emit: (_runId, event) => {
      said.push(event as { name?: string; value?: unknown });
    },
  });
  await withinModelRun({ runId: "r1", threadId: "thread-1" }, () =>
    (deliver as NonNullable<typeof deliver>).execute({
      items: [{ kind: "workspace_file", ref: "reports/a.xlsx" }],
      checks: ["打开看过"],
    }),
  );
  const delivered = said.find(
    (event) => event.name === "delivery.delivered",
  ) as { value: unknown };
  expect(delivered.value).toMatchObject({ taskId: "t1", agentId: "bot-1" });
  expect(
    deliveryMarkOf(
      "delivery.delivered",
      delivered.value,
      "bot-1",
      new Date("2026-11-15T03:00:00.000Z"),
    ),
  ).toMatchObject({ kind: "delivered", taskId: "t1", agentId: "bot-1" });
});
