import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { tasks } from "../src/db/schema";
import type { TaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * A person accepting a card as done is the second moment an employee reviews how the work went (期 2,
 * `learning/retrospect.ts`): the routes tell `onReviewed` after the acceptance went through, and only then.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenant = `review-hook-${suite}`;
const actor = {
  id: tenant,
  email: `${tenant}@example.test`,
  role: "user" as const,
};
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

let accepted = true;
const told: [string, string][] = [];
const projector = {
  reviewed: async () => accepted,
  archived: async () => accepted,
} as unknown as TaskProjector;
const routes = createTaskRoutes(database, requireUser, projector, {
  onReviewed: (tenantId, taskId) => {
    told.push([tenantId, taskId]);
  },
});

const [card] = await runAsTenant(tenant, () =>
  database
    .insert(tasks)
    .values({ title: "整理周报", source: "chat", status: "awaiting_review" })
    .returning({ id: tasks.id }),
);
const taskId = card?.id ?? "";

afterAll(async () => {
  await runAsTenant(tenant, () =>
    database.delete(tasks).where(eq(tasks.tenantId, tenant)),
  );
  await database.$client.close();
});

const post = (path: string) =>
  runAsTenant(tenant, () =>
    routes.request(
      new Request(`http://xiongbao.test/${path}`, { method: "POST" }),
    ),
  );

test("accepting a card tells onReviewed, with the person and the card", async () => {
  told.length = 0;
  accepted = true;
  expect((await post(`${taskId}/review`)).status).toBe(200);
  expect(told).toEqual([[tenant, taskId]]);
});

test("an acceptance that did not go through tells nobody", async () => {
  told.length = 0;
  accepted = false;
  expect((await post(`${taskId}/review`)).status).toBe(409);
  expect(told).toEqual([]);
});

test("archiving a card nobody follows is not an acceptance", async () => {
  told.length = 0;
  accepted = true;
  expect((await post(`${taskId}/archive`)).status).toBe(200);
  expect(told).toEqual([]);
});
