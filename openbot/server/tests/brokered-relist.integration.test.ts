import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { mcpServers, mcpTools } from "../src/db/schema";
import type { ComposioBroker } from "../src/plugins/broker";
import {
  type ComposioActions,
  useComposioClient,
} from "../src/plugins/composio";
import { createPluginStore, LISTING_REVISION } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 升级之后，broker（Composio）的每个应用重新列一次工具（上游 #1185）。
 *
 * #1177（fork 的迁移 0146）开始把 Composio 什么标签都没给的动作记为 `unclassified`，之前记的是
 * 普通写操作（不是 destructive、不是 unclassified）。从旧版升级上来的部署留着那些行：后台只读路径
 * 对 `unclassified` 敬而远之，对这些旧行却照常放行，和全新安装不一致。存下来的行分不清「Composio
 * 标了 create/update」和「什么都没标」，所以不能在迁移里改写，只能重新问一次。
 *
 * `mcp_servers.listing_revision` 记下这些工具是按哪一版的读法存的；落后的应用在启动时重新列一次，
 * 列成功才写上当前版本，所以失败的会被重试，成功的不会再问第二次。只有部署配置了 Composio 时才做。
 * 按准确的行 id 刷新；同一个应用、同一个版本连续失败 3 次，本进程里就不再重试。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);

const OK_APP = `relist_ok_${suite}`;
const DOWN_APP = `relist_down_${suite}`;
const SHADOWED_APP = `relist_shadowed_${suite}`;
const OK_ROW = `relist-${suite}-ok`;
const DOWN_ROW = `relist-${suite}-down`;
/** url 里没有应用：`refreshTools` 不写 `lastError`，直接抛 `PluginInvariantError`。 */
const BROKEN_ROW = `relist-${suite}-broken`;
/**
 * legacy `system` 行，id 恰好是另一行（`DECOY_ROW`）的 catalogue_key。经「id 或 catalogue_key、
 * team 行优先」重新查找时会落到 `DECOY_ROW` 上。
 */
const SHADOWED_ROW = `relist-${suite}-shadowed`;
const DECOY_ROW = `team:relist-${suite}-shadowed`;
/** 不是 broker 的应用：它的清单要用某个人或部署的凭据去问，启动时不碰。 */
const OTHER_ROW = `relist-${suite}-other`;
const ROWS = [OK_ROW, DOWN_ROW, BROKEN_ROW, SHADOWED_ROW, DECOY_ROW, OTHER_ROW];
const BROKEN_SECRET_WORDS = "no app in its url";

/** 什么标签都没有的动作：旧版记为普通写操作，这一版记为 unclassified。 */
const UNLABELLED = {
  slug: `${OK_APP.toUpperCase()}_DO_SOMETHING`,
  description: "Does something nobody labelled.",
  inputParameters: { type: "object", properties: {} },
  tags: ["important"],
  version: "20261101_00",
};
const READ = {
  slug: `${OK_APP.toUpperCase()}_FETCH`,
  description: "Fetches.",
  inputParameters: { type: "object", properties: {} },
  tags: ["readOnlyHint"],
  version: "20261101_00",
};

/** 每次向 Composio 要了哪个应用的清单。 */
const asked: string[] = [];
const actions: ComposioActions = {
  listActions: async (toolkit) => {
    asked.push(toolkit);
    if (toolkit === OK_APP) return [UNLABELLED, READ];
    if (toolkit === SHADOWED_APP) return [{ ...READ, slug: "SHADOWED_FETCH" }];
    throw new Error("Composio could not be reached");
  },
  execute: async () => {
    throw new Error("not called here");
  },
};

const storeWith = (broker: ComposioBroker | undefined) =>
  createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: { readSecret: async () => null },
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
  });
// 只看它在不在：重新列工具不经过 broker 的任何方法，清单走的是 Composio transport。
const store = storeWith({} as ComposioBroker);
const relist = () => asPlatform(() => store.relistOutdatedBrokeredApps());

const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

/** 这个文件里每条 console.warn，每个用例结束后恢复原来的 console.warn。 */
const warned: string[] = [];
const realWarn = console.warn;
const logged = (type: string, serverId: string) =>
  warned
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((line) => line?.type === type && line.serverId === serverId);

async function rowOf(id: string) {
  const [row] = await asPlatform(() =>
    database
      .select({
        revision: mcpServers.listingRevision,
        lastError: mcpServers.lastError,
      })
      .from(mcpServers)
      .where(inArray(mcpServers.id, [id])),
  );
  return row;
}

async function toolsOf(id: string) {
  const rows = await asPlatform(() =>
    database
      .select({
        name: mcpTools.name,
        effect: mcpTools.effect,
        destructive: mcpTools.destructive,
        unclassified: mcpTools.unclassified,
      })
      .from(mcpTools)
      .where(inArray(mcpTools.serverId, [id])),
  );
  return Object.fromEntries(rows.map(({ name, ...rest }) => [name, rest]));
}

const composioRow = (tenantId: string, id: string, url: string) => ({
  tenantId,
  id,
  title: id,
  vendor: "Composio",
  url,
  provenance: "composio",
});

