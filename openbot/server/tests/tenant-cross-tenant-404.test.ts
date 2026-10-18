import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/app-variables";
import { createDatabase } from "../src/db/client";
import { tasks } from "../src/db/schema";
import { createTaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec D15's sentence, at the seam where it is actually paid for: "跨租户默认 404 而非 403".
 *
 * A 403 is a leak wearing a refusal — it says the card exists, that you are not allowed, and therefore
 * hands a stranger the roster of another workspace's work by id. A 404 is the only answer that is also
 * true under row-level security, because the row genuinely is not here for this caller. RLS makes it
 * invisible; this asserts the route says so instead of inventing a permission error.
 *
 * The last case is the one that keeps the first two honest: the same transition, run by the tenant that
 * owns the card, succeeds. Without it a route that returned 404 for everybody — a broken lookup, a
 * mis-set scope — would pass this file.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `w-${suite}-owner`;
const stranger = `w-${suite}-stranger`;
const projector = createTaskProjector(database);

const routesFor = (actorId: string) => {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: actorId, role: "user" as const });
    await next();
  };
  return createTaskRoutes(database, requireUser, projector);
};

const owned = await runAsTenant(owner, async () => {
  const [row] = await database
    .insert(tasks)
    .values({
      title: "Card only its own workspace may touch",
      executorAgentId: `${suite}-agent`,
      source: "chat",
      status: "awaiting_review",
    })
    .returning({ id: tasks.id });
  return row!.id;
});

const post = (actorId: string, path: string) =>
  runAsTenant(actorId, () =>
    routesFor(actorId).request(
      new Request(`http://openbot.test/${path}`, { method: "POST" }),
    ),
  );

const statusOf = async (taskId: string) => {
  const [row] = await runAsTenant(owner, () =>
    database
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId)),
  );
  return row?.status;
};

afterAll(async () => {
  for (const scope of [owner, stranger]) {
    await runAsTenant(scope, async () => {
      await database.delete(tasks).where(eq(tasks.tenantId, scope));
    });
  }
});

test("a stranger cannot see the card in the list at all", async () => {
  const visible = await runAsTenant(stranger, async () => {
    const response = await routesFor(stranger).request(
      new Request("http://openbot.test/"),
    );
    return (await response.json()) as { tasks: { id: string }[] };
  });
  expect(visible.tasks.map((task) => task.id)).not.toContain(owned);
});

test("the stranger's review and archive are answered with a 404, and the card is untouched", async () => {
  const review = await post(stranger, `${owned}/review`);
  expect(review.status).toBe(404);

  const archive = await post(stranger, `${owned}/archive`);
  expect(archive.status).toBe(404);

  // Refused means nothing moved: no status change, no silent archive.
  expect(await statusOf(owned)).toBe("awaiting_review");
});

test("the same transitions by the owning workspace still work", async () => {
  const review = await post(owner, `${owned}/review`);
  expect(review.status).toBe(200);
  expect(await statusOf(owned)).toBe("done");
});

test("a real state conflict is still a 409, so the 404 above did not swallow it", async () => {
  /*
   * The card is now `done`, so reviewing it again is a genuine lane error rather than a tenancy one.
   * Without this case the fix would be unverifiable in the other direction: a route that answered 404
   * for everything would pass every assertion above.
   */
  const again = await post(owner, `${owned}/review`);
  expect(again.status).toBe(409);

  // A well-formed id that nobody owns, and one that cannot be an id at all, get the same answer as a
  // foreign card: three kinds of "not here", one status, and no oracle for which of them it was.
  const absent = await post(owner, `${randomUUID()}/review`);
  expect(absent.status).toBe(404);

  const malformed = await post(owner, `${suite}-no-such-card/review`);
  expect(malformed.status).toBe(404);
});
