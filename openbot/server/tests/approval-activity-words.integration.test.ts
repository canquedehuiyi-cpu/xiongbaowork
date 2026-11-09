import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createActivityStore } from "../src/activity/activity";
import { createDatabase } from "../src/db/client";
import { approvalRequests } from "../src/db/schema/approvals";
import { users } from "../src/db/schema/core";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * FOUND IN THE 1.0 RC1 MAC PASS: a Bot's Activity row for a pending click read "Approve
 * computer_click · Approval · needs you · 10 hours ago · write", the tool's id and its effect. It is
 * said in the words its approval card uses, from the element the server resolved, on a real database
 * through the store the Bot's page reads.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const activity = createActivityStore(database);
const suite = randomUUID().slice(0, 8);
const owner = `approval-words-${suite}`;
const bot = `approval-words-bot-${suite}`;

/** A pending computer action, as the gateway's approval gate saves it. */
function pending(
  id: string,
  toolRef: string,
  args: Record<string, unknown>,
  element?: { ref: string; role: string; name: string },
) {
  return {
    id: `${suite}-${id}`,
    ownerUserId: owner,
    runId: "run",
    toolCallId: `call-${id}`,
    actionDigest: `digest-${id}`,
    action: {
      actorId: owner,
      botId: bot,
      toolRef,
      effect: "write" as const,
      scope: "en.wikipedia.org",
      args,
      target: {
        pageUrl: "https://en.wikipedia.org/wiki/Main_Page",
        ...(element
          ? { element: { ...element, type: "" }, snapshotId: 4 }
          : {}),
      },
      runId: "run",
      threadId: `thread-${suite}`,
      toolCallId: `call-${id}`,
      actionDigest: `digest-${id}`,
    },
  };
}

beforeAll(async () => {
  // The person is the platform's row; their approvals are theirs, written in their own tenant.
  await runAsTenant("platform", () =>
    database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test` }),
  );
  await runAsTenant(owner, () =>
    database.insert(approvalRequests).values([
      pending(
        "click",
        "computer_click",
        { ref: "f3e43", snapshotId: 4 },
        { ref: "f3e43", role: "link", name: "Python (programming language)" },
      ),
      pending("click-unnamed", "computer_click", { ref: "f9", snapshotId: 4 }),
      pending("open", "computer_navigate", {
        url: "https://en.wikipedia.org/wiki/Monty_Python",
      }),
      pending("type", "computer_type", {
        ref: "f7",
        snapshotId: 4,
        text: "monty python",
      }),
    ]),
  );
});

afterAll(async () => {
  await runAsTenant(owner, () =>
    database
      .delete(approvalRequests)
      .where(eq(approvalRequests.ownerUserId, owner)),
  );
  await runAsTenant("platform", () =>
    database.delete(users).where(inArray(users.id, [owner])),
  );
  await database.$client.end({ timeout: 5 });
});

test("a pending computer approval's Activity row is said in words, with no tool id or effect", async () => {
  // The Bot's page reads in its person's own tenant.
  const rows = (
    await runAsTenant(owner, () => activity.forBot(owner, bot))
  ).inProgress.filter((item) => item.kind === "approval");
  const byId = Object.fromEntries(
    rows.map((item) => [item.id.replace(`approval:${suite}-`, ""), item]),
  );
  expect(byId.click).toMatchObject({
    title: "在 en.wikipedia.org 上点击链接「Python (programming language)」",
    detail: null,
    status: "waiting for you",
    needsYou: true,
  });
  expect(byId["click-unnamed"]?.title).toBe("在 en.wikipedia.org 上点击");
  expect(byId.open?.title).toBe("在 en.wikipedia.org 上打开页面");
  expect(byId.type?.title).toBe("在 en.wikipedia.org 上填写字段");
  for (const row of rows) {
    expect(row.title).not.toMatch(/computer_|Approve /);
    expect(row.detail).not.toBe("write");
  }
});
