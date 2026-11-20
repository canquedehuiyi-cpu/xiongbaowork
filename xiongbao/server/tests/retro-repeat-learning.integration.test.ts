import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import type { LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { learnedSkills, taskEvents, tasks } from "../src/db/schema";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import {
  createRetroObserver,
  cardRetroTurn,
  createRetrospector,
  deliveredCardOf,
  deliveredCardOfRound,
  markInjectedSkillsUsed,
} from "../src/learning/retrospect";
import { relatedSelfSkills } from "../src/plugins/picked-skill";
import { createPluginStore } from "../src/plugins/store";
import { grantedSkills } from "../src/plugins/tools";
import type { SelfSkillDeps } from "../src/skills/save-tool";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 评测「重复任务」第二次没有更快：员工在看板上把一件 13 步的活交付了，既没到 15 步的门槛，也没人验收，
 * 复盘从没触发。这里在真库上走一遍：交付成功的那一轮 -> 复盘 -> 技能授予这位员工。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `repeat-owner-${suite}`;
const bot = `repeat-bot-${suite}`;
const asOwner = <T>(fn: () => Promise<T>) => runAsTenant(owner, fn);

const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async () => ({ text: "[]", isError: false }),
});
const selfDeps = (agentId: string): SelfSkillDeps => ({
  database,
  plugins,
  ownerUserId: owner,
  agentId,
  now: () => new Date("2026-11-20T10:00:00Z"),
});

