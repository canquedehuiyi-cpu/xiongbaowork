import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { createEnterpriseAdminRoutes } from "../src/admin/routes";
import type { AppVariables } from "../src/auth/guards";

/**
 * `/api/admin/enterprise` answers one read to every signed-in person, `GET /me`, and nothing else.
 *
 * The administrator check used to let through every path that merely ended in `/me`. `PUT /settings/me`
 * and `DELETE /network/me` therefore reached their handlers for a member, and only the handlers' own
 * parameter checks stopped them. Any later write route whose last segment is a parameter would have been
 * open to members the day it was added. So the paths that end in `me` without being `/me` are held to the
 * administrator check here, and `/me` itself still answers a member.
 *
 * No enterprise controls are installed, so a request that gets past the check answers 503: a 403 here
 * can only come from the check.
 */
const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  const id = context.req.header("x-actor") ?? "member";
  context.set("actor", {
    id,
    email: `${id}@example.test`,
    role: context.req.header("x-role") ?? "user",
  } as never);
  await next();
};
const app = new Hono().route(
  "/api/admin/enterprise",
  createEnterpriseAdminRoutes(session),
);
const ask = (method: string, path: string, role = "user") =>
  app.request(`/api/admin/enterprise${path}`, {
    method,
    headers: { "content-type": "application/json", "x-role": role },
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: JSON.stringify({ value: true }) }),
  });

const ENDS_IN_ME: [string, string][] = [
  ["PUT", "/settings/me"],
  ["DELETE", "/network/me"],
  ["PUT", "/settings/name"],
  ["POST", "/people/me/terminate-computers"],
];

describe("the one read a member may make", () => {
  test("GET /me answers a member with their capabilities", async () => {
    const response = await ask("GET", "/me");
    expect(response.status).toBe(200);
    expect(
      Object.keys((await response.json()) as Record<string, unknown>).sort(),
    ).toEqual(["capabilities", "enforced"]);
  });

  test("GET /me with a query string, or as HEAD, answers a member the same way", async () => {
    expect((await ask("GET", "/me?x=1")).status).toBe(200);
    expect((await ask("HEAD", "/me")).status).toBe(200);
  });
});

describe("a path with me in it that is not /me", () => {
  for (const [method, path] of ENDS_IN_ME)
    test(`${method} ${path} refuses a member at the administrator check`, async () => {
      const response = await ask(method, path);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "Only an admin can do this.",
      });
    });

  for (const [method, path] of ENDS_IN_ME)
    test(`${method} ${path} still lets an administrator through to the route`, async () => {
      expect((await ask(method, path, "admin")).status).toBe(503);
    });
});
