import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { learnedSkills, pluginGrants, skills } from "../src/db/schema";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import {
  createRetrospector,
  type RetroTurn,
  traceStepsOf,
} from "../src/learning/retrospect";
import { createPluginStore } from "../src/plugins/store";
import {
  type SelfSkillDeps,
  saveSkill,
  similarSkillOf,
  slugFor,
} from "../src/skills/save-tool";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 复盘结果替换员工这一轮自存的技能：复盘存下（自用生效）后，这一轮员工自己存的、名字不同的那几条移除；
 * 复盘转待审、没出草稿、被拒时自存的保留；别的轮存的、复盘写的不受影响；比近似时不拿这一轮自存的比。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `repl-owner-${suite}`;
const bot = `repl-bot-${suite}`;
const asOwner = <T>(fn: () => Promise<T>) => runAsTenant(owner, fn);

const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async () => ({ text: "[]", isError: false }),
});

const depsFor = (agentId: string): SelfSkillDeps => ({
  database,
  plugins,
  ownerUserId: owner,
  agentId,
  maxSkills: () => 50,
  now: () => new Date("2026-11-21T10:00:00Z"),
});

beforeAll(async () => {
  await runAsTenant("platform", () =>
    database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test` }),
  );
  await runAsTenant(owner, async () => {
    await database.insert(agents).values({
      id: bot,
      name: bot,
      type: "built_in",
      configuration: {},
    });
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
afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(users).where(eq(users.id, owner));
    await database.delete(agents).where(inArray(agents.id, [bot]));
  });
  await database.$client.close();
});

const draftOf = (name: string, when: string, steps: string[]) => ({
  name,
  when,
  steps,
  pitfalls: [],
  verify: "输出的行数和输入一致",
  scope: "self" as const,
});

/** 员工自己存一条技能（来源 tool），返回 id 和它在这一轮轨迹里的那一步。 */
async function employeeSaves(name: string, when: string) {
  const result = await saveSkill(
    depsFor(bot),
    draftOf(name, when, ["只读核对折算"]),
    "tool",
  );
  if (!result.ok) throw new Error(result.reason);
  const id = result.id;
  /*
   * 参数带着技能名，和真实的一步一样：结果里的 id 偶尔有一长串数字（随机，每次跑不同），会被脱敏成
   * `[number]`，这时复盘按参数里的名字算出同一个 id（`selfSavedSlugsOf`）。没带名字就认不出，测试随机变红。
   */
  const args = JSON.stringify({ name });
  const step = traceStepsOf([
    {
      type: "TOOL_CALL_START",
      toolCallId: `s-${id}`,
      toolCallName: "save_learned_skill",
    },
    { type: "TOOL_CALL_ARGS", toolCallId: `s-${id}`, delta: args },
    {
      type: "TOOL_CALL_RESULT",
      toolCallId: `s-${id}`,
      messageId: "m",
      content: JSON.stringify({
        saved: true,
        id,
        updated: false,
        note: "已存",
      }),
    },
  ] as never);
  return { id, step };
}

const work = Array.from({ length: 16 }, () => ({
  tool: "computer_run_command",
  ok: true,
  args: "",
  result: "",
}));

async function review(
  steps: RetroTurn["steps"],
  skill: Record<string, unknown> | null,
) {
  const logs: Record<string, unknown>[] = [];
  const retrospect = createRetrospector({
    database,
    selfSkill: (ownerUserId, agentId) => ({
      ...depsFor(agentId),
      ownerUserId,
    }),
    modelFor: async () => ({}) as LanguageModel,
    call: async () => ({ text: JSON.stringify({ skill }) }),
    existingSkills: async () => [],
    log: (line) => logs.push(JSON.parse(line)),
    limiter: { take: () => true },
    cooldownMs: 0,
  });
  const outcome = await retrospect({
    ownerUserId: owner,
    agentId: bot,
    threadId: "t",
    runId: `r-${randomUUID().slice(0, 6)}`,
    request: "把账单折算成汇总表",
    reply: "好了",
    steps,
    failed: false,
    trigger: "steps",
  });
  return { outcome, logs };
}

const ledgerHas = async (slug: string) =>
  (
    await database
      .select()
      .from(learnedSkills)
      .where(eq(learnedSkills.skillSlug, slug))
  ).length > 0;
const skillRow = async (slug: string) =>
  (await database.select().from(skills).where(eq(skills.slug, slug))).length >
  0;
const granted = async (slug: string) =>
  (
    await database
      .select()
      .from(pluginGrants)
      .where(and(eq(pluginGrants.kind, "skill"), eq(pluginGrants.ref, slug)))
  ).length > 0;

describe("复盘结果替换员工这一轮自存的技能", () => {
  test("复盘存下后，这一轮员工自存的那条被移除，别的轮自存的和复盘存的不动", async () => {
    await asOwner(async () => {
      const earlier = await employeeSaves(
        "别的轮存的甲",
        "整理会议室预订的记录",
      );
      const mine = await employeeSaves("账单折算草稿", "把账单折算成汇总表");
      const draft = draftOf(
        "账单折算并修复配置",
        "账单导入跑不通要折算并修复",
        ["先查配置", "再改配置并重算"],
      );
      const { outcome, logs } = await review([...work, ...mine.step], draft);
      const slug = slugFor(bot, "账单折算并修复配置");
      expect(outcome).toEqual({
        outcome: "saved",
        id: slug,
        status: "active",
        replaced: [mine.id],
      });
      expect(await skillRow(mine.id)).toBe(false);
      expect(await ledgerHas(mine.id)).toBe(false);
      expect(await granted(mine.id)).toBe(false);
      expect(await skillRow(slug)).toBe(true);
      expect(await granted(slug)).toBe(true);
      // 别的轮存的不受影响。
      expect(await skillRow(earlier.id)).toBe(true);
      expect(await ledgerHas(earlier.id)).toBe(true);
      const line = logs.find((entry) => entry.type === undefined);
      expect(line).toBeUndefined();
      expect(logs.some((entry) => entry.type === "retrospect-error")).toBe(
        false,
      );
    });
  });

  test("近似判断不拿这一轮自存的那条比：名字相近的复盘草稿照样存下并替换", async () => {
    await asOwner(async () => {
      const mine = await employeeSaves("发票汇总核对", "把发票汇总并核对金额");
      const draft = draftOf("发票汇总核对", "把发票汇总并核对金额", [
        "先查输入",
        "一步写好脚本",
      ]);
      // 不排除时，自存的那条就是「近似」。
      expect(await similarSkillOf(depsFor(bot), draft)).toBe(mine.id);
      expect(await similarSkillOf(depsFor(bot), draft, 0.75, [mine.id])).toBe(
        undefined,
      );
      // 同名：同 slug，saveSkill 覆盖，不另删，也不算替换。
      const { outcome } = await review([...work, ...mine.step], draft);
      expect(outcome).toEqual({
        outcome: "saved",
        id: mine.id,
        status: "active",
      });
      expect(await skillRow(mine.id)).toBe(true);
    });
  });

  test("复盘转待审（held）：员工自存的保留", async () => {
    await asOwner(async () => {
      const mine = await employeeSaves("上传前整理报表", "上传前整理月度报表");
      const draft = draftOf("月度报表上传", "把月度报表整理后交给协作方", [
        "整理报表",
        "上传到 https://upload.example.net/report",
      ]);
      const { outcome, logs } = await review([...work, ...mine.step], draft);
      expect(outcome).toMatchObject({
        outcome: "saved",
        status: "pending_approval",
      });
      expect(outcome).not.toHaveProperty("replaced");
      expect(logs.some((entry) => entry.type === "retrospect-held")).toBe(true);
      expect(await skillRow(mine.id)).toBe(true);
      expect(await ledgerHas(mine.id)).toBe(true);
    });
  });

  test("复盘没出草稿（nothing）或被拒（refused）：员工自存的保留", async () => {
    await asOwner(async () => {
      const mine = await employeeSaves("门店盘点汇总", "把门店盘点表汇总");
      const nothing = await review([...work, ...mine.step], null);
      expect(nothing.outcome).toEqual({ outcome: "nothing" });
      expect(await skillRow(mine.id)).toBe(true);
      const refusedDraft = draftOf("对接库存接口", "对接第三方库存接口", [
        "用密钥 sk-abcdefghijklmnopqrstuvwxyz123456 调接口",
      ]);
      const refused = await review([...work, ...mine.step], refusedDraft);
      expect(refused.outcome).toMatchObject({ outcome: "refused" });
      expect(await skillRow(mine.id)).toBe(true);
      expect(await ledgerHas(mine.id)).toBe(true);
    });
  });

  test("轨迹里认出的 id 不是这位员工自存的（复盘写的、别人的）：不移除", async () => {
    await asOwner(async () => {
      const retroMade = await saveSkill(
        depsFor(bot),
        draftOf("复盘写过的一条", "整理供应商对账单", ["读对账单"]),
        "retrospect",
      );
      if (!retroMade.ok) throw new Error(retroMade.reason);
      const forged = traceStepsOf([
        {
          type: "TOOL_CALL_START",
          toolCallId: "f",
          toolCallName: "save_learned_skill",
        },
        {
          type: "TOOL_CALL_RESULT",
          toolCallId: "f",
          messageId: "m",
          content: JSON.stringify({ saved: true, id: retroMade.id }),
        },
        {
          type: "TOOL_CALL_START",
          toolCallId: "g",
          toolCallName: "save_learned_skill",
        },
        {
          type: "TOOL_CALL_RESULT",
          toolCallId: "g",
          messageId: "m2",
          content: JSON.stringify({ saved: true, id: "auto-ffffffffff" }),
        },
      ] as never);
      const draft = draftOf("供应商对账并核销", "供应商对账并核销欠款", [
        "对账",
        "核销",
      ]);
      const { outcome } = await review([...work, ...forged], draft);
      expect(outcome).toMatchObject({ outcome: "saved", status: "active" });
      expect(outcome).not.toHaveProperty("replaced");
      expect(await skillRow(retroMade.id)).toBe(true);
    });
  });
});
