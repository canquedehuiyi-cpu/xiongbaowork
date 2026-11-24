import { afterAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { tasks, users } from "../src/db/schema";
import type { CardTurns } from "../src/tasks/card-turns";
import type { Delivery } from "../src/tasks/delivery";
import type { TaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A 退回 whose reason was said, but whose card could not be written (spec 2026-11-15-delivery-loop
 * §6): the claim on the card is let go and the turn just started is stopped, and the person is told
 * to try again. The card's writes are stood in for, so the fault can be made to happen; the card
 * itself is a real row, so the route's own "is it here" check is the real one.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const tenantId = `drf-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await runAsTenant(tenantId, () =>
    database.delete(tasks).where(eq(tasks.tenantId, tenantId)),
  );
  await runAsTenant("platform", () =>
    database.delete(users).where(inArray(users.id, [tenantId])),
  );
  await database.$client.close();
});

test("a return whose card write throws lets the claim go, stops the started turn, and answers 503", async () => {
  await runAsTenant(tenantId, () =>
    database
      .insert(users)
      .values({ id: tenantId, email: `${tenantId}@example.test` }),
  );
  // Only the columns every database has, so this runs wherever the suite does.
  const [card] = (await runAsTenant(tenantId, () =>
    database.execute(
      sql`insert into tasks (title, executor_agent_id, source, status) values ('核对发票', 'agent-x', 'chat', 'awaiting_review') returning id`,
    ),
  )) as unknown as { id: string }[];
  const taskId = card?.id as string;

  const claimedAt = new Date();
  const released: Date[] = [];
  const stopped: unknown[] = [];
  const said: string[] = [];
  const delivery = {
    claimReturn: async () => ({
      ok: true as const,
      threadRef: "thread-x",
      agentId: "agent-x",
      claimedAt,
    }),
    releaseReturn: async (_tenant: string, _task: string, at: Date) => {
      released.push(at);
    },
    returnTask: async () => {
      throw new Error("connection terminated");
    },
  } as unknown as Delivery;
  const turns: CardTurns = {
    sendAsUser: async (_tenant, _to, text) => {
      said.push(text);
      return { runId: "run-started", groupMessageId: null };
    },
    stopRound: async (_tenant, round) => {
      stopped.push(round);
    },
    say: async () => {},
  };
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: tenantId,
      email: `${tenantId}@example.test`,
      role: "user" as const,
    });
    await next();
  };
  const routes = createTaskRoutes(database, requireUser, {} as TaskProjector, {
    delivery,
    turns,
  });

  const logged = spyOn(console, "error").mockImplementation(() => {});
  const response = await runAsTenant(tenantId, () =>
    routes.request(
      new Request(`http://xiongbao.test/${taskId}/return`, {
        method: "POST",
        body: JSON.stringify({ reason: "补 C 家" }),
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  const lines = logged.mock.calls.map((call) => String(call[0]));
  logged.mockRestore();
  expect(response.status).toBe(503);
  // The fault is in the log, for whoever looks.
  expect(lines.join("\n")).toContain("task-return-write-failed");
  expect(((await response.json()) as { error: string }).error).toBe(
    "现在退回不了，稍后再试。",
  );
  expect(said).toEqual(["退回：补 C 家"]);
  expect(released).toEqual([claimedAt]);
  expect(stopped).toEqual([
    { threadId: "thread-x", agentId: "agent-x", runId: "run-started" },
  ]);
});
