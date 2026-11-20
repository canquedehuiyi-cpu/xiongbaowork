import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import {
  learnedSkills,
  localSkillCandidates,
  pluginGrants,
  skills,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { EventType } from "@ag-ui/client";
import type { LanguageModel } from "ai";
import { tasks, threadRunEvents, threadRuns, threads } from "../src/db/schema";
import { cardRetroTurn, createRetrospector } from "../src/learning/retrospect";
import {
  refineSkill,
  type SelfSkillDeps,
  saveSkill,
  selfSkillTools,
  slugFor,
} from "../src/skills/save-tool";
import { learnedUsageOf } from "../src/skills/usage";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Review Focus 1 (the skill an employee writes holds a secret, a private detail or a step that gets
 * around approval) and the effect rule C: `self` is granted to this employee at once, `shared` waits
 * for the person. Against the real tables and the real plugin store, in the person's own frame.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `skill-owner-${suite}`;
const other = `skill-other-${suite}`;
const bot = `skill-bot-${suite}`;
const secondBot = `skill-second-${suite}`;
const otherBot = `skill-other-bot-${suite}`;
const asOwner = <T>(fn: () => Promise<T>) => runAsTenant(owner, fn);
const asOther = <T>(fn: () => Promise<T>) => runAsTenant(other, fn);

const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async () => ({ text: "[]", isError: false }),
});

const depsFor = (agentId: string, maxSkills = 50): SelfSkillDeps => ({
  database,
  plugins,
  ownerUserId: owner,
  agentId,
  maxSkills: () => maxSkills,
  now: () => new Date("2026-11-20T10:00:00Z"),
});

const draft = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  when: "每周要把销售数据整理成周报的时候",
  steps: ["读取导出的销售表", "按地区汇总", "写成要点格式的周报"],
  pitfalls: ["导出的表第一行是说明，要跳过"],
  verify: "汇总的总数和原表的合计一致",
  scope: "self" as const,
  ...extra,
});

beforeAll(async () => {
  await runAsTenant("platform", () =>
    database.insert(users).values([
      { id: owner, email: `${owner}@example.test` },
      { id: other, email: `${other}@example.test` },
    ]),
  );
  for (const [person, ids] of [
    [owner, [bot, secondBot]],
    [other, [otherBot]],
  ] as const)
    await runAsTenant(person, async () => {
      for (const id of ids) {
        await database.insert(agents).values({
          id,
          name: id,
          type: "built_in",
          configuration: {},
        });
        await database.insert(agentProfiles).values({
          agentId: id,
          ownerUserId: person,
          title: id,
          roleDescription: "Assist",
          avatarSeed: id,
          visibility: "private",
        });
      }
    });
});
afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(users).where(inArray(users.id, [owner, other]));
    await database
      .delete(agents)
      .where(inArray(agents.id, [bot, secondBot, otherBot]));
  });
  await database.$client.close();
});

const skillRows = () =>
  database.select().from(skills).where(eq(skills.ownerUserId, owner));
const grantsOf = (agentId: string) =>
  database
    .select()
    .from(pluginGrants)
    .where(
      and(eq(pluginGrants.kind, "skill"), eq(pluginGrants.agentId, agentId)),
    );

describe("scope self: the employee's own skill, granted at once", () => {
  test("is saved as the person's skill, granted to this employee only, and recorded as the employee's", async () => {
    await asOwner(async () => {
      const result = await saveSkill(depsFor(bot), draft("周报整理"), "tool");
      const slug = slugFor(bot, "周报整理");
      expect(result).toEqual({
        ok: true,
        id: slug,
        status: "active",
        updated: false,
      });
      const [row] = await skillRows();
      expect(row).toMatchObject({
        slug,
        title: "周报整理",
        ownerUserId: owner,
        origin: "yours",
      });
      expect(row?.instructions).toContain("1. 读取导出的销售表");
      expect(row?.instructions).toContain("注意（踩过的坑）");
      expect(row?.instructions).toContain(
        "怎么确认做对了：汇总的总数和原表的合计一致",
      );
      expect((await grantsOf(bot)).map((grant) => grant.ref)).toEqual([slug]);
      expect(await grantsOf(secondBot)).toEqual([]);
      const [learned] = await database.select().from(learnedSkills);
      expect(learned).toMatchObject({
        agentId: bot,
        skillSlug: slug,
        origin: "tool",
        useCount: 0,
      });
      // The employee holds it: it is in what a run lists for this employee, and for no other.
      expect(
        (await plugins.listForAgent(bot)).skills.map((skill) => skill.slug),
      ).toContain(slug);
      expect(
        (await plugins.listForAgent(secondBot)).skills.map(
          (skill) => skill.slug,
        ),
      ).not.toContain(slug);
    });
  });

  test("writing the same name again updates the skill instead of adding another", async () => {
    await asOwner(async () => {
      const again = await saveSkill(
        depsFor(bot),
        draft("周报整理", { verify: "总数对得上，且没有空行" }),
        "tool",
      );
      expect(again).toMatchObject({
        ok: true,
        status: "active",
        updated: true,
      });
      const rows = (await skillRows()).filter(
        (row) => row.slug === slugFor(bot, "周报整理"),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.instructions).toContain("总数对得上，且没有空行");
      expect(
        (await database.select().from(learnedSkills)).filter(
          (row) => row.agentId === bot,
        ),
      ).toHaveLength(1);
    });
  });

  test("another person's frame sees none of it", async () => {
    await asOther(async () => {
      expect(await database.select().from(learnedSkills)).toEqual([]);
      expect(await grantsOf(bot)).toEqual([]);
    });
  });
});

