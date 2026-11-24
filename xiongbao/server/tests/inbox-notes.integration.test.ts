import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import {
  createInboxNotes,
  INBOX_NOTES_KIND,
} from "../src/approvals/inbox-notes";
import { createApprovalQuestions } from "../src/approvals/questions";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { ApprovalRefusedError } from "../src/approvals/types";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { approvalRequests } from "../src/db/schema/approvals";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 审批箱逐条批注（试点 5）：真库、真路由、行级安全。
 * 批注只回到发起事项的会话；只有主人能写和发送，别人读到 404；两个租户互不可见；开关关时没有这组路由。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `notes-${randomUUID()}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
const bot = `${prefix}-bot`;

const store = createApprovalStore(database);
const service = createApprovalService(
  store,
  createApprovalQuestions(database, async () => undefined),
);

/** 与部署里一样的校验：这位 Bot 和会话还在不在；`gone` 里的会话视为已不存在。 */
const gone = new Set<string>();
const authorise = async (question: { threadId: string }) => {
  if (gone.has(question.threadId))
    throw new ApprovalRefusedError(
      "That conversation is no longer available to this Bot and person.",
    );
};
const notes = createInboxNotes({
  database,
  authorise,
  approval: (owner, id) => store.get(owner, id),
});

const asUser = (id: string): Parameters<Hono["request"]>[1] => ({
  headers: { "content-type": "application/json", "x-person": id },
});
const build = (inboxNotes?: typeof notes) => {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/approvals",
    createApprovalRoutes(
      service,
      async (context, next) => {
        const id = context.req.header("x-person") ?? alice;
        context.set("actor", { id, email: `${id}@example.test`, role: "user" });
        await next();
      },
      undefined,
      inboxNotes,
    ),
  );
  return app;
};
const on = build(notes);
const off = build();
const call = (
  app: Hono<{ Variables: AppVariables }>,
  person: string,
  method: string,
  path: string,
  body?: unknown,
) =>
  runAsTenant(person, () =>
    Promise.resolve(
      app.request(`/api/approvals${path}`, {
        ...asUser(person),
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );

const as = <T>(person: string, body: () => Promise<T>) =>
  runAsTenant(person, body);

/** 一条等着主人回答的问题，和它被问出来的会话。 */
async function question(person: string, threadId: string, text: string) {
  const key = `${prefix}-q-${randomUUID()}`;
  await as(person, () =>
    database.insert(workItems).values({
      kind: "person.question",
      key,
      payload: {
        actorId: person,
        botId: bot,
        threadId,
        runId: `run-${threadId}`,
        question: text,
        mode: "completed_question",
      },
    }),
  );
  return key;
}

/** 一条等着主人批准的动作（外部员工带改过的文件）。 */
async function approval(person: string, threadId: string, files: string[]) {
  const id = `${prefix}-a-${randomUUID()}`;
  await as(person, () =>
    database.insert(approvalRequests).values({
      id,
      ownerUserId: person,
      runId: `run-${threadId}`,
      toolCallId: randomUUID(),
      actionDigest: randomUUID(),
      action: {
        actorId: person,
        botId: bot,
        toolRef: "acp/run_command",
        effect: "write",
        scope: "workspace",
        args: { command: "git push" },
        target: { acp: { action: "运行命令：git push", files } },
        runId: `run-${threadId}`,
        threadId,
        toolCallId: "tc",
        actionDigest: "d",
      } as never,
      status: "pending",
    }),
  );
  return id;
}

const responses = (person: string) =>
  as(person, () =>
    database
      .select()
      .from(workItems)
      .where(eq(workItems.kind, "person.response")),
  ).then((rows) =>
    rows.filter((row) =>
      String((row.payload as { ownerUserId?: string }).ownerUserId).startsWith(
        prefix,
      ),
    ),
  );

beforeAll(async () => {
  for (const id of [alice, bob])
    await runAsTenant(id, () =>
      database.insert(users).values({ id, email: `${id}@example.test` }),
    );
});

afterAll(async () => {
  for (const id of [alice, bob])
    await runAsTenant(id, async () => {
      await database
        .delete(workItems)
        .where(
          inArray(workItems.kind, [
            "person.question",
            "person.response",
            INBOX_NOTES_KIND,
          ]),
        );
      await database.delete(approvalRequests);
      await database.delete(users).where(eq(users.id, id));
    });
  await database.$client.close();
});

describe("a person's notes on a question", () => {
  test("several notes, one quoting a passage, are kept in order", async () => {
    const id = await question(alice, `${prefix}-t1`, "要不要把接口改成异步？");
    const first = await call(on, alice, "POST", `/items/question/${id}/notes`, {
      text: "先说清楚影响哪些调用方",
      quote: { text: "接口改成异步", start: 4, end: 10 },
    });
    expect(first.status).toBe(201);
    await call(on, alice, "POST", `/items/question/${id}/notes`, {
      text: "另外要补测试",
    });
    const listed = await (
      await call(on, alice, "GET", `/items/question/${id}/notes`)
    ).json();
    expect(listed.notes.map((note: { text: string }) => note.text)).toEqual([
      "先说清楚影响哪些调用方",
      "另外要补测试",
    ]);
    expect(listed.notes[0].quote).toEqual({
      text: "接口改成异步",
      start: 4,
      end: 10,
    });
    expect(listed.review).toBeNull();
  });

  test("a note can be removed before it is sent", async () => {
    const id = await question(alice, `${prefix}-t2`, "继续吗？");
    const added = await (
      await call(on, alice, "POST", `/items/question/${id}/notes`, {
        text: "写错了",
      })
    ).json();
    const removed = await call(
      on,
      alice,
      "DELETE",
      `/items/question/${id}/notes/${added.note.id}`,
    );
    expect(removed.status).toBe(200);
    const listed = await (
      await call(on, alice, "GET", `/items/question/${id}/notes`)
    ).json();
    expect(listed.notes).toEqual([]);
  });

  test("empty, over-long and malformed notes are refused", async () => {
    const id = await question(alice, `${prefix}-t3`, "好吗？");
    const post = (body: unknown) =>
      call(on, alice, "POST", `/items/question/${id}/notes`, body);
    expect((await post({ text: "   " })).status).toBe(400);
    expect((await post({ text: "长".repeat(2001) })).status).toBe(400);
    expect(
      (await post({ text: "好", quote: { text: "", start: 0, end: 0 } }))
        .status,
    ).toBe(400);
    expect(
      (await post({ text: "好", quote: { text: "x", start: 5, end: 2 } }))
        .status,
    ).toBe(400);
    expect((await post({ text: "好", extra: 1 })).status).toBe(400);
    expect(
      (
        await call(on, alice, "POST", `/items/other/${id}/notes`, {
          text: "好",
        })
      ).status,
    ).toBe(400);
  });

  test("a batch too long to send as one message is refused when it is written", async () => {
    const id = await question(alice, `${prefix}-t4`, "好吗？");
    const post = () =>
      call(on, alice, "POST", `/items/question/${id}/notes`, {
        text: "长".repeat(2000),
      });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(400);
  });
});

describe("sending the notes", () => {
  test("they become one message to the conversation that asked, and the question stays open", async () => {
    const thread = `${prefix}-send`;
    const id = await question(alice, thread, "要不要把接口改成异步？");
    for (const text of ["先说清影响", "补测试"])
      await call(on, alice, "POST", `/items/question/${id}/notes`, {
        text,
        quote:
          text === "补测试" ? { text: "异步", start: 8, end: 10 } : undefined,
      });
    const sent = await call(
      on,
      alice,
      "POST",
      `/items/question/${id}/notes/send`,
    );
    expect(sent.status).toBe(200);
    expect((await sent.json()).sent).toBe(2);

    const [row, ...rest] = await responses(alice);
    expect(rest).toEqual([]);
    const payload = row?.payload as {
      ownerUserId: string;
      question: { threadId: string; botId: string; actorId: string };
      response: string;
      notes?: boolean;
    };
    // 回到发起它的那一段会话，同一位 Bot，同一个人。
    expect(payload.question).toMatchObject({
      threadId: thread,
      botId: bot,
      actorId: alice,
    });
    expect(payload.ownerUserId).toBe(alice);
    expect(payload.notes).toBe(true);
    // 所有批注合成一条，带引用和序号。
    expect(payload.response).toContain("2 条批注");
    expect(payload.response).toContain("1. 批注：先说清影响");
    expect(payload.response).toContain("引用：「异步」");
    expect(payload.response).toContain("2. 引用：「异步」");
    expect(payload.response).toContain("批注：补测试");

    // 问题还在等主人回答，没有被这次发送关掉；批注已清空。
    const listed = await (
      await call(on, alice, "GET", `/items/question/${id}/notes`)
    ).json();
    expect(listed.notes).toEqual([]);
    const open = await as(alice, () => service.inbox(alice));
    expect(open.questions.map((item: { id: string }) => item.id)).toContain(id);
  });

  test("sending nothing is refused and queues nothing", async () => {
    const id = await question(alice, `${prefix}-empty`, "好吗？");
    const before = (await responses(alice)).length;
    const sent = await call(
      on,
      alice,
      "POST",
      `/items/question/${id}/notes/send`,
    );
    expect(sent.status).toBe(400);
    expect((await responses(alice)).length).toBe(before);
  });

  test("a second send is a second message, and the same notes are never sent twice", async () => {
    const id = await question(alice, `${prefix}-twice`, "好吗？");
    const send = () =>
      call(on, alice, "POST", `/items/question/${id}/notes/send`);
    await call(on, alice, "POST", `/items/question/${id}/notes`, {
      text: "一",
    });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(400);
    await call(on, alice, "POST", `/items/question/${id}/notes`, {
      text: "二",
    });
    expect((await send()).status).toBe(200);
    const mine = (await responses(alice)).filter(
      (row) =>
        (row.payload as { question: { threadId: string } }).question
          .threadId === `${prefix}-twice`,
    );
    expect(mine.map((row) => row.key).sort()).toHaveLength(2);
    expect(new Set(mine.map((row) => row.key)).size).toBe(2);
  });

  test("a conversation that is gone is refused and the notes are kept", async () => {
    const thread = `${prefix}-gone`;
    const id = await question(alice, thread, "好吗？");
    await call(on, alice, "POST", `/items/question/${id}/notes`, {
      text: "留着",
    });
    gone.add(thread);
    const before = (await responses(alice)).length;
    const sent = await call(
      on,
      alice,
      "POST",
      `/items/question/${id}/notes/send`,
    );
    expect(sent.status).toBe(400);
    expect((await responses(alice)).length).toBe(before);
    const listed = await (
      await call(on, alice, "GET", `/items/question/${id}/notes`)
    ).json();
    expect(listed.notes).toHaveLength(1);
  });

  test("a question that was already answered takes no more notes", async () => {
    const id = await question(alice, `${prefix}-done`, "好吗？");
    await as(alice, () =>
      database
        .update(workItems)
        .set({ finishedAt: new Date() })
        .where(eq(workItems.key, id)),
    );
    const added = await call(on, alice, "POST", `/items/question/${id}/notes`, {
      text: "晚了",
    });
    expect(added.status).toBe(404);
  });
});

describe("notes on an approval", () => {
  test("go back to the conversation the action was raised in, and show the code change in chapters", async () => {
    const thread = `${prefix}-appr`;
    const id = await approval(alice, thread, [
      "server/src/a.ts",
      "server/tests/a.test.ts",
      "package.json",
    ]);
    const added = await call(on, alice, "POST", `/items/approval/${id}/notes`, {
      text: "这个改动要先加测试",
    });
    expect(added.status).toBe(201);
    const listed = await (
      await call(on, alice, "GET", `/items/approval/${id}/notes`)
    ).json();
    expect(
      listed.review.map((chapter: { id: string; files: string[] }) => [
        chapter.id,
        chapter.files,
      ]),
    ).toEqual([
      ["core", ["server/src/a.ts"]],
      ["impact", ["server/tests/a.test.ts"]],
      ["glue", ["package.json"]],
    ]);
    expect(
      (await call(on, alice, "POST", `/items/approval/${id}/notes/send`))
        .status,
    ).toBe(200);
    const row = (await responses(alice)).find(
      (item) =>
        (item.payload as { question: { threadId: string } }).question
          .threadId === thread,
    );
    expect(row?.payload).toMatchObject({
      ownerUserId: alice,
      notes: true,
      question: { botId: bot, actorId: alice, threadId: thread },
    });
    // 批准本身没有被动过。
    const [stored] = await as(alice, () =>
      database
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, id)),
    );
    expect(stored?.status).toBe("pending");
  });

  test("a decided approval takes no more notes", async () => {
    const id = await approval(alice, `${prefix}-decided`, ["a.ts"]);
    await as(alice, () =>
      database
        .update(approvalRequests)
        .set({ status: "denied", decision: "deny" })
        .where(eq(approvalRequests.id, id)),
    );
    const added = await call(on, alice, "POST", `/items/approval/${id}/notes`, {
      text: "晚了",
    });
    expect(added.status).toBe(400);
  });
});

describe("whose notes they are", () => {
  test("another person gets a 404 for every route and nothing is written", async () => {
    const id = await question(alice, `${prefix}-priv`, "好吗？");
    const apid = await approval(alice, `${prefix}-priv-a`, ["a.ts"]);
    await call(on, alice, "POST", `/items/question/${id}/notes`, {
      text: "我的",
    });
    const attempts: [string, string, unknown?][] = [
      ["GET", `/items/question/${id}/notes`],
      ["POST", `/items/question/${id}/notes`, { text: "偷写" }],
      ["POST", `/items/question/${id}/notes/send`],
      ["DELETE", `/items/question/${id}/notes/anything`],
      ["GET", `/items/approval/${apid}/notes`],
      ["POST", `/items/approval/${apid}/notes`, { text: "偷写" }],
      ["POST", `/items/approval/${apid}/notes/send`],
    ];
    const before = (await responses(alice)).length;
    for (const [method, path, body] of attempts)
      expect((await call(on, bob, method, path, body)).status).toBe(404);
    // 主人的批注原样还在，也没有任何消息被排队。
    const listed = await (
      await call(on, alice, "GET", `/items/question/${id}/notes`)
    ).json();
    expect(listed.notes.map((note: { text: string }) => note.text)).toEqual([
      "我的",
    ]);
    expect((await responses(alice)).length).toBe(before);
    expect((await responses(bob)).length).toBe(0);
  });

  test("each tenant sees only its own notes rows, whatever it asks the database for", async () => {
    const mine = await question(alice, `${prefix}-iso-a`, "好吗？");
    const theirs = await question(bob, `${prefix}-iso-b`, "好吗？");
    await call(on, alice, "POST", `/items/question/${mine}/notes`, {
      text: "甲",
    });
    await call(on, bob, "POST", `/items/question/${theirs}/notes`, {
      text: "乙",
    });
    const rowsFor = (person: string) =>
      as(person, () =>
        database
          .select()
          .from(workItems)
          .where(eq(workItems.kind, INBOX_NOTES_KIND)),
      ).then((rows) =>
        rows
          .map((row) => JSON.stringify(row.payload))
          .filter((payload) => payload.includes(prefix)),
      );
    const aliceRows = await rowsFor(alice);
    const bobRows = await rowsFor(bob);
    expect(aliceRows.join()).toContain("甲");
    expect(aliceRows.join()).not.toContain("乙");
    expect(bobRows.join()).toContain("乙");
    expect(bobRows.join()).not.toContain("甲");
    // 两人各发各的：消息只带自己的批注，也只排进自己的队列。
    await call(on, alice, "POST", `/items/question/${mine}/notes/send`);
    await call(on, bob, "POST", `/items/question/${theirs}/notes/send`);
    const sentBy = async (person: string) =>
      (await responses(person))
        .map((row) => (row.payload as { response: string }).response)
        .join();
    expect(await sentBy(alice)).toContain("甲");
    expect(await sentBy(alice)).not.toContain("乙");
    expect(await sentBy(bob)).toContain("乙");
    expect(await sentBy(bob)).not.toContain("甲");
  });
});

describe("with the switch off", () => {
  test("the routes do not exist", async () => {
    const id = await question(alice, `${prefix}-off`, "好吗？");
    for (const [method, path, body] of [
      ["GET", `/items/question/${id}/notes`],
      ["POST", `/items/question/${id}/notes`, { text: "好" }],
      ["POST", `/items/question/${id}/notes/send`],
    ] as [string, string, unknown?][])
      expect((await call(off, alice, method, path, body)).status).toBe(404);
  });

  test("the inbox answers exactly as it did", async () => {
    const id = await question(alice, `${prefix}-inbox`, "好吗？");
    const inbox = await as(alice, () => service.inbox(alice));
    const item = inbox.questions.find((one: { id: string }) => one.id === id);
    expect(Object.keys(item ?? {}).sort()).toEqual(
      [
        "botId",
        "channelId",
        "conversationBotId",
        "createdAt",
        "id",
        "parts",
        "question",
        "threadId",
        "why",
      ].sort(),
    );
  });
});
