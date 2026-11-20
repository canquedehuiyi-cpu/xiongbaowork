import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import type { LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import { taskPrompt } from "../../scripts/e2e/employee-eval/lib";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { learnedSkills, taskEvents, tasks } from "../src/db/schema";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import {
  cardRetroTurn,
  createRetroObserver,
  createRetrospector,
  deliveredCardOf,
  markInjectedSkillsUsed,
} from "../src/learning/retrospect";
import { relatedSelfSkills } from "../src/plugins/picked-skill";
import { createPluginStore } from "../src/plugins/store";
import { grantedSkills } from "../src/plugins/tools";
import { type SelfSkillDeps, saveSkill } from "../src/skills/save-tool";
import { withSourceFingerprints } from "../src/skills/usage";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 复盘写出的技能带着来源请求的指纹存下来，下一次同类请求靠它找到技能（见 self-skill-match.test.ts）。
 * 这里在真库上走一遍：交付成功的卡 -> 复盘 -> 技能账里有指纹（不是原文）-> 取出技能时带上 -> 第二次请求命中、记成用过。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `fp-owner-${suite}`;
const bot = `fp-bot-${suite}`;
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

const FIRST = taskPrompt("repeat", "eval/repeat-first");
const SECOND = taskPrompt("repeat", "eval/repeat-second");

/** 复盘按 RETRO_SYSTEM 写出的泛化技能：没有人名、日期、文件名。 */
const draft = {
  name: "会议纪要转待办CSV与邮件草稿",
  when: "收到一份项目周会纪要（.md），要求把明确分派给某位负责人的待办整理成待办表（.csv），再为每位负责人写一份邮件草稿（.md）时",
  steps: [
    "读 <dir>/TASK.md 和纪要文件（.md）",
    "用 python3 写待办表（.csv），截止日写成 YYYY-MM-DD",
    "为每位负责人写一份邮件草稿（.md）",
  ],
  pitfalls: [],
  verify: "待办表行数与纪要里分派的事项数一致",
  scope: "self",
} as const;

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

describe("the request a skill was learned from is kept as a fingerprint, not as text", () => {
  test("a delivered card's review saves the skill with the card's request as a fingerprint", async () => {
    const runId = `run-fp-${suite}`;
    const taskId = randomUUID();
    await asOwner(async () => {
      await database.insert(tasks).values({
        id: taskId,
        tenantId: owner,
        title: FIRST,
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
    const observe = createRetroObserver({
      retrospect: createRetrospector({
        database,
        selfSkill: (ownerUserId, agentId) => ({
          ...selfDeps(agentId),
          ownerUserId,
        }),
        modelFor: async () => ({}) as LanguageModel,
        call: async () => ({ text: JSON.stringify({ skill: draft }) }),
        existingSkills: async () => [],
        log: () => {},
      }),
      deliveredCard: (id) => deliveredCardOf(database, id),
      cardTurn: (id, current) =>
        cardRetroTurn(database, id, "card_delivered", current),
      log: () => {},
    });
    const outcome = await asOwner(() =>
      observe({
        tenant: owner,
        agentId: bot,
        threadId: `thread-${runId}`,
        runId,
        messages: [{ role: "user", content: FIRST }],
        events: roundEvents(11),
        failed: false,
        kind: "task",
      }),
    );
    expect(outcome).toMatchObject({ outcome: "saved", status: "active" });

    await asOwner(async () => {
      const [row] = await database
        .select()
        .from(learnedSkills)
        .where(eq(learnedSkills.agentId, bot));
      const stored = row?.sourceFingerprint ?? "";
      expect(stored).not.toBe("");
      for (const piece of ["多步办公", "办公", "TASK", "repeat", "eval"])
        expect(stored.toLowerCase()).not.toContain(piece.toLowerCase());
    });
  });

  test("the employee's own save_learned_skill has no request to take a fingerprint from, and stays null", async () => {
    await asOwner(async () => {
      const saved = await saveSkill(
        selfDeps(bot),
        { ...draft, name: "自己写的另一条做法" },
        "tool",
      );
      expect(saved.ok).toBe(true);
      const [row] = await database
        .select()
        .from(learnedSkills)
        .where(eq(learnedSkills.skillSlug, saved.ok ? saved.id : ""));
      expect(row).toHaveProperty("sourceFingerprint", null);
    });
  });

  test("the skill is picked for the second request, and counted as used", async () => {
    await asOwner(async () => {
      const held = await withSourceFingerprints(
        database,
        await grantedSkills({ store: plugins, botId: bot }),
      );
      const mine = held.find((skill) => skill.title === draft.name);
      expect(mine).toBeDefined();
      // The review's `when` is general; it is the fingerprint that finds it.
      expect(relatedSelfSkills(SECOND, held).map((skill) => skill.slug)).toEqual(
        [mine?.slug as string],
      );
      expect(
        relatedSelfSkills(taskPrompt("refactor", "eval/refactor"), held),
      ).toEqual([]);

      const [before] = await database
        .select()
        .from(learnedSkills)
        .where(eq(learnedSkills.skillSlug, mine?.slug as string));
      await markInjectedSkillsUsed(
        database,
        { agentId: bot, messages: [{ role: "user", content: SECOND }] },
        async (agentId) => (await plugins.listForAgent(agentId)).skills,
        new Date("2026-11-20T11:00:00Z"),
      );
      const [after] = await database
        .select()
        .from(learnedSkills)
        .where(eq(learnedSkills.skillSlug, mine?.slug as string));
      expect(after?.useCount).toBe((before?.useCount ?? 0) + 1);
    });
  });
});

// 最后注册的 afterAll：关掉本文件打开的连接池。
afterAll(async () => {
  await database.$client.close();
});
