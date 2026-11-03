import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/app-variables";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, users } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec test decision #7's other half, and D15's sentence for coworkers: a foreign coworker answers
 * 404, never 403 and never 200.
 *
 * The order of these tests is the whole point. The first one reads the coworker back as its owner,
 * at the same seam the stranger is about to be refused at. Without that, a stranger's 404 proves
 * nothing — a broken join, a missing profile row, or a mis-set tenant scope all answer 404 to
 * everybody, and a file whose only assertions are about the stranger passes on all three.
 *
 * The coworker is built with `store.create`, not with a bare insert. A coworker is two rows
 * (`agents` plus `agent_profiles`) and the read joins them, so an `agents`-only fixture is
 * invisible to its own owner — which is exactly the shape of a vacuous green this file replaced.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createAgentProfileStore(database, undefined);
const suite = randomUUID().slice(0, 8);
const owner = `agent-tenant-${suite}-owner`;
const stranger = `agent-tenant-${suite}-stranger`;
/** Every coworker this file made, for the cleanup of the ones no person's frame can delete. */
const createdAgentIds: string[] = [];

/**
 * A coworker's owner is a person, and `agent_profiles.owner_user_id` is a foreign key onto `users`.
 * A foreign key is not stopped by row-level security, so a tenant id that names no user fails the
 * insert rather than leaking — but the fixture would fail first, and a failing fixture is how a
 * stranger's 404 ends up being asserted about a coworker that was never created.
 */
async function ensureUser(tenantId: string) {
  await runAsTenant(tenantId, () =>
    database
      .insert(users)
      .values({
        id: tenantId,
        email: `${tenantId}@example.test`,
        name: "Cross-tenant coworker fixture",
      })
      .onConflictDoNothing(),
  );
}

await Promise.all([ensureUser(owner), ensureUser(stranger)]);

const routesFor = (actorId: string) => {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: actorId, role: "user" as const });
    await next();
  };
  return createAgentRoutes(store, requireUser);
};