beforeAll(async () => {
  useComposioClient(actions);
  await asPlatform(async () => {
    await database.insert(mcpServers).values([
      composioRow("team", OK_ROW, `composio://${OK_APP}`),
      composioRow("team", DOWN_ROW, `composio://${DOWN_APP}`),
      composioRow("team", BROKEN_ROW, "composio://"),
      composioRow("system", SHADOWED_ROW, `composio://${SHADOWED_APP}`),
      {
        tenantId: "team",
        id: DECOY_ROW,
        catalogueKey: SHADOWED_ROW,
        title: "Somebody's MCP server",
        vendor: "Example",
        url: "https://mcp.relist-decoy.example.test/mcp",
        provenance: "custom",
      },
      {
        tenantId: "team",
        id: OTHER_ROW,
        title: "Somebody's MCP server",
        vendor: "Example",
        url: "https://mcp.relist.example.test/mcp",
        provenance: "custom",
      },
    ]);
    // 旧版存下的：没有标签的动作记成普通写操作。
    await database.insert(mcpTools).values([
      {
        tenantId: "team",
        serverId: OK_ROW,
        name: UNLABELLED.slug,
        description: UNLABELLED.description,
        inputSchema: UNLABELLED.inputParameters,
        effect: "write",
        destructive: false,
        version: UNLABELLED.version,
      },
      {
        tenantId: "team",
        serverId: DOWN_ROW,
        name: `${DOWN_APP.toUpperCase()}_SEND`,
        description: "Sends.",
        inputSchema: { type: "object", properties: {} },
        effect: "write",
        destructive: false,
        version: "20261101_00",
      },
    ]);
  });
});

beforeEach(() => {
  console.warn = (...args: unknown[]) => {
    warned.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.warn = realWarn;
  asked.length = 0;
});

afterAll(async () => {
  useComposioClient(null);
  await asPlatform(async () => {
    await database.delete(mcpTools).where(inArray(mcpTools.serverId, ROWS));
    await database.delete(mcpServers).where(inArray(mcpServers.id, ROWS));
  });
  await database.$client.close();
});

describe("listing each broker app again once after an upgrade", () => {
  test("rows stored before the column existed are behind", async () => {
    expect(LISTING_REVISION).toBeGreaterThan(0);
    expect((await rowOf(OK_ROW))?.revision).toBe(0);
    expect((await rowOf(OTHER_ROW))?.revision).toBe(0);
  });

  test("an app that answers is recorded as a fresh install would, and is caught up", async () => {
    const behind = await relist();

    expect([...behind].sort()).toEqual([BROKEN_ROW, DOWN_ROW].sort());
    expect(await toolsOf(OK_ROW)).toEqual({
      [UNLABELLED.slug]: {
        effect: "write",
        destructive: false,
        unclassified: true,
      },
      [READ.slug]: { effect: "read", destructive: false, unclassified: false },
    });
    expect((await rowOf(OK_ROW))?.revision).toBe(LISTING_REVISION);
  });

  test("the row walked is the row refreshed, even where its id is another row's catalogue key", async () => {
    expect((await rowOf(SHADOWED_ROW))?.revision).toBe(LISTING_REVISION);
    expect(Object.keys(await toolsOf(SHADOWED_ROW))).toEqual([
      "SHADOWED_FETCH",
    ]);
    expect(await rowOf(DECOY_ROW)).toEqual({ revision: 0, lastError: null });
  });

  test("an app that could not be reached keeps what it had and stays behind", async () => {
    const down = await rowOf(DOWN_ROW);
    expect(down?.revision).toBe(0);
    expect(down?.lastError).toBeTruthy();
    expect(Object.keys(await toolsOf(DOWN_ROW))).toEqual([
      `${DOWN_APP.toUpperCase()}_SEND`,
    ]);
  });

  test("a failure refreshTools raises is logged by its name, never its words", () => {
    const lines = logged("brokered-app-relist-failed", BROKEN_ROW);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.error).toBe("PluginInvariantError");
    expect(warned.join("\n")).not.toContain(BROKEN_SECRET_WORDS);
  });

  test("an app that is not the broker's is left alone", async () => {
    expect(await rowOf(OTHER_ROW)).toEqual({ revision: 0, lastError: null });
    expect(await toolsOf(OTHER_ROW)).toEqual({});
  });

  test("the next attempt asks only the app still behind", async () => {
    const behind = await relist();

    expect(asked).toEqual([DOWN_APP]);
    expect([...behind].sort()).toEqual([BROKEN_ROW, DOWN_ROW].sort());
  });

  test("after three failures at the same revision, an app is given up on for this process, said once", async () => {
    const before = warned.length;
    const behind = await relist();

    expect(asked).toEqual([DOWN_APP]);
    expect(behind).toEqual([]);
    for (const id of [DOWN_ROW, BROKEN_ROW])
      expect(logged("brokered-app-relist-given-up", id)).toHaveLength(1);

    const again = await relist();
    expect(again).toEqual([]);
    expect(asked).toEqual([DOWN_APP]);
    expect(warned.length).toBe(before + 3);
    for (const id of [DOWN_ROW, BROKEN_ROW])
      expect(logged("brokered-app-relist-given-up", id)).toHaveLength(1);
    expect(logged("brokered-app-relist-failed", BROKEN_ROW)).toHaveLength(3);
  });

  test("a deployment with no Composio configured asks nothing", async () => {
    const behind = await asPlatform(() =>
      storeWith(undefined).relistOutdatedBrokeredApps(),
    );

    expect(behind).toEqual([]);
    expect(asked).toEqual([]);
  });
});
