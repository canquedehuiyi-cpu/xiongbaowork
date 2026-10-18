import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { BotAccessCheck } from "../src/agents/profile-policy";
import type { AppVariables } from "../src/app-variables";
import { createComponentRoutes } from "../src/components/routes";
import type { ComponentStore } from "../src/components/store";

/**
 * The assembly boundary: a grant names a coworker, and naming one is not the same as owning one.
 *
 * `POST /:name/grants` and `DELETE /:name/grants/:agentId` are the two write routes in this file that
 * took a raw `agentId` and never asked who it belonged to, even though `POST /:name/decision` three
 * routes above them already did, with a comment saying why: the grant belongs to the Bot and says
 * nothing about who is asking on its behalf. The store underneath accepts either way — it keys its
 * exclusion row on `(component, agent)` alone — so before this gate the only thing between one
 * workspace's administrator and another workspace's coworker was the assumption that administrators
 * are trusted.
 *
 * A stub store is the point rather than a shortcut. The assertion that matters is that
 * `store.grant` was never reached: a real database would have written the row and answered the same
 * 404, and the test would pass on a route that refused *after* doing the damage.
 */
const grantee = "agent-in-workspace-a";
const component = "spreadsheet";
const calls: { grants: unknown[]; revokes: unknown[] } = {
  grants: [],
  revokes: [],
};

const store = {
  async grant(name: string, agentId: string) {
    calls.grants.push({ name, agentId });
  },
  async revoke(name: string, agentId: string, by: string) {
    calls.revokes.push({ name, agentId, by });
  },
  async listForAgent() {
    return [];
  },
} as unknown as ComponentStore;

/** The production shape: may this caller act as that Bot, per that Bot's own readable profile. */
const canUseBot: BotAccessCheck = async (actor, botId) =>
  actor.id === "admin-a" && botId === grantee;

function appFor(actorId: string) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actorId,
      email: `${actorId}@example.test`,
      role: "admin" as const,
    });
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createComponentRoutes(store, requireUser, undefined, canUseBot),
  );
  return app;
}

const call = (
  actorId: string,
  path: string,
  method: "POST" | "DELETE",
  body?: unknown,
) =>
  appFor(actorId).request(
    new Request(`http://openbot.test/${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
  );

test("the coworker's own workspace may grant and revoke", async () => {
  const granted = await call("admin-a", `${component}/grants`, "POST", {
    agentId: grantee,
  });
  expect(granted.status).toBe(200);
  expect(calls.grants).toEqual([{ name: component, agentId: grantee }]);

  const revoked = await call(
    "admin-a",
    `${component}/grants/${grantee}`,
    "DELETE",
  );
  expect(revoked.status).toBe(200);
  expect(calls.revokes).toHaveLength(1);
});

test("another workspace's administrator cannot grant onto that coworker", async () => {
  /*
   * 404 rather than 403, matching the read seam: a 403 here would confirm that the coworker id names
   * something real, which is the roster of another workspace handed out one request at a time.
   */
  const attempted = await call("admin-b", `${component}/grants`, "POST", {
    agentId: grantee,
  });
  expect(attempted.status).toBe(404);
  expect(((await attempted.json()) as { error: string }).error).toContain(
    "no such Bot",
  );

  // Nothing reached the store, which is what the stub is here to prove.
  expect(calls.grants).toHaveLength(1);
});

test("another workspace's administrator cannot withhold a component from that coworker", async () => {
  const attempted = await call(
    "admin-b",
    `${component}/grants/${grantee}`,
    "DELETE",
  );
  expect(attempted.status).toBe(404);
  expect(calls.revokes).toHaveLength(1);
});
