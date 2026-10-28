import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { approvalRequests } from "../src/db/schema/approvals";
import { users } from "../src/db/schema/core";
import { createApprovalStore } from "../src/approvals/store";
import { createApprovalService } from "../src/approvals/service";
import { approvalAction } from "../src/approvals/types";
import { runAsTenant } from "../src/tenant/context";
// Explicit opt-in disposable PG only. Never import this file in CPU runs.
const raw = process.env.TEST_DATABASE_URL;
if (!raw) throw new Error("BLOCKED_TEST_DATABASE_URL: NOT RUN");
const url = new URL(raw);
const name = decodeURIComponent(url.pathname.slice(1));
if (
  !/^postgres(?:ql)?:$/.test(url.protocol) ||
  !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
  !/^openbot_continuation_test_[0-9a-f]{16}$/.test(name) ||
  process.env.TEST_DATABASE_DISPOSABLE !== name
)
  throw new Error("BLOCKED_NOT_DISPOSABLE");
const a = createDatabase(raw, { max: 1 });
const b = createDatabase(raw, { max: 1 });
const owner = `ap3-${crypto.randomUUID()}`;
const id = crypto.randomUUID();
const action = approvalAction({
  actorId: owner,
  botId: "bot",
  toolRef: "click",
  effect: "write",
  scope: "fixture.invalid",
  args: {},
  continuation: {
    runId: "original",
    threadId: "thread",
    toolCallId: "call",
    toolName: "click",
    args: {},
    messages: [],
    state: {},
    context: [],
    forwardedProps: {},
  },
});
const scope = <T>(fn: () => T) => runAsTenant(owner, fn);
beforeAll(async () => {
  await scope(() =>
    a.insert(users).values({
      id: owner,
      name: "AP3 PG fixture",
      email: `${owner}@fixture.invalid`,
    }),
  );
  await scope(() =>
    a.insert(approvalRequests).values({
      id,
      ownerUserId: owner,
      tenantId: owner,
      runId: action.runId,
      toolCallId: action.toolCallId,
      actionDigest: action.actionDigest,
      action,
      status: "consumed",
      result: { content: "saved" },
    }),
  );
});
afterAll(async () => {
  await scope(() =>
    a.delete(approvalRequests).where(eq(approvalRequests.id, id)),
  );
  await scope(() => a.delete(users).where(eq(users.id, owner)));
  await a.$client.close();
  await b.$client.close();
});
test("PG owned recovery DTO uses actual parent columns on independent connections", async () => {
  const first = await scope(() =>
    createApprovalStore(a).getRecoveryContext?.(owner, id),
  );
  const second = await scope(() =>
    createApprovalStore(b).getRecoveryContext?.(owner, id),
  );
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(first?.tenantId).toBe(owner);
  expect(second?.parentActionDigest).toBe(action.actionDigest);
});
test("PG no port blocks without changing saved approval or calling ordinary callbacks", async () => {
  let calls = 0;
  const service = createApprovalService(createApprovalStore(a));
  await expect(
    scope(() =>
      service.resume(owner, id, {
        validate: async () => action,
        execute: async () => {
          calls++;
          return "unexpected";
        },
        continue: async () => {
          calls++;
        },
      }),
    ),
  ).rejects.toThrow("blocked");
  const row = await scope(() => createApprovalStore(b).get(owner, id));
  expect(row.status).toBe("consumed");
  expect(row.result).toEqual({ content: "saved" });
  expect(calls).toBe(0);
});
test("PG cross owner recovery lookup is refused", async () => {
  await expect(
    scope(() => createApprovalStore(b).getRecoveryContext?.("other", id)),
  ).rejects.toThrow();
});
