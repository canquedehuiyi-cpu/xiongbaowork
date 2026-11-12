import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { portraitMedia, portraits, users } from "../src/db/schema";
import { PORTRAIT_MAX_BYTES } from "../src/portraits/image";
import {
  type CoworkerFaceAccess,
  createPortraitRoutes,
} from "../src/portraits/routes";
import { createPortraitStore } from "../src/portraits/store";
import {
  PORTRAIT_VIDEO_MAX_BYTES,
  sniffVideo,
} from "../src/portraits/video";
import { runAsTenant } from "../src/tenant/context";
import { createWakerGroupStore } from "../src/waker-groups/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 头像视频与服装口子 (migration 0203): a short MP4/WebM loop uploaded for a coworker or a group,
 * played over the face that `portraits` holds — and the outfit that face wears.
 *
 * The loop lives in its own table (`portrait_media`), never in `portraits.bytes`, because a 256 KiB
 * picture limit cannot hold a video. A video without a face has no poster to show in a list, so
 * uploading one first needs a face. The routes and the tables are real and row security is
 * enforced, because what matters is that one workspace never sees or overwrites another's faces.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenantA = `pm-${suite}-a`;
const tenantB = `pm-${suite}-b`;
const store = createPortraitStore(database);
const groups = createWakerGroupStore(database);

const MINE = `coworker-${suite}-mine`;

const access: CoworkerFaceAccess = {
  visible: async () => new Set([MINE]),
  canSee: async (_actor, id) => id === MINE,
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

const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
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
  groups.create({ name: `头像视频群组 ${suite}`, description: null }),
);

test("a video's type is read from its own bytes", () => {
  expect(sniffVideo(MP4)).toBe("video/mp4");
  expect(sniffVideo(WEBM)).toBe("video/webm");
  expect(sniffVideo(PNG)).toBeNull();
  expect(sniffVideo(new Uint8Array([0, 0, 0, 0]))).toBeNull();
  expect(sniffVideo(new Uint8Array([]))).toBeNull();
});

test("a video needs a face first, then it is stored and served byte for byte", async () => {
  const noFace = await call(tenantA, "PUT", `/group/${groupOfA.id}`, {
    video: base64(MP4),
  });
  expect(noFace.status).toBe(400);

  const faced = await call(tenantA, "PUT", `/group/${groupOfA.id}`, {
    preset: "happy",
  });
  expect(faced.status).toBe(200);

  const saved = await call(tenantA, "PUT", `/group/${groupOfA.id}`, {
    video: base64(MP4),
  });
  expect(saved.status).toBe(200);
  const { portrait } = (await saved.json()) as {
    portrait: { videoUrl: string | null };
  };
  expect(String(portrait.videoUrl)).toMatch(
    new RegExp(`^/api/portraits/group/${groupOfA.id}/video\\?v=\\d+$`),
  );

  const entry = (await list(tenantA)).find((row) => row.id === groupOfA.id);
  expect(entry).toMatchObject({ kind: "group", preset: "happy" });
  expect(String(entry?.videoUrl)).toMatch(/\/video\?v=\d+$/);

  const video = await call(tenantA, "GET", `/group/${groupOfA.id}/video`);
  expect(video.status).toBe(200);
  expect(video.headers.get("content-type")).toBe("video/mp4");
  expect(video.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await video.arrayBuffer())).toEqual(MP4);
});

test("only a short enough MP4 or WebM is accepted, and refusals change nothing", async () => {
  const picture = await call(tenantA, "PUT", `/coworker/${MINE}`, {
    video: base64(PNG),
  });
  expect(picture.status).toBe(415);

  const huge = new Uint8Array(PORTRAIT_VIDEO_MAX_BYTES + 1);
  huge.set(MP4);
  const tooBig = await call(tenantA, "PUT", `/coworker/${MINE}`, {
    video: base64(huge),
  });
  expect(tooBig.status).toBe(413);

  const empty = await call(tenantA, "PUT", `/coworker/${MINE}`, {
    video: base64(new Uint8Array([])),
  });
  expect(empty.status).toBe(400);

  // The group video from the previous test is still there.
  const entry = (await list(tenantA)).find((row) => row.id === groupOfA.id);
  expect(String(entry?.videoUrl)).toMatch(/\/video\?v=\d+$/);
});