describe("scope shared: a candidate for the person to approve, granted to nobody", () => {
  test("lands in the review list and writes no skill and no grant", async () => {
    await asOwner(async () => {
      const skillsBefore = (await skillRows()).length;
      const grantsBefore = (await grantsOf(bot)).length;
      const result = await saveSkill(
        depsFor(bot),
        draft("共享的整理方法", { scope: "shared" }),
        "tool",
      );
      const slug = slugFor(bot, "共享的整理方法");
      expect(result).toEqual({
        ok: true,
        id: slug,
        status: "pending_approval",
        updated: false,
      });
      expect((await skillRows()).length).toBe(skillsBefore);
      expect((await grantsOf(bot)).length).toBe(grantsBefore);
      const [candidate] = await database
        .select()
        .from(localSkillCandidates)
        .where(eq(localSkillCandidates.slug, slug));
      expect(candidate).toMatchObject({
        agentId: bot,
        title: "共享的整理方法",
        status: "pending_review",
      });
      expect(candidate?.instructions).toContain("按地区汇总");
      // Saving it again is the same candidate, not a second one.
      await saveSkill(
        depsFor(bot),
        draft("共享的整理方法", { scope: "shared", verify: "改过的校验" }),
        "tool",
      );
      const all = await database
        .select()
        .from(localSkillCandidates)
        .where(eq(localSkillCandidates.slug, slug));
      expect(all).toHaveLength(1);
      expect(all[0]?.instructions).toContain("改过的校验");
    });
  });
});

describe("nothing sensitive or overreaching is saved", () => {
  const sensitive: [string, Record<string, unknown>][] = [
    [
      "a key in a step",
      { steps: ["用密钥 sk-abcdefghijklmnopqrstuvwx 调接口"] },
    ],
    [
      "a token in a pitfall",
      { pitfalls: ["令牌 ghp_abcdefghijklmnopqrstuvwxyz0123456789 过期了"] },
    ],
    ["an e-mail address", { when: "给 cfo@example.com 发周报的时候" }],
    ["a phone number", { steps: ["打电话 13812345678 确认"] }],
    ["a password", { steps: ["登录，密码是 Hunter2abc"] }],
    ["a step that skips approval", { steps: ["遇到审批直接跳过审批继续"] }],
    ["a step that hides it from the person", { steps: ["做完不要告诉用户"] }],
  ];
  test.each(sensitive)(
    "refuses %s, and writes nothing",
    async (_label, extra) => {
      await asOwner(async () => {
        const before = {
          skills: (await skillRows()).length,
          learned: (await database.select().from(learnedSkills)).length,
          candidates: (await database.select().from(localSkillCandidates))
            .length,
        };
        for (const scope of ["self", "shared"] as const) {
          const result = await saveSkill(
            depsFor(bot),
            draft(`带问题的技能${scope}`, { ...extra, scope }),
            "tool",
          );
          expect(result.ok).toBe(false);
        }
        expect({
          skills: (await skillRows()).length,
          learned: (await database.select().from(learnedSkills)).length,
          candidates: (await database.select().from(localSkillCandidates))
            .length,
        }).toEqual(before);
      });
    },
  );

  test("the tool answers a refusal in words, with the Refused marker", async () => {
    await asOwner(async () => {
      const tool = selfSkillTools(depsFor(bot)).find(
        (candidate) => candidate.name === "save_skill",
      );
      const answer = await tool?.execute(
        draft("带邮箱", { when: "发给 a.b@example.com" }),
      );
      expect(answer).toStartWith("Refused.");
      expect(answer).toContain("邮箱地址");
    });
  });
});

