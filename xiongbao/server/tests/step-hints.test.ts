import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { slimModelTools } from "../src/agents/prompt-slim";
import {
  SLIM_HOW_TO_WORK,
  slimHowToWork,
  slimWorkingGuidance,
} from "../src/agents/slim-guidance";
import {
  ACCEPT_WITH_READS_ENV,
  acceptWithReadsOn,
  DELIVER_NUDGE_ENV,
  deliverNudgeOn,
  deliveryDueFor,
  MERGE_COMMANDS_ENV,
  mergeCommandsOn,
  PLAN_WITH_ACTION_ENV,
  planWithActionOn,
} from "../src/agents/step-hints";
import { updatePlanTools } from "../src/agents/update-plan";
import type { GrantedTool } from "../src/plugins/tools";
import { cardAsk } from "../src/tasks/claim";
import {
  ACCEPT_TASK,
  DELIVER_TASK,
  deliveryProtocolGuidance,
  deliveryTools,
  RECEIPT_ASKED,
  REQUEST_EXTENSION,
  receiptAsked,
  withReceiptAsked,
} from "../src/tasks/delivery-tools";

/*
 * 少调几次模型（token 第四轮）：接活回执、更新计划、一串命令，各自单独占一步，每一步都要把整段历史再发一遍。
 * 这里钉三处写给模型的话和两处并行标记，以及各自的部署开关：
 *
 *  - XIONGBAO_ACCEPT_WITH_READS：接活回执和第一批读取放在同一步发（交付规约、接活回执的提醒、看板派活的话、
 *    accept_task 的描述），accept_task 在无头运行里可以和同一步的别的调用一起开始；
 *  - XIONGBAO_PLAN_WITH_ACTION：更新计划和下一步动作放在同一步发（update_plan 的描述），update_plan 同样可以并行；
 *  - XIONGBAO_MERGE_COMMANDS：几条前后依赖、不需要看中间输出的命令用 && 合成一条（how_to_work）。
 *
 * 关着就是原来的话、原来没有的并行标记，逐字不变。
 */

const KEYS = [
  ACCEPT_WITH_READS_ENV,
  PLAN_WITH_ACTION_ENV,
  MERGE_COMMANDS_ENV,
] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const delivery = () =>
  deliveryTools({
    delivery: {} as never,
    gate: {} as never,
    board: {} as never,
    ownerUserId: "owner",
    agentId: "bot",
  });
const byName = (tools: GrantedTool[], name: string) =>
  tools.find((tool) => tool.name === name) as GrantedTool;

describe("三个开关", () => {
  test("默认都开，只有明确写 off 才关", () => {
    expect(acceptWithReadsOn({})).toBe(true);
    expect(planWithActionOn({})).toBe(true);
    expect(mergeCommandsOn({})).toBe(true);
    expect(acceptWithReadsOn({ [ACCEPT_WITH_READS_ENV]: "off" })).toBe(false);
    expect(planWithActionOn({ [PLAN_WITH_ACTION_ENV]: " OFF " })).toBe(false);
    expect(mergeCommandsOn({ [MERGE_COMMANDS_ENV]: "off" })).toBe(false);
    expect(mergeCommandsOn({ [MERGE_COMMANDS_ENV]: "on" })).toBe(true);
  });

  test("三个开关互相独立", () => {
    expect(acceptWithReadsOn({ [PLAN_WITH_ACTION_ENV]: "off" })).toBe(true);
    expect(planWithActionOn({ [MERGE_COMMANDS_ENV]: "off" })).toBe(true);
    expect(mergeCommandsOn({ [ACCEPT_WITH_READS_ENV]: "off" })).toBe(true);
  });
});

