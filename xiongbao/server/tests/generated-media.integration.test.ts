import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { generatedMedia } from "../src/db/schema";
import { createMediaRoutes } from "../src/media/routes";
import { createMediaStore } from "../src/media/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 员工生成的图片和视频存在 `generated_media`（迁移 0230），在 `GET /api/media/:id` 给生成时那一轮的人看。
 * 真的库、真的 store、真的路由：本人读得到、别人读不到（行级安全，404 和不存在一样）、按字节范围给视频、
 * 只存图片和视频类型。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createMediaStore(database);
const suite = randomUUID().slice(0, 8);
const owner = `media-${suite}-owner`;
const stranger = `media-${suite}-stranger`;

/** `requireUser` as the server mounts it: the actor set, and the request run in their own frame. */
const signedInAs =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", { id, email: `${id}@xiongbao.test`, role: "user" });
    await runAsTenant(id, () => next());
  };
const get = (as: string, path: string, headers: Record<string, string> = {}) =>
  createMediaRoutes(store, signedInAs(as)).request(
    new Request(`http://xiongbao.test${path}`, { headers }),
  );

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypmp42"),
  Buffer.alloc(100, 7),
]);

const save = (
  tenant: string,
  kind: "image" | "video",
  mimeType: string,
  bytes: Uint8Array,
) =>
  runAsTenant(tenant, () =>
    store.save({
      agentId: `bot-${suite}`,
      kind,
      mimeType,
      bytes,
      prompt: "熊宝在月球上",
      provider: "openai-compatible",
      model: "image-model-1",
    }),
  );

afterAll(async () => {
  await runAsTenant("platform", () =>
    database
      .delete(generatedMedia)
      .where(sql`${generatedMedia.tenantId} IN (${owner}, ${stranger})`),
  );
  await database.$client.end();
});

describe("generated_media", () => {
  test("the person it was made for reads it back; anybody else is told it is not there", async () => {
    const id = await save(owner, "image", "image/png", PNG);
    const mine = await runAsTenant(owner, () => store.read(id));
    expect(mine?.mimeType).toBe("image/png");
    expect(Buffer.from(mine?.bytes ?? []).equals(PNG)).toBe(true);
    expect(await runAsTenant(stranger, () => store.read(id))).toBeNull();
    expect(await runAsTenant(owner, () => store.read("not-a-uuid"))).toBeNull();
  });

  test("the route serves it in place, typed, sandboxed, and only to its person", async () => {
    const id = await save(owner, "image", "image/png", PNG);
    const response = await get(owner, `/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);

    const refused = await get(stranger, `/${id}`);
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { error: string }).error).toContain(
      "没有这个文件",
    );
    expect((await get(owner, `/${randomUUID()}`)).status).toBe(404);
  });

  test("a video is served in byte ranges, so a browser can seek it", async () => {
    const id = await save(owner, "video", "video/mp4", MP4);
    const part = await get(owner, `/${id}`, { range: "bytes=0-9" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(
      `bytes 0-9/${MP4.byteLength}`,
    );
    expect(
      Buffer.from(await part.arrayBuffer()).equals(MP4.subarray(0, 10)),
    ).toBe(true);
    const tail = await get(owner, `/${id}`, { range: "bytes=-4" });
    expect(Buffer.from(await tail.arrayBuffer()).equals(MP4.subarray(-4))).toBe(
      true,
    );
    const past = await get(owner, `/${id}`, {
      range: `bytes=${MP4.byteLength}-`,
    });
    expect(past.status).toBe(416);
  });

  test("only picture and video types are kept, and the size column is the bytes' own", async () => {
    await expect(
      save(owner, "image", "text/html", Buffer.from("<script>1</script>")),
    ).rejects.toThrow();
    await expect(
      runAsTenant(owner, async () => {
        await database.insert(generatedMedia).values({
          agentId: `bot-${suite}`,
          kind: "image",
          mimeType: "image/png",
          sizeBytes: 1,
          bytes: PNG,
          prompt: "x",
          provider: "p",
          model: "m",
        });
      }),
    ).rejects.toThrow();
  });

  test("row security is forced on the table", async () => {
    const [row] = await runAsTenant("platform", () =>
      database.execute<{ forced: boolean; enabled: boolean }>(
        sql`select relforcerowsecurity as forced, relrowsecurity as enabled from pg_class where relname = 'generated_media'`,
      ),
    );
    expect(row).toEqual({ forced: true, enabled: true });
  });
});
