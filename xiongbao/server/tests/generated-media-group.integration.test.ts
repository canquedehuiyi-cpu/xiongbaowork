import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  channelMemberships,
  channels,
  generatedMedia,
  groupBotThreads,
  users,
} from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { createMediaRoutes } from "../src/media/routes";
import { createMediaStore, mediaChannelOf } from "../src/media/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 群聊里员工生成的图片和视频，群里现在还在的人都读得到（行级安全按频道成员判断，和群里其它行同一个
 * 函数）；退群后读不到；单聊生成的只有本人；别的租户读不到。真的库、真的 store、真的路由。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createMediaStore(database);
const suite = randomUUID().slice(0, 8);
const maker = `mediag-${suite}-maker`;
const member = `mediag-${suite}-member`;
const leaver = `mediag-${suite}-leaver`;
const outsider = `mediag-${suite}-outsider`;
const people = [maker, member, leaver, outsider];
const groupId = `mediag-${suite}-group`;
const privateGroupId = `mediag-${suite}-private-group`;
const botId = `bot-${suite}`;
const threadId = `thread-${suite}`;

const signedInAs =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", { id, email: `${id}@openbot.test`, role: "user" });
    await runAsTenant(id, () => next());
  };
const get = (as: string, id: string) =>
  createMediaRoutes(store, signedInAs(as)).request(
    new Request(`http://openbot.test/${id}`),
  );

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const saveAs = (
  tenant: string,
  channelId?: string,
  kind: "image" | "video" = "image",
) =>
  runAsTenant(tenant, () =>
    store.save({
      agentId: botId,
      kind,
      mimeType: kind === "image" ? "image/png" : "video/mp4",
      bytes:
        kind === "image"
          ? PNG
          : Buffer.concat([
              Buffer.from([0, 0, 0, 0x18]),
              Buffer.from("ftypmp42"),
            ]),
      prompt: "群里的熊宝",
      provider: "openai-compatible",
      model: "image-model-1",
      ...(channelId ? { channelId } : {}),
    }),
  );

beforeAll(async () => {
  for (const id of people)
    await runAsTenant(id, () =>
      database
        .insert(users)
        .values({ id, email: `${id}@example.test`, name: "media group" }),
    );
  await runAsTenant("platform", async () => {
    // A shared group (`team`), three people in it; and one stamped to the maker alone (not shared).
    await database.insert(channels).values([
      {
        id: groupId,
        name: "群",
        description: "media group fixture",
        tenantId: TEAM_TENANT,
      },
      {
        id: privateGroupId,
        name: "自己的群",
        description: "media group fixture",
        tenantId: maker,
      },
    ]);
    await database.insert(channelMemberships).values([
      ...[maker, member, leaver].map((userId) => ({
        channelId: groupId,
        userId,
        tenantId: TEAM_TENANT,
      })),
      { channelId: privateGroupId, userId: maker, tenantId: maker },
    ]);
    await database.insert(groupBotThreads).values([
      {
        ownerUserId: maker,
        tenantId: TEAM_TENANT,
        channelId: groupId,
        agentId: botId,
        threadId,
      },
      {
        ownerUserId: maker,
        tenantId: maker,
        channelId: privateGroupId,
        agentId: botId,
        threadId: `${threadId}-private`,
      },
    ]);
  });
});

afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database
      .delete(generatedMedia)
      .where(inArray(generatedMedia.tenantId, people));
    await database
      .delete(channels)
      .where(inArray(channels.id, [groupId, privateGroupId]));
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.end();
});

describe("media made in a group chat", () => {
  test("every member still in the group reads it, in their own frame; a person who is not in it gets 404", async () => {
    const id = await saveAs(maker, groupId);
    for (const reader of [maker, member, leaver]) {
      const response = await get(reader, id);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
    }
    expect((await get(outsider, id)).status).toBe(404);
    expect(await runAsTenant(outsider, () => store.read(id))).toBeNull();
  });

  test("a video made in the group is read the same way", async () => {
    const id = await saveAs(maker, groupId, "video");
    expect((await get(member, id)).status).toBe(200);
    expect((await get(outsider, id)).status).toBe(404);
  });

  test("once somebody leaves the group they can no longer read it, the person who made it included", async () => {
    const id = await saveAs(maker, groupId);
    expect((await get(leaver, id)).status).toBe(200);
    await runAsTenant(leaver, () =>
      database
        .delete(channelMemberships)
        .where(eq(channelMemberships.userId, leaver)),
    );
    expect((await get(leaver, id)).status).toBe(404);
    expect((await get(member, id)).status).toBe(200);

    await runAsTenant(maker, () =>
      database
        .delete(channelMemberships)
        .where(eq(channelMemberships.userId, maker)),
    );
    expect((await get(maker, id)).status).toBe(404);
    expect((await get(member, id)).status).toBe(200);
    // Restored for the tests that follow.
    await runAsTenant("platform", () =>
      database.insert(channelMemberships).values(
        [maker, leaver].map((userId) => ({
          channelId: groupId,
          userId,
          tenantId: TEAM_TENANT,
        })),
      ),
    );
  });

  test("a picture made in a one-to-one chat (no channel) is read by that person alone", async () => {
    const id = await saveAs(maker);
    expect((await get(maker, id)).status).toBe(200);
    for (const other of [member, leaver, outsider])
      expect((await get(other, id)).status).toBe(404);
  });

  test("another tenant is turned away from a group's media, and cannot file media into a group it is not in", async () => {
    const id = await saveAs(maker, groupId);
    expect((await get(outsider, id)).status).toBe(404);
    await expect(saveAs(outsider, groupId)).rejects.toThrow();
  });

  test("the platform frame still reads everything", async () => {
    const id = await saveAs(maker, groupId);
    expect(await runAsTenant("platform", () => store.read(id))).not.toBeNull();
  });
});

describe("which group a turn is in", () => {
  test("a shared group's Bot thread names its channel, for the person whose turn it is", async () => {
    const lookup = mediaChannelOf(database);
    expect(await runAsTenant(maker, () => lookup(maker, botId, threadId))).toBe(
      groupId,
    );
  });

  test("an unknown thread, another Bot, another person, or a group that is not shared names nothing", async () => {
    const lookup = mediaChannelOf(database);
    expect(
      await runAsTenant(maker, () => lookup(maker, botId, "no-such-thread")),
    ).toBeNull();
    expect(
      await runAsTenant(maker, () => lookup(maker, "other-bot", threadId)),
    ).toBeNull();
    expect(
      await runAsTenant(member, () => lookup(member, botId, threadId)),
    ).toBeNull();
    expect(
      await runAsTenant(maker, () =>
        lookup(maker, botId, `${threadId}-private`),
      ),
    ).toBeNull();
  });

  test("a person who has left the group no longer gets its channel", async () => {
    const lookup = mediaChannelOf(database);
    await runAsTenant(maker, () =>
      database
        .delete(channelMemberships)
        .where(eq(channelMemberships.userId, maker)),
    );
    expect(
      await runAsTenant(maker, () => lookup(maker, botId, threadId)),
    ).toBeNull();
  });
});