describe("接活回执和第一批读取放在同一步发", () => {
  test("交付规约的补充句里说了，规约本身和原来的补充句不变", () => {
    const text = deliveryProtocolGuidance([ACCEPT_TASK]) ?? "";
    expect(text).toContain("同一步");
    expect(text).toContain("accept_task");
    expect(text).toContain("workspace_file");
    expect(text).toContain("问一句答一句的普通对话不要用这三个工具");
  });

  test("关着：和原来逐字一样，没有「同一步」", () => {
    process.env[ACCEPT_WITH_READS_ENV] = "off";
    const text = deliveryProtocolGuidance([ACCEPT_TASK]) ?? "";
    expect(text).not.toContain("同一步");
    expect(
      text.endsWith(
        "有文件产出的活，先用 accept_task 接下；做完用 deliver_task 交付，把你写在工作区里的文件用 workspace_file 逐个列上（ref 写工作区内的相对路径，如 reports/对比.xlsx）。",
      ),
    ).toBe(true);
  });

  test("没有 accept_task 的员工不听这句", () => {
    expect(deliveryProtocolGuidance([DELIVER_TASK])).toBeUndefined();
  });

  test("接活回执的提醒：默认让回执和第一批读取一起发；关着是原话", () => {
    expect(receiptAsked()).toContain("同一步");
    expect(receiptAsked()).toContain("accept_task");
    expect(RECEIPT_ASKED).toBe(receiptAsked());
    process.env[ACCEPT_WITH_READS_ENV] = "off";
    expect(receiptAsked()).toBe(
      "这段对话里有一件活被当作一件活来跟，还在等你的接活回执：先调用 accept_task（写上预计几点交和验收标准），再接着做。",
    );
  });

  test("withReceiptAsked 带的是当前的话", () => {
    const withIt = withReceiptAsked({ context: [] });
    expect(
      withIt.context.map((item) => (item as { value: string }).value),
    ).toEqual([receiptAsked()]);
    process.env[ACCEPT_WITH_READS_ENV] = "off";
    const off = withReceiptAsked({ context: [] });
    expect(
      off.context.map((item) => (item as { value: string }).value),
    ).toEqual([receiptAsked()]);
  });

  test("看板派活的话：先回执，但和第一批读取一起发；关着是原话", () => {
    const ask = cardAsk({ title: "改按钮", detail: "红色" });
    expect(ask).toContain("红色");
    expect(ask).toContain("accept_task");
    expect(ask).toContain("同一步");
    expect(ask).toContain("deliver_task");
    process.env[ACCEPT_WITH_READS_ENV] = "off";
    const off = cardAsk({ title: "改按钮", detail: "红色" });
    expect(off).not.toContain("同一步");
    expect(off).toContain(
      "照常先用 accept_task 回执（写清楚你怎么做、什么算做完），做完用 deliver_task 交成果，等本人验收。",
    );
  });

  test("accept_task 的描述提到同一步；无头运行里可以和同一步的别的调用一起开始", () => {
    const accept = byName(delivery(), ACCEPT_TASK);
    expect(accept.description).toContain("同一步");
    expect(accept).toHaveProperty("concurrent", true);
  });

  test("关着：描述没有这句，也不标并行", () => {
    process.env[ACCEPT_WITH_READS_ENV] = "off";
    const accept = byName(delivery(), ACCEPT_TASK);
    expect(accept.description).not.toContain("同一步");
    expect(accept).not.toHaveProperty("concurrent");
  });

  test("交付和申请延期从不标并行：它们要在别的调用之后、按顺序做", () => {
    const tools = delivery();
    expect(byName(tools, DELIVER_TASK)).not.toHaveProperty("concurrent");
    expect(byName(tools, REQUEST_EXTENSION)).not.toHaveProperty("concurrent");
  });
});

