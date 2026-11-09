import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { mcpServers, mcpTools } from "../src/db/schema";
import { listTools as baiduListing } from "../src/plugins/baidu-netdisk-rest";
import { listTools as routinesListing } from "../src/plugins/builtin-routines";
import { listTools as driveListing } from "../src/plugins/google-drive-rest";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 每次启动，把 OpenBot 自带应用（工具清单就是本仓库代码的应用）保存的工具刷新到这一版（上游 #1130）。
 *
 * Routines、Google Drive 和百度网盘的工具就是代码本身，可部署里保存的是添加应用那一版的清单，过去
 * 只有管理员按「刷新工具」才会替换。所以某一版改了工具名或描述，已有部署永远收不到。
 *
 * fork 特有的约束也在这里验证：批量刷新跨所有租户，在平台帧里跑；每台服务器的工具按这台服务器自己
 * 的 tenant 盖戳。夹具用本套件自己的租户和行 id（`catalogue_key` 指向真实条目），不碰共享测试库里
 * 别人的 `team:routines` 之类的行。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenantA = `own-tools-a-${suite}`;
const tenantB = `own-tools-b-${suite}`;

const ROUTINES = `own-${suite}-routines`;
const DRIVE = `own-${suite}-drive`;
const BAIDU = `own-${suite}-baidu`;
/** 一台 vendor 的 MCP 应用：清单是 vendor 的答复，启动时不能去问。 */
const VENDOR_APP = `own-${suite}-context7`;
const ROWS = [ROUTINES, DRIVE, BAIDU, VENDOR_APP];

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

async function saved(serverId: string) {
  const rows = await asPlatform(() =>
    database
      .select({
        name: mcpTools.name,
        description: mcpTools.description,
        tenantId: mcpTools.tenantId,
      })
      .from(mcpTools)
      .where(inArray(mcpTools.serverId, [serverId])),
  );
  return rows;
}

const descriptions = (rows: { name: string; description: string }[]) =>
  Object.fromEntries(rows.map((row) => [row.name, row.description]));

async function refreshedAt(serverId: string) {
  const [row] = await asPlatform(() =>
    database
      .select({ at: mcpServers.toolsRefreshedAt })
      .from(mcpServers)
      .where(inArray(mcpServers.id, [serverId])),
  );
  return row?.at?.toISOString() ?? null;
}

beforeAll(async () => {
  await asPlatform(async () => {
    await database.insert(mcpServers).values([
      {
        tenantId: tenantA,
        id: ROUTINES,
        catalogueKey: "routines",
        title: "Routines",
        vendor: "OpenBot",
        url: "builtin://routines/",
        provenance: "first-party",
      },
      {
        tenantId: tenantA,
        id: DRIVE,
        catalogueKey: "google-drive",
        title: "Google Drive",
        vendor: "Google",
        url: "https://www.googleapis.com/drive/v3",
        provenance: "first-party",
      },
      {
        tenantId: tenantB,
        id: BAIDU,
        catalogueKey: "baidu-netdisk",
        title: "百度网盘",
        vendor: "百度",
        url: "https://pan.baidu.com/rest/2.0/xpan",
        provenance: "first-party",
      },
      {
        tenantId: tenantA,
        id: VENDOR_APP,
        catalogueKey: "context7",
        title: "Context7",
        vendor: "Upstash",
        url: "https://mcp.context7.com/mcp",
        provenance: "first-party",
      },
    ]);
    // 旧版保存的清单：Routines 有一条旧描述、一个已退役的工具，并且缺了其余的。
    await database.insert(mcpTools).values([
      {
        tenantId: tenantA,
        serverId: ROUTINES,
        name: "create_trigger",
        description: "An older build's words for create_trigger.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        tenantId: tenantA,
        serverId: ROUTINES,
        name: "retired_tool",
        description: "A tool an older build had.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        tenantId: tenantA,
        serverId: DRIVE,
        name: "search_files",
        description: "An older build's words for Drive search.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        tenantId: tenantA,
        serverId: VENDOR_APP,
        name: "resolve-library-id",
        description: "Whatever the vendor said when it was added.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    // 百度网盘一个工具也没存：添加它的那一版还没有这些工具。
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    await database.delete(mcpTools).where(inArray(mcpTools.serverId, ROWS));
    await database.delete(mcpServers).where(inArray(mcpServers.id, ROWS));
  });
  await database.$client.close();
});

describe("starting a newer build", () => {
  test("saves the tools Routines, Drive and 百度网盘 have in this build", async () => {
    const refreshed = await asPlatform(() => store.refreshOwnListings());

    expect(refreshed).toEqual(expect.arrayContaining([ROUTINES, DRIVE, BAIDU]));
    expect(descriptions(await saved(ROUTINES))).toEqual(
      descriptions(await routinesListing()),
    );
    expect(descriptions(await saved(DRIVE))).toEqual(
      descriptions(await driveListing({ url: "" })),
    );
    expect(descriptions(await saved(BAIDU))).toEqual(
      descriptions(await baiduListing({ url: "" })),
    );
  });

  test("stamps each server's tools with that server's own tenant", async () => {
    const stamps = async (serverId: string) => [
      ...new Set((await saved(serverId)).map((row) => row.tenantId)),
    ];
    expect(await stamps(ROUTINES)).toEqual([tenantA]);
    expect(await stamps(DRIVE)).toEqual([tenantA]);
    expect(await stamps(BAIDU)).toEqual([tenantB]);
  });

  test("leaves a vendor's app alone: its list is the vendor's answer, not this code", async () => {
    expect(descriptions(await saved(VENDOR_APP))).toEqual({
      "resolve-library-id": "Whatever the vendor said when it was added.",
    });
    expect(await refreshedAt(VENDOR_APP)).toBeNull();
  });

  test("writes nothing at a start where nothing changed", async () => {
    const before = await Promise.all([ROUTINES, DRIVE, BAIDU].map(refreshedAt));
    expect(before.every((at) => at !== null)).toBe(true);

    const refreshed = await asPlatform(() => store.refreshOwnListings());

    expect(refreshed).not.toContain(ROUTINES);
    expect(refreshed).not.toContain(DRIVE);
    expect(refreshed).not.toContain(BAIDU);
    expect(
      await Promise.all([ROUTINES, DRIVE, BAIDU].map(refreshedAt)),
    ).toEqual(before);
  });
});
