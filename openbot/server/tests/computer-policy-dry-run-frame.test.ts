import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditReader } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import type { AppVariables } from "../src/auth/guards";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";
import { currentTenant, runAsTenant } from "../src/tenant/context";

/**
 * G01-E P7: the policy dry-run replays the deployment's whole trail, so it reads as `platform`, and
 * only for an administrator who still holds the role when the request arrives (the capability the
 * `adminCapability` middleware grants after re-reading `user_roles`). An admin demoted since sign-in
 * gets a 403 before anything is read. Without an admin scope (a router built on its own) the read
 * stays in the caller's own frame.
 */

const ADMIN = { id: "u-admin", email: "admin@openbot.test", role: "admin" } as const;
const POLICY = { mode: "enforce", deny: [], allow: [] };

function app(options: { roles?: string[]; scoped: boolean }) {
  const frames: string[] = [];
  // As the real guard does: the signed-in person, in their own frame.
  const asActor: MiddlewareHandler<{ Variables: AppVariables }> = (
    context,
    next,
  ) => {
    context.set("actor", { ...ADMIN });
    return runAsTenant(ADMIN.id, () => next());
  };
  const auditReader = {
    list: async () => {
      frames.push(currentTenant());
      return { events: [], nextCursor: undefined };
    },
  } as unknown as AuditReader;
  const adminScope = options.scoped
    ? createAdminScope({
        roleRepository: {
          rolesForUser: async () => options.roles ?? [],
        } as never,
      })
    : undefined;
  const routes = createComputerRoutes(
    {} as never,
    {} as PolicyStore,
    asActor,
    async () => false,
    undefined,
    auditReader,
    adminScope,
  );
  const server = new Hono<{ Variables: AppVariables }>().route(
    "/api/computers",
    routes,
  );
  const dryRun = () =>
    server.request("http://t/api/computers/policy-dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: POLICY }),
    });
  return { dryRun, frames };
}

describe("POST /api/computers/policy-dry-run frame", () => {
  test("an administrator who holds the role replays the trail as platform", async () => {
    const { dryRun, frames } = app({ roles: ["admin"], scoped: true });
    const response = await dryRun();
    expect(response.status).toBe(200);
    expect(frames).toEqual(["platform"]);
  });

  test("an administrator demoted since sign-in is refused before anything is read", async () => {
    const { dryRun, frames } = app({ roles: ["user"], scoped: true });
    const response = await dryRun();
    expect(response.status).toBe(403);
    expect(frames).toEqual([]);
  });

  test("a router built without an admin scope reads in the caller's own frame", async () => {
    const { dryRun, frames } = app({ scoped: false });
    const response = await dryRun();
    expect(response.status).toBe(200);
    expect(frames).toEqual([ADMIN.id]);
  });
});
