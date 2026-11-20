import { afterEach, describe, expect, test } from "bun:test";
import { withModelRun } from "../src/models/token-metering";
import { acceptedDelivery, deliverEndsTurnOn } from "../src/tasks/delivery-end";
import { DELIVER_TASK, deliveryTools } from "../src/tasks/delivery-tools";

/*
 * 交付即收尾（服务器这一半）：哪个工具结果算「交付被接受」，以及部署开关 `XIONGBAO_DELIVER_ENDS_TURN`。
 * 判断只认 `deliver_task` 返回的 `delivered: true`；被挡回、被拒、别的工具、读不懂的文字都不算，模型照常再走一步。
 * 收尾那一步省不省，toolkit 的 `deliver-ends-turn.test.ts` 管；这里管认得对不对、开关对不对。
 */

describe("哪个结果算交付被接受", () => {
  test("deliver_task 返回 delivered: true", () => {
    expect(
      acceptedDelivery(
        DELIVER_TASK,
        JSON.stringify({ delivered: true, taskId: "t1", note: "已交成果" }),
      ),
    ).toBe(true);
  });

  test("被挡回、被拒、读不懂的文字，都不算", () => {
    for (const text of [
      JSON.stringify({ bounced: true, reason: "缺必需项" }),
      "[refused] 这件活还没接下",
      JSON.stringify({ delivered: false }),
      JSON.stringify({ accepted: true }),
      "delivered: true",
      "",
      "{坏的",
      "null",
    ])
      expect(acceptedDelivery(DELIVER_TASK, text)).toBe(false);
  });

  test("别的工具返回 delivered: true 也不算", () => {
    expect(
      acceptedDelivery("accept_task", JSON.stringify({ delivered: true })),
    ).toBe(false);
  });

  test("真的 deliver_task 交付成功的结果，认得出", async () => {
    const card = {
      id: "card-1",
      tracked: true,
      acceptedAt: new Date(),
      status: "in_progress",
      threadRef: "thread-1",
      criteria: "写好",
    };
    const [, deliver] = deliveryTools({
      delivery: {
        cardOfRun: async () => card,
        delivered: async () => ({}),
        bounced: async () => ({}),
      } as never,
      gate: {
        checkEvidence: async () => ({ ok: true, ref: { kind: "deliverable" } }),
      } as never,
      board: {} as never,
      ownerUserId: "owner",
      agentId: "bot",
      emit: () => undefined,
    });
    expect(deliver?.name).toBe(DELIVER_TASK);
    const handed = await withModelRun({ runId: "r1", threadId: "t1" }, () =>
      (deliver as NonNullable<typeof deliver>).execute({
        items: [{ kind: "note", ref: "结论" }],
        checks: ["查过了"],
      }),
    );
    expect(acceptedDelivery(DELIVER_TASK, handed)).toBe(true);
  });

  test("真的 deliver_task 被挡回的结果，不算", async () => {
    const [, deliver] = deliveryTools({
      delivery: {
        cardOfRun: async () => ({
          id: "card-1",
          tracked: true,
          acceptedAt: new Date(),
          status: "in_progress",
          threadRef: "thread-1",
          criteria: "必需：A",
        }),
        delivered: async () => ({}),
        bounced: async () => ({}),
      } as never,
      gate: {
        checkEvidence: async () => ({
          ok: false,
          reason: "缺必需项",
          missing: ["A"],
        }),
      } as never,
      board: {} as never,
      ownerUserId: "owner",
      agentId: "bot",
      emit: () => undefined,
    });
    const handed = await withModelRun({ runId: "r1", threadId: "t1" }, () =>
      (deliver as NonNullable<typeof deliver>).execute({
        items: [],
        checks: [],
      }),
    );
    expect(handed).toContain("bounced");
    expect(acceptedDelivery(DELIVER_TASK, handed)).toBe(false);
  });
});

describe("部署开关 XIONGBAO_DELIVER_ENDS_TURN", () => {
  const saved = process.env.XIONGBAO_DELIVER_ENDS_TURN;
  afterEach(() => {
    if (saved === undefined) delete process.env.XIONGBAO_DELIVER_ENDS_TURN;
    else process.env.XIONGBAO_DELIVER_ENDS_TURN = saved;
  });

  test("默认开，只有明确写 off 才关", () => {
    expect(deliverEndsTurnOn({})).toBe(true);
    expect(deliverEndsTurnOn({ XIONGBAO_DELIVER_ENDS_TURN: "on" })).toBe(true);
    expect(deliverEndsTurnOn({ XIONGBAO_DELIVER_ENDS_TURN: "" })).toBe(true);
    expect(deliverEndsTurnOn({ XIONGBAO_DELIVER_ENDS_TURN: "off" })).toBe(
      false,
    );
    expect(deliverEndsTurnOn({ XIONGBAO_DELIVER_ENDS_TURN: " OFF " })).toBe(
      false,
    );
  });

  test("不传环境时读进程环境", () => {
    delete process.env.XIONGBAO_DELIVER_ENDS_TURN;
    expect(deliverEndsTurnOn()).toBe(true);
    process.env.XIONGBAO_DELIVER_ENDS_TURN = "off";
    expect(deliverEndsTurnOn()).toBe(false);
  });
});
