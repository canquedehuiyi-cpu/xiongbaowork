import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { tasks, users } from "../src/db/schema";
import { withinModelRun } from "../src/models/token-metering";
import type { GrantedTool } from "../src/plugins/tools";
import { createQuotaService } from "../src/quota/limits";
import { createDelivery } from "../src/tasks/delivery";
import {
  createDeliveryReview,
  REVIEW_NOTE_LABEL,
} from "../src/tasks/delivery-review";
import { deliveryTools } from "../src/tasks/delivery-tools";
import { createEvidenceGate } from "../src/tasks/evidence-gate";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 交付前评审（试点 4）经真实的 `deliver_task`：编码卡的交付里多一条评审意见，意见说什么都不挡交付，
 * 评审没跑成也一样；非编码卡不评审；没给评审（开关关）时交付和原来一样。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const projector = createTaskProjector(
  database,
  undefined,
  createQuotaService(database),
);
const delivery = createDelivery(database);
const gate = createEvidenceGate(database);
const suite = randomUUID().slice(0, 8);
const tenants: string[] = [];

async function tenant(label: string) {
  const id = `rv-${label}-${suite}`;
  await runAsTenant(id, () =>
    database.insert(users).values({ id, email: `${id}@example.test` }),
  );
  tenants.push(id);
  return id;
}

afterAll(async () => {
  for (const id of tenants)
    await runAsTenant(id, async () => {
      await database.delete(tasks).where(eq(tasks.tenantId, id));
      await database.delete(users).where(eq(users.id, id));
    });
  await database.$client.close();
});

/** A reviewer that answers `answer` (or fails), and remembers what it was asked. */
function reviewer(answer: string | Error | "hang") {
  const briefs: unknown[] = [];
  const parents: unknown[] = [];
  const review = createDeliveryReview({
    declared: async () => true,
    timeoutMs: 100,
    reviewer: (parent) => {
      parents.push(parent);
      return {
        name: "run_subagent",
        ref: "bot/run_subagent",
        description: "",
        parameters: {} as never,
        execute: async (args: unknown) => {
          briefs.push(args);
          if (answer === "hang") return new Promise<string>(() => undefined);
          if (answer instanceof Error) throw answer;
          return JSON.stringify({ answer, threadId: "sub", steps: 2 });
        },
      } satisfies GrantedTool;
    },
  });
  return { review, briefs, parents };
}

/** One card taken on and handed in, in one run; the tool's answer and the stored deliverable. */
async function handIn(options: {
  label: string;
  title: string;
  review?: ReturnType<typeof createDeliveryReview>;
  items: unknown[];
}) {
  const tenantId = await tenant(options.label);
  const agentId = `agent-${suite}-${options.label}`;
  const threadId = `thread-${suite}-${options.label}`;
  const runId = `run-${suite}-${options.label}`;
  await projector.opened({
    tenantId,
    title: options.title,
    executorAgentId: agentId,
    source: "chat",
    channelRef: threadId,
    runRef: runId,
  });
  const tools = deliveryTools({
    delivery,
    gate,
    board: projector,
    ownerUserId: tenantId,
    agentId,
    timeZone: () => "Asia/Shanghai",
    emit: () => undefined,
    ...(options.review ? { review: options.review } : {}),
  });
  const call = (name: string, args: unknown) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return runAsTenant(tenantId, () =>
      withinModelRun({ runId, threadId }, () => tool.execute(args)),
    );
  };
  await call("accept_task", { due_at: "40 分钟", criteria: "做完并自查。" });
  const result = JSON.parse(
    await call("deliver_task", {
      items: options.items,
      checks: ["bun test 全过"],
    }),
  ) as Record<string, unknown>;
  const [card] = await runAsTenant(tenantId, () =>
    database.select().from(tasks).where(eq(tasks.tenantId, tenantId)),
  );
  return {
    result,
    card,
    notes: (card?.deliverableRef as { notes?: string[] } | null)?.notes ?? [],
  };
}

const code = [{ kind: "note", ref: "已修复，改在 src/login.ts" }];

describe("a coding card's hand-in", () => {
  test("carries the reviewer's opinion as a note", async () => {
    const { review, briefs, parents } = reviewer("总的：可以交");
    const { result, card, notes } = await handIn({
      label: "note",
      title: "修复登录页的 bug",
      review,
      items: code,
    });
    expect(result.delivered).toBe(true);
    expect(card?.status).toBe("awaiting_review");
    expect(notes).toContain("已修复，改在 src/login.ts");
    const opinion = notes.find((note) => note.startsWith(REVIEW_NOTE_LABEL));
    expect(opinion).toContain("可以交");
    expect(briefs).toHaveLength(1);
    expect(JSON.stringify(briefs[0])).toContain("修复登录页的 bug");
    expect(JSON.stringify(briefs[0])).toContain("bun test 全过");
    expect(parents[0]).toMatchObject({ runId: `run-${suite}-note` });
  });

  test("goes in whatever the opinion says", async () => {
    const { review } = reviewer(
      "有疑问：测试文件里删掉了两条断言。总的：不建议交",
    );
    const { result, card, notes } = await handIn({
      label: "doubt",
      title: "修复登录页的 bug",
      review,
      items: code,
    });
    expect(result.delivered).toBe(true);
    expect(card?.status).toBe("awaiting_review");
    expect(notes.join("\n")).toContain("删掉了两条断言");
  });

  test("goes in when the review could not run, and says so", async () => {
    const { review } = reviewer(new Error("没有电脑"));
    const { result, card, notes } = await handIn({
      label: "broken",
      title: "修复登录页的 bug",
      review,
      items: code,
    });
    expect(result.delivered).toBe(true);
    expect(card?.status).toBe("awaiting_review");
    expect(notes.join("\n")).toContain("没跑成：没有电脑");
  });
});

describe("a review that never finishes", () => {
  test("does not keep the hand-in from being written, and says it timed out", async () => {
    const { review } = reviewer("hang");
    const started = Date.now();
    const { result, card, notes } = await handIn({
      label: "hang",
      title: "修复登录页的 bug",
      review,
      items: code,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.delivered).toBe(true);
    expect(card?.status).toBe("awaiting_review");
    expect(notes.join("\n")).toContain("评审超时，未附意见");
  });
});

describe("any other hand-in", () => {
  test("a card that is not a coding card is not reviewed", async () => {
    const { review, briefs } = reviewer("不该被问到");
    const { result, notes } = await handIn({
      label: "report",
      title: "整理本周周报",
      review,
      items: [{ kind: "note", ref: "周报写好了" }],
    });
    expect(result.delivered).toBe(true);
    expect(briefs).toHaveLength(0);
    expect(notes).toEqual(["周报写好了"]);
  });

  test("with no review given, which is the switch off, the hand-in is what it was", async () => {
    const { result, card } = await handIn({
      label: "off",
      title: "修复登录页的 bug",
      items: code,
    });
    expect(result.delivered).toBe(true);
    expect(card?.deliverableRef).toEqual({
      kind: "deliverable",
      notes: ["已修复，改在 src/login.ts"],
      checks: ["bun test 全过"],
    });
  });
});