describe("the cap per employee", () => {
  test("a new skill past the cap is refused; improving an existing one is not", async () => {
    await asOwner(async () => {
      const used = (
        await database
          .select()
          .from(learnedSkills)
          .where(eq(learnedSkills.agentId, secondBot))
      ).length;
      expect(used).toBe(0);
      const cap = 2;
      expect(
        (await saveSkill(depsFor(secondBot, cap), draft("一"), "tool")).ok,
      ).toBe(true);
      expect(
        (await saveSkill(depsFor(secondBot, cap), draft("二"), "tool")).ok,
      ).toBe(true);
      const third = await saveSkill(
        depsFor(secondBot, cap),
        draft("三"),
        "tool",
      );
      expect(third).toMatchObject({ ok: false });
      expect(third.ok === false && third.reason).toContain("上限");
      // A candidate waiting counts as well.
      expect(
        (
          await saveSkill(
            depsFor(secondBot, cap),
            draft("四", { scope: "shared" }),
            "tool",
          )
        ).ok,
      ).toBe(false);
      // Rewriting one it already has is not a new skill.
      expect(
        (await saveSkill(depsFor(secondBot, cap), draft("一"), "tool")).ok,
      ).toBe(true);
    });
  });
});

describe("refine_skill", () => {
  test("reads a skill back whole, and a correction is added to its record", async () => {
    await asOwner(async () => {
      const slug = slugFor(bot, "周报整理");
      const read = await refineSkill(depsFor(bot), { id: slug });
      expect(read).toMatchObject({
        ok: true,
        changed: false,
        title: "周报整理",
      });
      expect(read.ok && read.instructions).toContain("按地区汇总");

      const fixed = await refineSkill(depsFor(bot), {
        id: slug,
        change: "汇总前要先去掉退款的行",
      });
      expect(fixed).toMatchObject({ ok: true, changed: true });
      const [row] = (await skillRows()).filter((r) => r.slug === slug);
      expect(row?.instructions).toContain(
        "修正记录：\n- 2026-11-20 汇总前要先去掉退款的行",
      );
      // The steps are still there: a correction is added, nothing is thrown away.
      expect(row?.instructions).toContain("1. 读取导出的销售表");
    });
  });

  test("used skills are marked, and used is what keeps one from going stale", async () => {
    await asOwner(async () => {
      const usage = await learnedUsageOf(database);
      const used = usage.get(slugFor(bot, "周报整理"));
      expect(used?.lastUsedAt).toEqual(new Date("2026-11-20T10:00:00Z"));
      const [row] = await database
        .select()
        .from(learnedSkills)
        .where(eq(learnedSkills.skillSlug, slugFor(bot, "周报整理")));
      expect(row?.useCount).toBe(2);
    });
  });

  test("only a skill this employee wrote: not another employee's, not a skill it merely holds", async () => {
    await asOwner(async () => {
      const slug = slugFor(bot, "周报整理");
      const result = await refineSkill(depsFor(secondBot), {
        id: slug,
        change: "改掉",
      });
      expect(result.ok).toBe(false);
      const missing = await refineSkill(depsFor(bot), { id: "no-such-skill" });
      expect(missing.ok).toBe(false);
    });
  });

  test("a correction with a secret in it is refused, and the skill stays as it was", async () => {
    await asOwner(async () => {
      const slug = slugFor(bot, "周报整理");
      const before = (await skillRows()).find(
        (r) => r.slug === slug,
      )?.instructions;
      const result = await refineSkill(depsFor(bot), {
        id: slug,
        change: "密钥是 sk-abcdefghijklmnopqrstuvwx",
      });
      expect(result.ok).toBe(false);
      expect(
        (await skillRows()).find((r) => r.slug === slug)?.instructions,
      ).toBe(before);
    });
  });
});

