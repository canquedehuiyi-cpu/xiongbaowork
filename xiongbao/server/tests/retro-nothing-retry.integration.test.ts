import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { LanguageModel } from "ai";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { learnedSkills } from "../src/db/schema";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import {
  createRetroObserver,
  createRetrospector,
} from "../src/learning/retrospect";
import { createPluginStore } from "../src/plugins/store";
import { type SelfSkillDeps, slugFor } from "../src/skills/save-tool";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 交付成功、步数够多的看板卡，模型第一次答「不值得」时重问一次：第二次给出技能就存下来，日志写明重问过。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `retry-owner-${suite}`;
const bot = `retry-bot-${suite}`;
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
  now: () => new Date("2026-11-20T10:00:00Z"),
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

const draft = {
  name: "月报汇总",
  when: "把月度销售表整理成带图表的汇总报告，需要按地区分组",
  steps: ["读取月度销售表（.csv）", "按地区汇总并画图", "写成汇总报告（.md）"],
  pitfalls: [],
  verify: "汇总总数与原表合计一致",
  scope: "self",
};

const cardTurn = (steps: number) => ({
  ownerUserId: owner,
  agentId: bot,
  threadId: "t",
  runId: "r",
  cardId: "card-retry",
  request: "把月度销售表整理成带图表的汇总报告",
  reply: "好了",
  steps: Array.from({ length: steps }, () => ({
    tool: "computer_run_command",
    ok: true,
    args: "",
    result: "",
  })),
  failed: false,
  trigger: "card_delivered" as const,
});

describe("交付的看板卡被判不值得时重问", () => {
  test("第一次答不值得、第二次给出技能：最终存下并生效", async () => {
    await asOwner(async () => {
      let asked = 0;
      const retrospect = createRetrospector({
        database,
        selfSkill: (ownerUserId, agentId) => ({
          ...depsFor(agentId),
          ownerUserId,
        }),
        modelFor: async () => ({}) as LanguageModel,
        call: async () => {
          asked += 1;
          return {
            text: JSON.stringify({ skill: asked === 1 ? null : draft }),
          };
        },
        existingSkills: async () => [],
        log: () => undefined,
      });
      const outcome = await retrospect(cardTurn(17));
      const slug = slugFor(bot, "月报汇总");
      expect(asked).toBe(2);
      expect(outcome).toEqual({
        outcome: "saved",
        id: slug,
        status: "active",
        retried: true,
      });
      expect(
        await database
          .select()
          .from(learnedSkills)
          .where(eq(learnedSkills.skillSlug, slug)),
      ).toHaveLength(1);
    });
  });

  test("观察者的日志行写明重问过", async () => {
    const lines: Record<string, unknown>[] = [];
    const observe = createRetroObserver({
      retrospect: async () => ({ outcome: "nothing", retried: true }),
      deliveredCard: async () => null,
      cardTurn: async () => null,
      log: (line) => lines.push(JSON.parse(line)),
    });
    await observe({
      tenant: owner,
      agentId: bot,
      threadId: "t",
      runId: "r",
      messages: [],
      events: [],
      failed: false,
      kind: "chat",
    });
    expect(lines[0]).toMatchObject({ type: "retrospect", retried: true });
  });
});