async function call(
  actorId: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
) {
  return runAsTenant(actorId, () =>
    routesFor(actorId).request(
      new Request(`http://openbot.test/${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      }),
    ),
  );
}

async function makeCoworker(visibility: "private" | "public") {
  const name = `Coworker ${suite} ${visibility}`;
  const created = await runAsTenant(owner, () =>
    store.create(
      { id: owner, role: "user" },
      {
        name,
        title: "Keeps the books",
        roleDescription: "Reconciles the ledger every morning.",
        visibility,
        systemPrompt: "Answer briefly.",
      },
    ),
  );
  createdAgentIds.push(created.id);
  return { id: created.id, name };
}

const edit = {
  name: "Renamed by a stranger",
  title: "Stranger title",
  roleDescription: "A stranger should not be able to write any of this.",
  visibility: "private" as const,
};

afterAll(async () => {
  // The agent rows go inside their own tenant's scope; RLS will not let a context-free caller delete them.
  await runAsTenant(owner, async () => {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.ownerUserId, owner));
    await database.delete(agents).where(eq(agents.tenantId, owner));
  });
  /*
   * A public coworker lives in `team` (G01-E P8b): the owner's frame above deletes neither its
   * `agents` row (only the owner's own tenant is deletable there) nor, once its owner is gone below,
   * anything at all. The deployment's cleanup, by id, so no ownerless public Bot outlives the run.
   */
  if (createdAgentIds.length > 0)
    await runAsTenant("platform", () =>
      database.delete(agents).where(inArray(agents.id, createdAgentIds)),
    );
  await runAsTenant(owner, () =>
    database.delete(users).where(eq(users.id, owner)),
  );
  await runAsTenant(stranger, () =>
    database.delete(users).where(eq(users.id, stranger)),
  );
});

let privateAgentId = "";
let privateAgentName = "";

test("the owning workspace reads its own coworker back at the REST seam", async () => {
  const coworker = await makeCoworker("private");
  privateAgentId = coworker.id;
  privateAgentName = coworker.name;

  const single = await call(owner, coworker.id);
  expect(single.status).toBe(200);
  const body = (await single.json()) as { agent: { name: string } };
  expect(body.agent.name).toBe(coworker.name);

  const list = await call(owner, "");
  expect(list.status).toBe(200);
  const listed = (await list.json()) as { agents: { id: string }[] };
  expect(listed.agents.map((entry) => entry.id)).toContain(coworker.id);
});

test("a stranger's read answers 404, and the coworker is absent from their list", async () => {
  const single = await call(stranger, privateAgentId);
  expect(single.status).toBe(404);

  const list = await call(stranger, "");
  const listed = (await list.json()) as { agents: { id: string }[] };
  expect(listed.agents.map((entry) => entry.id)).not.toContain(privateAgentId);
});

test("a stranger's edit, hide and delete are 404s rather than 403s or 200s", async () => {
  /*
   * Each of these three reaches the store through a different gate — `update` and `softDelete` take a
   * row lock and then require manageability, `setHidden` writes a per-user preference — so each needs
   * its own answer. A 403 would be the leak: it confirms the id names a real coworker, which is a
   * roster of another workspace's staff handed out one request at a time.
   */
  const patch = await call(stranger, privateAgentId, "PATCH", edit);
  expect(patch.status).toBe(404);

  const hide = await call(stranger, `${privateAgentId}/hide`, "POST");
  expect(hide.status).toBe(404);

  const remove = await call(stranger, privateAgentId, "DELETE");
  expect(remove.status).toBe(404);
});

test("nothing moved: the owner still reads the same coworker, unhidden and not deleted", async () => {
  const single = await call(owner, privateAgentId);
  expect(single.status).toBe(200);
  const body = (await single.json()) as {
    agent: { name: string; hidden: boolean };
  };
  expect(body.agent.name).toBe(privateAgentName);
  expect(body.agent.hidden).toBe(false);

  /*
   * The delete route is a soft delete, so the readable answer above would stay 200 even if the
   * stranger's request had stamped `deletedAt`: the read filters deleted rows away and would then
   * answer 404 to its own owner. Checking the column is what distinguishes "refused" from "refused,
   * and did the damage anyway".
   */
  const [profile] = await runAsTenant(owner, () =>
    database
      .select({ deletedAt: agentProfiles.deletedAt })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, privateAgentId))
      .limit(1),
  );
  expect(profile?.deletedAt).toBeNull();
});

test("a coworker public inside its own tenant is still invisible to a stranger", async () => {
  /*
   * `visibility: "public"` is the app layer admitting every signed-in person to a coworker — it is the
   * widest possible read grant this table offers. Cross-tenant invisibility is therefore not the
   * application's doing here: the row-level policy is what refuses, and this is the case that says so.
   * If the two layers were ever collapsed into one another, this is the test that would notice.
   *
   * Since G01-E P8b a public coworker made through the store is moved to the shared `team` tenant
   * (decision 2) and is meant to be seen by everybody; the next test pins that. This one keeps the
   * row-level claim by building the case the store no longer produces: a profile that SAYS public but
   * is still stamped with its owner's tenant. Row security must refuse it whatever the column says.
   */
  const coworker = await makeCoworker("private");
  await runAsTenant(owner, () =>
    database
      .update(agentProfiles)
      .set({ visibility: "public" })
      .where(eq(agentProfiles.agentId, coworker.id)),
  );
  const [stamped] = await runAsTenant(owner, () =>
    database
      .select({ tenantId: agentProfiles.tenantId, visibility: agentProfiles.visibility })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, coworker.id)),
  );
  expect(stamped).toEqual({ tenantId: owner, visibility: "public" });

  const ownRead = await call(owner, coworker.id);
  expect(ownRead.status).toBe(200);

  const strangerRead = await call(stranger, coworker.id);
  expect(strangerRead.status).toBe(404);

  const strangerList = await call(stranger, "");
  const listed = (await strangerList.json()) as { agents: { id: string }[] };
  expect(listed.agents.map((entry) => entry.id)).not.toContain(coworker.id);
});

test("a coworker made public through the store is shared with every person (team tenant)", async () => {
  // Decision 2: public rows live in the shared `team` tenant, which every person may read.
  const coworker = await makeCoworker("public");
  const [stamped] = await runAsTenant(owner, () =>
    database
      .select({ tenantId: agentProfiles.tenantId })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, coworker.id)),
  );
  expect(stamped?.tenantId).toBe("team");

  const strangerRead = await call(stranger, coworker.id);
  expect(strangerRead.status).toBe(200);
  const strangerList = await call(stranger, "");
  const listed = (await strangerList.json()) as { agents: { id: string }[] };
  expect(listed.agents.map((entry) => entry.id)).toContain(coworker.id);

  // Visible is not writable: the stranger still cannot edit or delete it.
  expect([403, 404]).toContain((await call(stranger, coworker.id, "PATCH", edit)).status);
  expect([403, 404]).toContain((await call(stranger, coworker.id, "DELETE")).status);
});
