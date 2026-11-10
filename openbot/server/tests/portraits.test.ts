import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { portraits, users } from "../src/db/schema";
import { PORTRAIT_MAX_BYTES } from "../src/portraits/image";
import {
  type CoworkerFaceAccess,
  createPortraitRoutes,
} from "../src/portraits/routes";
import { createPortraitStore } from "../src/portraits/store";
import { runAsTenant } from "../src/tenant/context";
import { createWakerGroupStore } from "../src/waker-groups/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 头像 (migration 0144): a coworker or a group may be given one of 熊宝's expressions or an uploaded
 * picture, seen by whoever may see that coworker or group and changed by whoever may change it.
 *
 * The routes and the table are real and row security is enforced, because what matters is that one
 * workspace never sees or overwrites another's faces. Which coworkers a person may see or manage is
 * the coworker store's question; here it is answered by a stand-in, so these tests pin what the
 * routes do with the answer.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenantA = `pt-${suite}-a`;
const tenantB = `pt-${suite}-b`;
const store = createPortraitStore(database);
const groups = createWakerGroupStore(database);

const MINE = `coworker-${suite}-mine`;
const SHARED = `coworker-${suite}-shared`;
const PRIVATE_TO_SOMEONE_ELSE = `coworker-${suite}-private`;

