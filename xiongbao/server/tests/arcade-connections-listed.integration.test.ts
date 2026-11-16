import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { composioConnections, mcpServers } from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";

/*
 * 选用 Arcade 时，一个人已经连好的 Arcade 应用出现在他的连接列表里（`brokeredConnectionsFor`，`/connections`
 * 与记忆采集的授权都读它）。应用行在 `arcade://<Toolkit>`，所以按活动提供商的 scheme 找行，不是拼
 * `composio://`（Codex 对 #434 的意见：X5-3 上还是硬拼的，X5-4 已改成 `${brokered.scheme}`；这里钉住）。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8).replaceAll("-", "");
const DANA = `arcade-listed-dana-${suite}`;
const TOOLKIT = `ListedGmail${suite}`;
const APP = `arcade-${TOOLKIT}`;
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

beforeAll(async () => {
  await platform(() => seedPeople(database, [DANA]));
  await platform(() =>
    database.insert(mcpServers).values({
      id: APP,
      tenantId: "team",
      title: "Gmail",
      vendor: "Arcade",
      url: `arcade://${TOOLKIT}`,
      provenance: "arcade",
      authScheme: "OAUTH2",
    }),
  );
  await runAsTenant(DANA, () =>
    database.insert(composioConnections).values({
      toolkit: TOOLKIT,
      userId: DANA,
      verified: true,
      provider: "arcade",
    }),
  );
});

afterAll(async () => {
  await platform(async () => {
    await database
      .delete(composioConnections)
      .where(eq(composioConnections.toolkit, TOOLKIT));
    await database.delete(mcpServers).where(eq(mcpServers.id, APP));
  });
  await platform(() => removePeople(database, [DANA]));
  await database.$client.close();
});

describe("a person's Arcade connections", () => {
  test("are listed under the app's arcade:// row", async () => {
    const listed = await runAsTenant(DANA, () =>
      store.brokeredConnectionsFor(DANA),
    );
    expect(listed.map((row) => row.serverId)).toEqual([APP]);
  });
});