beforeAll(async () => {
  await runAsTenant("platform", () =>
    database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test` }),
  );
  await asOwner(async () => {
    await database
      .insert(agents)
      .values({ id: bot, name: bot, type: "built_in", configuration: {} });
    await database.insert(agentProfiles).values({
      agentId: bot,
      ownerUserId: owner,
      title: bot,
      roleDescription: "Assist",
      avatarSeed: bot,
      visibility: "private",
    });
  });
});

const tool = (id: string, name: string, args: unknown, answer: string) =>
  [
    { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: id,
      delta: JSON.stringify(args),
    },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
    {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: id,
      messageId: `m-${id}`,
      content: answer,
    },
  ] as unknown as BaseEvent[];

/** 一轮：先接活，做 `work` 步，再交付。 */
const roundEvents = (work: number): BaseEvent[] => [
  ...tool("a", "accept_task", {}, '{"accepted":true}'),
  ...Array.from({ length: work }, (_, index) =>
    tool(
      `w${index}`,
      "computer_run_command",
      { command: `step ${index}` },
      "{}",
    ),
  ).flat(),
  ...tool("d", "deliver_task", { items: [] }, '{"delivered":true}'),
];

const draft = {
  name: "动作清单做成汇总表",
  when: "把动作清单 CSV 整理成带图表的 xlsx 汇总表交给领导的时候",
  steps: [
    "用 python3 读 <dir>/actions.csv",
    "按负责人汇总",
    "写 <dir>/summary.xlsx",
  ],
  pitfalls: ["csv 第一行是说明，要跳过"],
  verify: "汇总行数与原表一致",
  scope: "self",
};

async function cardDeliveredIn(runId: string) {
  const taskId = randomUUID();
  await asOwner(async () => {
    await database.insert(tasks).values({
      id: taskId,
      tenantId: owner,
      title: "整理动作清单",
      source: "chat",
      executorAgentId: bot,
      runRef: runId,
      activeRunRef: runId,
      threadRef: `thread-${runId}`,
    } as never);
    await database.insert(taskEvents).values({
      tenantId: owner,
      taskId,
      kind: "delivered",
      actor: `agent:${bot}`,
      detail: { runId },
    });
  });
  return taskId;
}

describe("a delivered card is reviewed, without waiting for the person to accept it", () => {
  const observer = (modelCalls: string[]) =>
    createRetroObserver({
      retrospect: createRetrospector({
        database,
        selfSkill: (ownerUserId, agentId) => ({
          ...selfDeps(agentId),
          ownerUserId,
        }),
        modelFor: async (_agent, purpose) => {
          modelCalls.push(purpose);
          return {} as LanguageModel;
        },
        call: async () => ({ text: JSON.stringify({ skill: draft }) }),
        existingSkills: async () => [],
        log: () => {},
      }),
      deliveredCard: (runId) => deliveredCardOf(database, runId),
      cardTurn: (taskId, current) =>
        cardRetroTurn(database, taskId, "card_delivered", current),
      log: () => {},
    });

  test("the card of a run is found from its delivered line, and only in the owner's frame", async () => {
    const runId = `run-find-${suite}`;
    const taskId = await cardDeliveredIn(runId);
    await asOwner(async () => {
      expect(await deliveredCardOf(database, runId)).toBe(taskId);
      expect(await deliveredCardOf(database, `${runId}-other`)).toBeNull();
    });
    await runAsTenant(`someone-else-${suite}`, async () => {
      expect(await deliveredCardOf(database, runId)).toBeNull();
    });
  });

  test("a later round of a delivered card finds the card, from the run it hangs on or the line its end wrote", async () => {
    const first = `run-a-${suite}`;
    const hung = `run-b-${suite}`;
    const ended = `run-c-${suite}`;
    const taskId = await cardDeliveredIn(first);
    const other = await cardDeliveredIn(`run-x-${suite}`);
    await asOwner(async () => {
      // Round B is running on the card; round C has ended (the end clears the column and writes a line).
      await database
        .update(tasks)
        .set({ activeRunRef: hung })
        .where(eq(tasks.id, taskId));
      await database.insert(taskEvents).values({
        tenantId: owner,
        taskId,
        kind: "run_ended",
        actor: "system",
        detail: { runId: ended },
      });
      expect(await deliveredCardOfRound(database, first)).toBe(taskId);
      expect(await deliveredCardOfRound(database, hung)).toBe(taskId);
      expect(await deliveredCardOfRound(database, ended)).toBe(taskId);
      expect(await deliveredCardOfRound(database, `run-x-${suite}`)).toBe(
        other,
      );
      expect(
        await deliveredCardOfRound(database, `nobody-${suite}`),
      ).toBeNull();
    });
    await runAsTenant(`someone-else-${suite}`, async () => {
      expect(await deliveredCardOfRound(database, hung)).toBeNull();
    });
  });

  test("a card that has not been handed in has no delivered round", async () => {
    const run = `run-open-${suite}`;
    const taskId = randomUUID();
    await asOwner(async () => {
      await database.insert(tasks).values({
        id: taskId,
        tenantId: owner,
        title: "还没交的活",
        source: "chat",
        executorAgentId: bot,
        runRef: run,
        activeRunRef: run,
        threadRef: `thread-${run}`,
      } as never);
      expect(await deliveredCardOfRound(database, run)).toBeNull();
    });
  });

  test("13 steps, delivered, not accepted: the round that delivered it saves a skill the employee holds", async () => {
    const runId = `run-13-${suite}`;
    await cardDeliveredIn(runId);
    const modelCalls: string[] = [];
    const events = roundEvents(11);
    const outcome = await asOwner(() =>
      observer(modelCalls)({
        tenant: owner,
        agentId: bot,
        threadId: `thread-${runId}`,
        runId,
        messages: [{ role: "user", content: "整理动作清单" }],
        events,
        failed: false,
        kind: "task",
      }),
    );
    expect(outcome).toMatchObject({ outcome: "saved", status: "active" });
    expect(modelCalls).toEqual(["light"]);
    await asOwner(async () => {
      const rows = await database
        .select()
        .from(learnedSkills)
        .where(eq(learnedSkills.agentId, bot));
      expect(rows.map((row) => row.origin)).toEqual(["retrospect"]);
      expect(
        (await plugins.listForAgent(bot)).skills.map((skill) => skill.title),
      ).toEqual([draft.name]);
    });
  });
});

describe("the next run of the same kind of task is given what the first one learned", () => {
  const SECOND_RUN =
    "把 eval/repeat-second/actions.csv 里的动作清单整理成带图表的 xlsx 汇总表，按负责人汇总，做好后交付给领导。";

  test("the skill the review granted is picked for a similar request, and counted as used", async () => {
    await asOwner(async () => {
      const held = await grantedSkills({ store: plugins, botId: bot });
      const slug = (
        await database
          .select()
          .from(learnedSkills)
          .where(eq(learnedSkills.agentId, bot))
      )[0]?.skillSlug;
      expect(slug).toBeDefined();
      const related = relatedSelfSkills(SECOND_RUN, held);
      expect(related.map((skill) => skill.slug)).toEqual([slug as string]);
      expect(related[0]?.instructions).toContain("summary.xlsx");
      // A request of another kind is not given it.
      expect(relatedSelfSkills("订一张下周去上海的机票", held)).toEqual([]);

      await markInjectedSkillsUsed(
        database,
        { agentId: bot, messages: [{ role: "user", content: SECOND_RUN }] },
        async (agentId) => (await plugins.listForAgent(agentId)).skills,
        new Date("2026-11-20T11:00:00Z"),
      );
      const [row] = await database
        .select()
        .from(learnedSkills)
        .where(eq(learnedSkills.skillSlug, slug as string));
      expect(row?.useCount).toBe(1);
    });
  });
});

// 最后注册的 afterAll：关掉本文件打开的连接池。
afterAll(async () => {
  await database.$client.close();
});