const access: CoworkerFaceAccess = {
  visible: async () => new Set([MINE, SHARED]),
  canSee: async (_actor, id) => id === MINE || id === SHARED,
  canChange: async (_actor, id) => id === MINE,
};

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: `${suite}-tester`,
    email: `${suite}-tester@example.test`,
    name: "Tester",
    role: "user",
  });
  await next();
};
const routes = createPortraitRoutes(store, access, requireUser);

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function call(tenant: string, method: string, path: string, body?: unknown) {
  return runAsTenant(tenant, () =>
    routes.request(`http://openbot.test${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
  );
}

async function list(tenant: string) {
  const response = await call(tenant, "GET", "/");
  expect(response.status).toBe(200);
  return ((await response.json()) as { portraits: Record<string, unknown>[] })
    .portraits;
}

for (const tenant of [tenantA, tenantB]) {
  await runAsTenant(tenant, () =>
    database
      .insert(users)
      .values({ id: tenant, email: `${tenant}@example.test` })
      .onConflictDoNothing(),
  );
}
const groupOfA = await runAsTenant(tenantA, () =>
  groups.create({ name: `头像群组 ${suite}`, description: null }),
);

test("a coworker's manager gives it one of 熊宝's expressions, and the list says so", async () => {
  const response = await call(tenantA, "PUT", `/coworker/${MINE}`, {
    preset: "cute",
  });
  expect(response.status).toBe(200);
  const { portrait } = (await response.json()) as {
    portrait: { preset: string; imageUrl: string | null };
  };
  expect(portrait.preset).toBe("cute");
  expect(portrait.imageUrl).toBeNull();
  expect(
    (await list(tenantA)).find((entry) => entry.id === MINE),
  ).toMatchObject({ kind: "coworker", preset: "cute", imageUrl: null });
});

test("an uploaded picture is stored, listed by a versioned URL and served back byte for byte", async () => {
  const saved = await call(tenantA, "PUT", `/group/${groupOfA.id}`, {
    image: base64(PNG),
  });
  expect(saved.status).toBe(200);
  const entry = (await list(tenantA)).find((row) => row.id === groupOfA.id);
  expect(entry).toMatchObject({ kind: "group", preset: null });
  expect(String(entry?.imageUrl)).toMatch(
    new RegExp(`^/api/portraits/group/${groupOfA.id}/image\\?v=\\d+$`),
  );

  const image = await call(tenantA, "GET", `/group/${groupOfA.id}/image`);
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(image.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
});

test("only a raster picture, small enough, or a known expression is accepted", async () => {
  const svg = await call(tenantA, "PUT", `/coworker/${MINE}`, {
    image: base64(
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ),
  });
  expect(svg.status).toBe(415);

  const huge = new Uint8Array(PORTRAIT_MAX_BYTES + 1);
  huge.set(PNG);
  const tooBig = await call(tenantA, "PUT", `/coworker/${MINE}`, {
    image: base64(huge),
  });
  expect(tooBig.status).toBe(413);

  const unknown = await call(tenantA, "PUT", `/coworker/${MINE}`, {
    preset: "angry",
  });
  expect(unknown.status).toBe(400);

  const nothing = await call(tenantA, "PUT", `/coworker/${MINE}`, {});
  expect(nothing.status).toBe(400);

  // None of the refusals touched the face that was there.
  expect(
    (await list(tenantA)).find((entry) => entry.id === MINE),
  ).toMatchObject({ preset: "cute" });
});

test("a coworker one may see but not manage keeps its face; one one may not see is not there at all", async () => {
  const notMine = await call(tenantA, "PUT", `/coworker/${SHARED}`, {
    preset: "cool",
  });
  expect(notMine.status).toBe(403);
  const cleared = await call(tenantA, "DELETE", `/coworker/${SHARED}`);
  expect(cleared.status).toBe(403);

  const unseen = await call(
    tenantA,
    "PUT",
    `/coworker/${PRIVATE_TO_SOMEONE_ELSE}`,
    {
      preset: "cool",
    },
  );
  expect(unseen.status).toBe(404);

  // Its owner set one; this person's list and image read do not reveal it.
  await runAsTenant(tenantA, () =>
    store.set(
      "coworker",
      PRIVATE_TO_SOMEONE_ELSE,
      { image: { contentType: "image/png", bytes: PNG } },
      "someone-else",
    ),
  );
  expect(
    (await list(tenantA)).some((entry) => entry.id === PRIVATE_TO_SOMEONE_ELSE),
  ).toBe(false);
  const image = await call(
    tenantA,
    "GET",
    `/coworker/${PRIVATE_TO_SOMEONE_ELSE}/image`,
  );
  expect(image.status).toBe(404);
});

test("another workspace neither sees nor changes this workspace's group faces", async () => {
  expect((await list(tenantB)).some((entry) => entry.id === groupOfA.id)).toBe(
    false,
  );
  expect(
    (await call(tenantB, "GET", `/group/${groupOfA.id}/image`)).status,
  ).toBe(404);
  expect(
    (await call(tenantB, "PUT", `/group/${groupOfA.id}`, { preset: "happy" }))
      .status,
  ).toBe(404);
  expect((await call(tenantB, "DELETE", `/group/${groupOfA.id}`)).status).toBe(
    404,
  );
  // And A's face is as A left it.
  expect(
    (await list(tenantA)).find((entry) => entry.id === groupOfA.id),
  ).toMatchObject({ preset: null });
});

test("a group that does not exist cannot be given a face", async () => {
  expect(
    (await call(tenantA, "PUT", `/group/${randomUUID()}`, { preset: "happy" }))
      .status,
  ).toBe(404);
  expect(
    (await call(tenantA, "PUT", "/group/not-a-uuid", { preset: "happy" }))
      .status,
  ).toBe(404);
  expect(
    (await call(tenantA, "PUT", `/robot/${MINE}`, { preset: "happy" })).status,
  ).toBe(404);
});

test("clearing a face goes back to the drawn one", async () => {
  const response = await call(tenantA, "DELETE", `/coworker/${MINE}`);
  expect(response.status).toBe(200);
  expect((await list(tenantA)).some((entry) => entry.id === MINE)).toBe(false);
});

test("the table itself refuses a portrait that is both, neither, or too large", async () => {
  const insert = (values: Record<string, unknown>) =>
    runAsTenant(tenantA, async () => {
      await database.insert(portraits).values({
        subjectKind: "coworker",
        subjectId: `${suite}-raw-${randomUUID()}`,
        ...values,
      });
    });
  await expect(insert({})).rejects.toThrow();
  await expect(
    insert({
      preset: "happy",
      contentType: "image/png",
      bytes: Buffer.from(PNG),
    }),
  ).rejects.toThrow();
  await expect(
    insert({
      contentType: "image/svg+xml",
      bytes: Buffer.from("<svg/>"),
    }),
  ).rejects.toThrow();
  await expect(
    insert({
      contentType: "image/png",
      bytes: Buffer.alloc(PORTRAIT_MAX_BYTES + 1),
    }),
  ).rejects.toThrow();
});

afterAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    await runAsTenant(tenant, async () => {
      await database.delete(portraits).where(eq(portraits.tenantId, tenant));
      if (tenant === tenantA) await groups.remove(groupOfA.id);
      await database.delete(users).where(eq(users.id, tenant));
    });
  }
  await database.$client.close();
});
