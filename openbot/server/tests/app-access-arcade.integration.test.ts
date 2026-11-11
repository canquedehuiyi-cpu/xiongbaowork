import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, mcpServers } from "../src/db/schema";
import { requestPlanFor } from "../src/plugins/app-access-store";
import type { BrokerApp } from "../src/plugins/broker";
import { createPluginStore } from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";

/**
 * 应用访问在 Arcade 部署下按 Arcade 认应用（X2 × X5）。
 *
 * X2 的应用访问只认 Composio：还没有行的应用按 `composio-<slug>` 起名、用 Composio 的 slug 规则校验，
 * 所以选用 Arcade 时，broker 目录里的应用（`Dropbox`，大小写保留）从对话卡片申请打开会被答成「没有这个
 * 应用」；已经打开的 Arcade 应用行（`arcade://<Toolkit>`）也读不出是哪个应用，被当成按地址添加的服务器。
 * 现在按活动的提供商起名与校验，已有的行按它自己的提供商读。Composio 部署不变（见
 * `app-access-upstream.integration.test.ts`）。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8).replaceAll("-", "");
const PERSON = `aaa-person-${suite}`;
const BOT = `aaa-bot-${suite}`;
const DROPBOX = `Dropbox${suite}`;
const GMAIL = `Gmail${suite}`;
const GMAIL_ROW = `arcade-${GMAIL}`;

const directory: BrokerApp[] = [
  {
    slug: DROPBOX,
    name: `Dropbox ${suite}`,
    description: "Files",
    logo: null,
    categories: [],
    actionCount: 1,
    connection: { kind: "consent" },
  },
];

const arcadeStore = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

const inspect = (app: string) =>
  runAsTenant(PERSON, () =>
    arcadeStore.inspectApp({
      app,
      agentId: BOT,
      userId: PERSON,
      composioConfigured: true,
      directory: async () => directory,
    }),
  );

beforeAll(async () => {
  await asPlatform(async () => {
    await seedPeople(database, [PERSON]);
    await database.insert(agents).values({
      id: BOT,
      tenantId: PERSON,
      name: BOT,
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: BOT,
      tenantId: PERSON,
      ownerUserId: PERSON,
      title: BOT,
      roleDescription: "测试员工",
      avatarSeed: BOT,
      visibility: "private",
    });
    await database.insert(mcpServers).values({
      id: GMAIL_ROW,
      tenantId: "team",
      title: `Gmail ${suite}`,
      vendor: "Arcade",
      url: `arcade://${GMAIL}`,
      provenance: "arcade",
      authScheme: "OAUTH2",
      accountMode: "personal",
    });
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    await database.delete(agents).where(eq(agents.id, BOT));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [GMAIL_ROW]));
    await removePeople(database, [PERSON]);
  });
  await database.$client.close();
});

describe("an Arcade app nobody has opened yet", () => {
  test("is named from the directory, under the id opening it would mint, and can be asked for", async () => {
    for (const asked of [
      `Dropbox ${suite}`,
      `arcade-${DROPBOX}`,
      DROPBOX.toLowerCase(),
    ]) {
      const found = await inspect(asked);
      expect(found?.access).toMatchObject({
        key: `arcade-${DROPBOX}`,
        provider: "arcade",
        state: "disabled",
        unavailable: "absent",
        connect: "consent",
        requestKind: "enable",
      });
      expect(found?.toolkit).toBe(DROPBOX);
      expect(requestPlanFor(found ?? null)).toMatchObject({ kind: "enable" });
    }
  });

  test("an arcade- id the directory does not know is not something to ask for", async () => {
    const found = await inspect(`arcade-MadeUp${suite}`);
    expect(found?.vouched).toBe(false);
    expect(requestPlanFor(found ?? null)).toEqual({ refused: "no_such_app" });
  });

  test("a composio- id is not an app on an Arcade deployment", async () => {
    expect(await inspect(`composio-dropbox${suite}`)).toBeNull();
  });
});

describe("an Arcade app that is open", () => {
  test("is read as the broker's app it is, by its id, its name, or its toolkit in any case", async () => {
    for (const asked of [GMAIL_ROW, `Gmail ${suite}`, GMAIL.toLowerCase()]) {
      const found = await inspect(asked);
      expect(found?.access).toMatchObject({
        key: GMAIL_ROW,
        provider: "arcade",
        account: "personal",
        connect: "consent",
        unavailable: null,
      });
      expect(found?.toolkit).toBe(GMAIL);
    }
  });
});