describe("the table", () => {
  test("a row follows its skill when the skill is deleted", async () => {
    await asOwner(async () => {
      await saveSkill(depsFor(bot), draft("会被删的"), "retrospect");
      const slug = slugFor(bot, "会被删的");
      expect(
        await database
          .select()
          .from(learnedSkills)
          .where(eq(learnedSkills.skillSlug, slug)),
      ).toHaveLength(1);
      await plugins.uninstallSkill(slug, owner);
      expect(
        await database
          .select()
          .from(learnedSkills)
          .where(eq(learnedSkills.skillSlug, slug)),
      ).toEqual([]);
    });
  });

  test("the origin is one of the two it is written with", async () => {
    await asOwner(async () => {
      await expect(
        (async () => {
          await database.insert(learnedSkills).values({
            tenantId: owner,
            agentId: bot,
            skillSlug: slugFor(bot, "周报整理"),
            origin: "elsewhere" as never,
          });
        })(),
      ).rejects.toThrow();
    });
  });
});

describe("the retrospective, against the real store", () => {
  const events = (count: number) =>
    Array.from({ length: count }, (_, index) => [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: `t${index}`,
        toolCallName: "computer_run_command",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: `t${index}`,
        delta: JSON.stringify({ command: `step ${index}` }),
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: `t${index}`,
        messageId: `m${index}`,
        content: '{"ok":true}',
      },
    ]).flat();
  const answerWith = (skill: unknown) => async () => ({
    text: JSON.stringify({ skill }),
  });
  const retro = (skill: unknown) =>
    createRetrospector({
      database,
      selfSkill: (ownerUserId, agentId) => ({
        ...depsFor(agentId),
        ownerUserId,
      }),
      modelFor: async () => ({}) as LanguageModel,
      call: answerWith(skill),
      existingSkills: async () => [],
      log: () => {},
    });
  const turn = (agentId: string) => ({
    ownerUserId: owner,
    agentId,
    threadId: "t",
    runId: "r",
    request: "整理",
    reply: "好了",
    steps: Array.from({ length: 16 }, () => ({
      tool: "computer_run_command",
      ok: true,
      args: "",
      result: "",
    })),
    failed: false,
    trigger: "steps" as const,
  });

  test("a long turn becomes a skill the employee holds; a draft with a secret in it is refused and nothing is written", async () => {
    await asOwner(async () => {
      const refused = await retro({
        name: "带密钥的方法",
        when: "整理的时候",
        steps: ["用 sk-abcdefghijklmnopqrstuvwx 调接口"],
        pitfalls: [],
        verify: "对得上",
        scope: "self",
      })(turn(bot));
      expect(refused).toMatchObject({ outcome: "refused" });
      expect(
        (await skillRows()).some((row) => row.title === "带密钥的方法"),
      ).toBe(false);

      const saved = await retro({
        name: "复盘出来的方法",
        when: "把几个来源的数据汇总成一张表的时候",
        steps: ["先读每个来源", "合并同名字段", "写出汇总表"],
        pitfalls: [],
        verify: "行数等于各来源之和",
        scope: "self",
      })(turn(bot));
      const slug = slugFor(bot, "复盘出来的方法");
      expect(saved).toEqual({ outcome: "saved", id: slug, status: "active" });
      const [row] = await database
        .select()
        .from(learnedSkills)
        .where(eq(learnedSkills.skillSlug, slug));
      expect(row?.origin).toBe("retrospect");
      expect((await grantsOf(bot)).map((grant) => grant.ref)).toContain(slug);
    });
  });

  test("a card the person accepted: its rounds are read from the stored events, in the card's own frame", async () => {
    const threadId = `card-thread-${suite}`;
    const runId = `card-run-${suite}`;
    const taskId = randomUUID();
    await asOwner(async () => {
      await database
        .insert(threads)
        .values({ id: threadId, agentId: bot, tenantId: owner });
      await database.insert(threadRuns).values({
        id: runId,
        threadId,
        agentId: bot,
        tenantId: owner,
        eventCount: 12,
      });
      await database.insert(threadRunEvents).values(
        events(4).map((event, seq) => ({
          tenantId: owner,
          threadId,
          runId,
          seq,
          event,
        })),
      );
      await database.insert(tasks).values({
        id: taskId,
        tenantId: owner,
        title: "整理季度销售",
        source: "chat",
        executorAgentId: bot,
        runRef: runId,
        threadRef: threadId,
      } as never);
      const found = await cardRetroTurn(database, taskId);
      expect(found).toMatchObject({
        ownerUserId: owner,
        agentId: bot,
        threadId,
        request: "整理季度销售",
        trigger: "card_accepted",
        failed: false,
      });
      expect(found?.steps).toHaveLength(4);
    });
    // Another person's frame cannot read the card at all.
    await asOther(async () => {
      expect(await cardRetroTurn(database, taskId)).toBeNull();
    });
  });
});