test("clearing a video keeps its poster; clearing the face clears the video too", async () => {
  const cleared = await call(
    tenantA,
    "DELETE",
    `/group/${groupOfA.id}/video`,
  );
  expect(cleared.status).toBe(200);
  expect((await list(tenantA)).find((row) => row.id === groupOfA.id)).toMatchObject({
    preset: "happy",
    videoUrl: null,
  });
  expect(
    (await call(tenantA, "GET", `/group/${groupOfA.id}/video`)).status,
  ).toBe(404);

  const saved = await call(tenantA, "PUT", `/group/${groupOfA.id}`, {
    video: base64(WEBM),
  });
  expect(saved.status).toBe(200);
  expect(
    (await call(tenantA, "GET", `/group/${groupOfA.id}/video`)).status,
  ).toBe(200);

  const faceCleared = await call(tenantA, "DELETE", `/group/${groupOfA.id}`);
  expect(faceCleared.status).toBe(200);
  expect((await list(tenantA)).some((row) => row.id === groupOfA.id)).toBe(
    false,
  );
  expect(
    (await call(tenantA, "GET", `/group/${groupOfA.id}/video`)).status,
  ).toBe(404);
});

test("an outfit rides with a face, and only a known one", async () => {
  const dressed = await call(tenantA, "PUT", `/coworker/${MINE}`, {
    preset: "cool",
    outfit: "street",
  });
  expect(dressed.status).toBe(200);
  const { portrait } = (await dressed.json()) as {
    portrait: { outfit: string | null };
  };
  expect(portrait.outfit).toBe("street");
  expect(
    (await list(tenantA)).find((entry) => entry.id === MINE),
  ).toMatchObject({ preset: "cool", outfit: "street" });

  const unknown = await call(tenantA, "PUT", `/coworker/${MINE}`, {
    preset: "cool",
    outfit: "cape",
  });
  expect(unknown.status).toBe(400);

  const videoOutfit = await call(tenantA, "PUT", `/coworker/${MINE}`, {
    video: base64(MP4),
    outfit: "street",
  });
  expect(videoOutfit.status).toBe(400);

  // The refusals left the face as it was.
  expect(
    (await list(tenantA)).find((entry) => entry.id === MINE),
  ).toMatchObject({ preset: "cool", outfit: "street" });
});

test("another workspace neither sees nor changes this workspace's videos", async () => {
  await call(tenantA, "PUT", `/group/${groupOfA.id}`, { preset: "cute" });
  await call(tenantA, "PUT", `/group/${groupOfA.id}`, {
    video: base64(MP4),
  });
  expect(
    (await call(tenantB, "GET", `/group/${groupOfA.id}/video`)).status,
  ).toBe(404);
  expect(
    (
      await call(tenantB, "PUT", `/group/${groupOfA.id}`, {
        video: base64(WEBM),
      })
    ).status,
  ).toBe(404);
  expect(
    (await call(tenantB, "DELETE", `/group/${groupOfA.id}/video`)).status,
  ).toBe(404);
  // And A's video is as A left it.
  expect(
    (await call(tenantA, "GET", `/group/${groupOfA.id}/video`)).status,
  ).toBe(200);
});

test("the new table itself refuses a video that is not MP4/WebM or is too large", async () => {
  const insert = (values: { contentType: string; bytes: Buffer }) =>
    runAsTenant(tenantA, async () => {
      await database.insert(portraitMedia).values({
        subjectKind: "group",
        subjectId: groupOfA.id,
        ...values,
      });
    });
  await expect(
    insert({ contentType: "video/avi", bytes: Buffer.from(MP4) }),
  ).rejects.toThrow();
  await expect(
    insert({
      contentType: "video/mp4",
      bytes: Buffer.alloc(PORTRAIT_VIDEO_MAX_BYTES + 1),
    }),
  ).rejects.toThrow();

  const badOutfit = async () =>
    runAsTenant(tenantA, async () => {
      await database.insert(portraits).values({
        subjectKind: "coworker",
        subjectId: `${suite}-raw-${randomUUID()}`,
        preset: "happy",
        outfit: "cape",
      });
    });
  await expect(badOutfit()).rejects.toThrow();

  // A picture is still capped at the old limit: the video limit did not leak into it.
  await expect(
    runAsTenant(tenantA, async () => {
      await database.insert(portraits).values({
        subjectKind: "coworker",
        subjectId: `${suite}-raw-${randomUUID()}`,
        contentType: "image/png",
        bytes: Buffer.alloc(PORTRAIT_MAX_BYTES + 1),
      });
    }),
  ).rejects.toThrow();
});

afterAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    await runAsTenant(tenant, async () => {
      await database
        .delete(portraitMedia)
        .where(eq(portraitMedia.tenantId, tenant));
      await database.delete(portraits).where(eq(portraits.tenantId, tenant));
      if (tenant === tenantA) await groups.remove(groupOfA.id);
      await database.delete(users).where(eq(users.id, tenant));
    });
  }
  await database.$client.close();
});