describe("更新计划和下一步动作放在同一步发", () => {
  test("update_plan 的描述提到同一步，并且标并行", () => {
    const [plan] = updatePlanTools();
    expect(plan?.description).toContain("同一步");
    expect(plan).toHaveProperty("concurrent", true);
  });

  test("关着：描述是原话，不标并行", () => {
    process.env[PLAN_WITH_ACTION_ENV] = "off";
    const [plan] = updatePlanTools();
    expect(plan?.description).not.toContain("同一步");
    expect(plan).not.toHaveProperty("concurrent");
    expect(plan?.description).toBe(
      "列出或更新你这次工作的计划清单，每次都传完整清单。需要多步才能完成的任务，先用它列出计划；开始做哪一项就把它标成 in_progress，做完立刻标 done，全部 done 后再给出总结。一两步就能完成的简单问题不用列计划。",
    );
  });

  test("瘦身后发给模型的短描述也带这句；关着不带", () => {
    const sent = (name: string, description: string) => ({
      type: "function",
      name,
      description,
      inputSchema: z.toJSONSchema(z.object({})),
    });
    const brief = slimModelTools([
      sent("update_plan", "原文"),
      sent("accept_task", "原文"),
      sent("deliver_task", "原文"),
    ]);
    expect(brief[0]?.description).toContain("同一步");
    expect(brief[1]?.description).toContain("同一步");
    expect(brief[2]?.description).not.toContain("同一步");
    process.env[PLAN_WITH_ACTION_ENV] = "off";
    process.env[ACCEPT_WITH_READS_ENV] = "off";
    const off = slimModelTools([
      sent("update_plan", "原文"),
      sent("accept_task", "原文"),
    ]);
    expect(off[0]?.description).not.toContain("同一步");
    expect(off[1]?.description).not.toContain("同一步");
  });
});

describe("几条前后依赖的命令合成一条", () => {
  // 用户 2026-11-21 批准：how_to_work 压短（对标 Codex CLI），「合成一条命令」那一句关着时的写法也跟着换；
  // 同日批准：互不相关的修改可以同一步一起发（和编辑指引一致）。
  const ORIGINAL =
    "Use what you already have before fetching more.\n\nSend independent reads, searches and commands together in one reply (about five), not one per reply; read every result before the next batch. Independent edits may share a reply; a step needing a result waits. Decide and act in the same reply. If a call fails, retry once or go another way, then carry on without it and say so. Deliver what was asked even when part is missing, and say what you could not confirm.";

  test("默认的 how_to_work 多一句：依赖的命令用 && 合成一条，一次读完多个文件", () => {
    expect(SLIM_HOW_TO_WORK).toContain("&&");
    expect(SLIM_HOW_TO_WORK).toContain("computer_run_command");
    expect(SLIM_HOW_TO_WORK).toContain("install, build");
    expect(SLIM_HOW_TO_WORK).toContain("Independent edits may share a reply");
    expect(SLIM_HOW_TO_WORK.length).toBeGreaterThan(ORIGINAL.length);
    // 原来的话一个字不少。
    for (const sentence of ORIGINAL.split(/(?<=\.) /))
      expect(SLIM_HOW_TO_WORK).toContain(sentence.trim());
  });

  test("关着：逐字回到原来的话", () => {
    expect(slimHowToWork({ [MERGE_COMMANDS_ENV]: "off" })).toBe(ORIGINAL);
    process.env[MERGE_COMMANDS_ENV] = "off";
    expect(
      slimWorkingGuidance({ untrusted: "u", asking: "a" }).join(""),
    ).toContain(ORIGINAL);
  });

  test("默认开：slimWorkingGuidance 带的是新写法", () => {
    expect(
      slimWorkingGuidance({ untrusted: "u", asking: "a" }).join(""),
    ).toContain(SLIM_HOW_TO_WORK);
  });
});

describe("看板卡的轮要结束却没交付时提醒", () => {
  test("看板卡的无人值守轮带 deliveryDue，聊天轮、例行和巡检不带", () => {
    expect(deliveryDueFor(true, true, {})).toBe(true);
    // 聊天：有人看着，也不是看板派活。
    expect(deliveryDueFor(false, false, {})).toBe(false);
    // 例行任务、巡检：无人值守，但不是看板卡派的。
    expect(deliveryDueFor(false, true, {})).toBe(false);
    expect(deliveryDueFor(true, false, {})).toBe(false);
  });

  test("默认开，只有明确写 off 才关", () => {
    expect(deliverNudgeOn({})).toBe(true);
    expect(deliverNudgeOn({ [DELIVER_NUDGE_ENV]: "off" })).toBe(false);
    expect(deliveryDueFor(true, true, { [DELIVER_NUDGE_ENV]: "OFF" })).toBe(
      false,
    );
  });
});
