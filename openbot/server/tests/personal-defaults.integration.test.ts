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
import { MCPMock } from "@copilotkit/aimock/mcp";
import { and, eq, gte, inArray, like, or, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema/admin";
import { agents, auditEvents } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { learningSettings } from "../src/db/schema/learning";
import { mcpServers, pluginGrants, skills } from "../src/db/schema/plugins";
import { setEdition } from "../src/edition";
import {
  ALWAYS_ON_REFUSAL,
  DEFAULT_APPS_SETTING,
  EVERY_BOT_ASKS_REFUSAL,
  EVERY_BOT_REFUSAL,
  ensurePersonalDefaultApps,
  ensurePersonalLearning,
  ensurePersonalSkills,
  ensurePersonalSkillsOwned,
  personalDefaultAppsMemory,
  personalDefaultsDeps,
  skillsGivenSetting,
  startPersonalDefaultApps,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { createAdminRequest, seedAdministrator } from "./support/admin-request";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 个人版的默认，对着真的库、真的 store 和 fork 的租户帧（上游 `personal-default-apps`、`personal-skills`、
 * `personal-learning`、`personal-skill-owner` 四个集成测试，按 fork 的帧改写，并加上路由一侧的拒绝）。
 *
 * fork 的帧：个人版的那个人（这里是 OWNER，生产里是 `DEV_ACTOR`）是管理员；应用是 `team` 行，服务器级的事在
 * 平台帧里做，和 `index.ts` 一样；授予写在这个人自己的帧里，所以是他的行。Parallel 本身是一个本地 MCP 服务，
 * 在 search.parallel.ai 的地址上回答，或者离线时根本不答。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const OWNER = `pd-owner-${suite}`;
const ASSISTANT = `pd-assistant-${suite}`;
const LATER = `pd-later-${suite}`;
const PARALLEL = "parallel";
const SEARCH = ["parallel/web_fetch", "parallel/web_search"];
const STANDUP = `standup-${suite}`;
const TRIAGE = `triage-${suite}`;
const FRESH = `fresh-${suite}`;

const audit = createAuditStore(database);
const real = personalDefaultsDeps(database, OWNER);
/** 真的读，只是员工、技能、应用收窄到这个测试自己的，别人的什么都不给。 */
const deps = {
  ...real,
  bots: async () =>
    (await real.bots()).filter(
      (id) => id.startsWith("pd-") && id.endsWith(suite),
    ),
  skills: async () =>
    (await real.skills()).filter((slug) => slug.endsWith(suite)),
  servers: async () =>
    (await real.servers()).filter(
      (id) => id === PARALLEL || id === `team:${PARALLEL}`,
    ),
};
const store = withPersonalDefaults(
  createPluginStore({
    database,
    auditStore: audit,
    credentials: createCredentialStore(database),
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  }),
  deps,
);
const memory = personalDefaultAppsMemory(database);
/** `index.ts` 交给默认应用的那几个服务器级的方法：在平台帧里做。 */
const platformStore = {
  serverAddress: (id: string) => asPlatform(() => store.serverAddress(id)),
  addServer: (input: { key: string; by: string }) =>
    asPlatform(() => store.addServer(input)),
  refreshTools: (id: string) => asPlatform(() => store.refreshTools(id)),
};
/** 一次服务启动：`index.ts` 为默认应用跑的那一步。 */
const restart = () => ensurePersonalDefaultApps(platformStore, deps, memory);
const asOwner = <T>(work: () => Promise<T>) => runAsTenant(OWNER, work);
const adminRequest = createAdminRequest(database);
const asAdmin = <T>(work: () => Promise<T>) => adminRequest(OWNER, work);

const mock = new MCPMock();
let mockUrl = "";
let online = true;
const realFetch = globalThis.fetch;
let releaseAdmin: (() => Promise<void>) | undefined;

async function held(bot: string) {
  const { tools } = await asOwner(() => store.listForAgent(bot));
  return tools
    .map((tool) => tool.ref)
    .filter((ref) => ref.startsWith(`${PARALLEL}/`))
    .sort();
}

async function addBot(id: string) {
  await asPlatform(async () => {
    await database.insert(agents).values({
      id,
      tenantId: OWNER,
      name: id,
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      tenantId: OWNER,
      ownerUserId: OWNER,
      title: id,
      roleDescription: "测试员工",
      avatarSeed: id,
      visibility: "private",
    });
  });
}

async function forgetParallel() {
  await asPlatform(async () => {
    await database
      .delete(pluginGrants)
      .where(like(pluginGrants.ref, `${PARALLEL}/%`));
    await database
      .delete(mcpServers)
      .where(
        or(
          eq(mcpServers.id, `team:${PARALLEL}`),
          eq(mcpServers.catalogueKey, PARALLEL),
        ),
      );
    await database
      .delete(enterpriseSettings)
      .where(eq(enterpriseSettings.key, DEFAULT_APPS_SETTING));
  });
}

async function writeSkill(slug: string, global = false) {
  await asOwner(() =>
    store.installSkill({
      slug,
      title: slug,
      summary: "",
      instructions: "Do the thing.",
      ownerUserId: global ? null : OWNER,
      by: `${OWNER}@example.test`,
    }),
  );
}

const offers = async (bot: string) =>
  [...(await real.heldSkills(bot))]
    .filter((slug) => slug.endsWith(suite))
    .sort();

/** 这个人以管理员身份经 `/api/plugins` 发出的请求，和插件页按下去一样。 */
function routes() {
  const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: OWNER,
      email: `${OWNER}@example.test`,
      role: "admin",
    } as never);
    await runAsTenant(OWNER, () => next());
  };
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      session,
      async () => true,
      undefined,
      undefined,
      createAdminScope({ roleRepository: createRoleRepository(database) }),
    ),
  );
}
const request = (method: string, path: string, body?: unknown) =>
  routes().request(`/api/plugins${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  mock.addTool({
    name: "web_search",
    description: "Search the public web.",
    inputSchema: {
      type: "object",
      properties: { objective: { type: "string" } },
    },
  });
  mock.addTool({
    name: "web_fetch",
    description: "Read public web pages.",
    inputSchema: { type: "object", properties: { urls: { type: "array" } } },
  });
  mockUrl = await mock.start();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (!target.startsWith("https://search.parallel.ai"))
      return realFetch(input, init);
    if (!online) return Promise.reject(new TypeError("fetch failed"));
    return realFetch(mockUrl, init);
  }) as typeof fetch;
  releaseAdmin = await seedAdministrator(database, OWNER);
  await addBot(ASSISTANT);
});

beforeEach(async () => {
  online = true;
  setEdition("personal");
  await forgetParallel();
  await asPlatform(() => database.delete(agents).where(eq(agents.id, LATER)));
});

afterEach(() => setEdition("team"));

afterAll(async () => {
  globalThis.fetch = realFetch;
  await mock.stop?.();
  await forgetParallel();
  await asPlatform(async () => {
    await database
      .delete(enterpriseSettings)
      .where(
        like(enterpriseSettings.key, `personal_skills_given:pd-%${suite}`),
      );
    await database.delete(skills).where(like(skills.slug, `%-${suite}`));
    await database.delete(agents).where(inArray(agents.id, [ASSISTANT, LATER]));
  });
  await releaseAdmin?.();
  await database.$client.close();
});

describe("Parallel Search in the personal edition", () => {
  test("a fresh start turns it on and the Bot holds web_search and web_fetch", async () => {
    expect(await restart()).toEqual([]);
    expect(await platformStore.serverAddress(PARALLEL)).toBeDefined();
    expect(await held(ASSISTANT)).toEqual(SEARCH);
  });

  /*
   * fork 的租户：OpenBot 替这个人做的授予是这个人自己的行，不是平台的；轨迹上每位员工一行，列出全部动作，
   * 记为部署发起，不是谁按了按钮。
   */
  test("the grants are the person's own rows, with one trail row per Bot started by OpenBot", async () => {
    const since = new Date();
    await restart();
    const rows = await asPlatform(() =>
      database
        .select({ tenantId: pluginGrants.tenantId, by: pluginGrants.grantedBy })
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, ASSISTANT),
            like(pluginGrants.ref, `${PARALLEL}/%`),
          ),
        ),
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.tenantId))).toEqual(new Set([OWNER]));
    expect(new Set(rows.map((row) => row.by))).toEqual(
      new Set(["openbot:personal-defaults"]),
    );
    const trail = await asPlatform(() =>
      database
        .select({
          initiatorKind: auditEvents.initiatorKind,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetId, PARALLEL),
            sql`${auditEvents.payload}->>'bot' = ${ASSISTANT}`,
            gte(auditEvents.createdAt, since),
          ),
        ),
    );
    expect(trail).toHaveLength(1);
    expect(trail[0]?.initiatorKind).toBe("deployment");
    expect(trail[0]?.payload).toMatchObject({
      change: "plugin_granted",
      app: PARALLEL,
      refs: SEARCH,
    });
  });

  test("a Bot made later holds them too", async () => {
    await restart();
    await addBot(LATER);
    expect(await held(LATER)).toEqual(SEARCH);
  });

  test("turned off, it stays off after a restart", async () => {
    await restart();
    await asAdmin(() => store.removeServer(`team:${PARALLEL}`, OWNER));
    expect(await restart()).toEqual([]);
    expect(await platformStore.serverAddress(PARALLEL)).toBeUndefined();
    expect(await held(ASSISTANT)).toEqual([]);
  });

  test("an app the person already added is left as it is", async () => {
    await asAdmin(() => store.addServer({ key: PARALLEL, by: OWNER }));
    await restart();
    const [row] = await asPlatform(() =>
      database
        .select({ addedBy: mcpServers.addedBy })
        .from(mcpServers)
        .where(eq(mcpServers.catalogueKey, PARALLEL)),
    );
    expect(row?.addedBy).toBe(OWNER);
    expect((await memory.added()).has(PARALLEL)).toBe(true);
  });

  test("an offline start still starts, and the next start finishes it", async () => {
    online = false;
    expect(await restart()).toEqual([PARALLEL]);
    expect(await held(ASSISTANT)).toEqual([]);

    online = true;
    expect(await restart()).toEqual([]);
    expect(await held(ASSISTANT)).toEqual(SEARCH);
  });

  test("while it runs, it finishes on its own when the network comes back", async () => {
    online = false;
    const stop = startPersonalDefaultApps(platformStore, deps, memory, [25]);
    try {
      await waitFor(
        async () => (await platformStore.serverAddress(PARALLEL)) !== undefined,
      );
      expect(await held(ASSISTANT)).toEqual([]);
      online = true;
      await waitFor(async () => (await held(ASSISTANT)).length === 2);
      expect(await held(ASSISTANT)).toEqual(SEARCH);
    } finally {
      stop();
    }
  });
});

test("the team edition turns nothing on", async () => {
  setEdition("team");
  expect(await restart()).toEqual([]);
  startPersonalDefaultApps(platformStore, deps, memory, [25])();
  await Bun.sleep(100);
  expect(await platformStore.serverAddress(PARALLEL)).toBeUndefined();
  expect(await memory.added()).toEqual(new Set());
  expect(await held(ASSISTANT)).toEqual([]);
});

/*
 * 团队版里管理员添加一个应用，员工什么也拿不到：授予仍由管理员逐个决定。
 */
test("the team edition gives no Bot an app an admin adds", async () => {
  setEdition("team");
  await asAdmin(() => store.addServer({ key: PARALLEL, by: OWNER }));
  expect(await held(ASSISTANT)).toEqual([]);
});

describe("taking something from one Bot, through the routes", () => {
  test("an app's tool is refused in the personal edition and stays held", async () => {
    await restart();
    const response = await request(
      "DELETE",
      `/grants?kind=mcp&ref=parallel/web_search&agentId=${ASSISTANT}`,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: EVERY_BOT_REFUSAL });
    expect(await held(ASSISTANT)).toEqual(SEARCH);
  });

  test("Routines is refused, and turning Routines off is refused, in the personal edition", async () => {
    const revoke = await request(
      "DELETE",
      `/grants?kind=mcp&ref=routines/create_routine&agentId=${ASSISTANT}`,
    );
    expect(revoke.status).toBe(403);
    expect(await revoke.json()).toEqual({ error: ALWAYS_ON_REFUSAL });
    for (const id of ["routines", "team:routines"]) {
      const remove = await request("DELETE", `/servers/${id}`);
      expect(remove.status).toBe(403);
      expect(await remove.json()).toEqual({ error: ALWAYS_ON_REFUSAL });
    }
  });

  test("another Bot is refused in the personal edition", async () => {
    const response = await request(
      "DELETE",
      `/grants?kind=bot&ref=${LATER}&agentId=${ASSISTANT}`,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: EVERY_BOT_ASKS_REFUSAL });
  });

  test("the team edition leaves it to the admin, who may take the app away", async () => {
    await restart();
    setEdition("team");
    const response = await request(
      "DELETE",
      `/grants?kind=mcp&ref=parallel/web_search&agentId=${ASSISTANT}`,
    );
    expect(response.status).toBe(200);
    expect(await held(ASSISTANT)).toEqual(["parallel/web_fetch"]);
  });
});

describe("every Bot asking another, in the personal edition", () => {
  test("every other Bot the person has is reachable without a grant", async () => {
    await addBot(LATER);
    const reachable = await asOwner(() => store.botsReachableFrom(ASSISTANT));
    expect(reachable).toContain(LATER);
    expect(reachable).not.toContain(ASSISTANT);
  });

  test("the team edition still needs a grant", async () => {
    await addBot(LATER);
    setEdition("team");
    expect(
      await asOwner(() => store.botsReachableFrom(ASSISTANT)),
    ).not.toContain(LATER);
  });
});

describe("the personal edition's skills", () => {
  beforeAll(async () => {
    setEdition("team");
    // 上面列出员工时已经给过它一次（那时还没有这些技能）；这里从「还没给过」开始。
    await asPlatform(() =>
      database
        .delete(enterpriseSettings)
        .where(
          like(enterpriseSettings.key, `personal_skills_given:pd-%${suite}`),
        ),
    );
    // 两个技能，在个人版把技能给每位员工之前就写下了。
    await writeSkill(STANDUP);
    await writeSkill(TRIAGE);
  });

  test("a start gives every Bot the skills there are, and writes down that it did", async () => {
    await ensurePersonalSkills(store, deps);
    expect(await offers(ASSISTANT)).toEqual([STANDUP, TRIAGE].sort());
    expect(await real.skillsGiven(ASSISTANT)).toBe(true);
    const [row] = await asPlatform(() =>
      database
        .select()
        .from(enterpriseSettings)
        .where(eq(enterpriseSettings.key, skillsGivenSetting(ASSISTANT))),
    );
    expect(row?.key).toBe(skillsGivenSetting(ASSISTANT));
  });

  test("a skill switched off for a Bot stays off after the next start and run", async () => {
    await asOwner(() =>
      store.revoke("skill", TRIAGE, ASSISTANT, `${OWNER}@example.test`),
    );
    await ensurePersonalSkills(store, deps);
    await asOwner(() => store.listForAgent(ASSISTANT));
    expect(await offers(ASSISTANT)).toEqual([STANDUP]);
  });

  test("a new skill goes to every Bot", async () => {
    await writeSkill(FRESH);
    expect(await offers(ASSISTANT)).toEqual([FRESH, STANDUP].sort());
  });

  test("a Bot made later gets every skill the first time it is listed", async () => {
    await addBot(LATER);
    await asOwner(() => store.listForAgent(LATER));
    expect(await offers(LATER)).toEqual([FRESH, STANDUP, TRIAGE].sort());
  });
});

/*
 * 个人版的设置 › 技能保存时带 `global`。存成谁的都不是，员工的「你的技能」里就没有它；个人版里它归这个人。
 * 之前那样存下的，在启动时给他，自带的和别人装的不动。
 */
describe("a skill the person writes in the personal edition is theirs", () => {
  const SAVED = `saved-${suite}`;
  const BEFORE = `before-${suite}`;
  const SHIPPED = `shipped-${suite}`;

  const ownerOf = async (slug: string) =>
    (
      await asPlatform(() =>
        database
          .select({ owner: skills.ownerUserId })
          .from(skills)
          .where(eq(skills.slug, slug)),
      )
    )[0]?.owner;

  test("saved with global, it is stored as the person's", async () => {
    const response = await request("POST", "/skills", {
      slug: SAVED,
      title: SAVED,
      instructions: "Do the thing.",
      global: true,
    });
    expect(response.status).toBeLessThan(300);
    expect(await ownerOf(SAVED)).toBe(OWNER);
  });

  test("one stored as nobody's before is given to them at startup, with one trail row", async () => {
    setEdition("team");
    await writeSkill(BEFORE, true);
    await asOwner(() =>
      store.installSkill({
        slug: SHIPPED,
        title: SHIPPED,
        summary: "",
        instructions: "Shipped.",
        origin: "openbot",
        ownerUserId: null,
        by: `${OWNER}@example.test`,
      }),
    );
    setEdition("personal");
    const person = { id: OWNER, email: `${OWNER}@example.test` };
    const given = await ensurePersonalSkillsOwned(database, person, audit);
    expect(given).toContain(BEFORE);
    expect(given).not.toContain(SHIPPED);
    expect(await ownerOf(BEFORE)).toBe(OWNER);
    expect(await ownerOf(SHIPPED)).toBe(null);
    expect(await ensurePersonalSkillsOwned(database, person, audit)).toEqual(
      [],
    );
  });

  test("the team edition leaves a skill for everybody as the deployment's", async () => {
    setEdition("team");
    const TEAM_SKILL = `team-${suite}`;
    const response = await request("POST", "/skills", {
      slug: TEAM_SKILL,
      title: TEAM_SKILL,
      instructions: "Do the thing.",
      global: true,
    });
    expect(response.status).toBeLessThan(300);
    expect(await ownerOf(TEAM_SKILL)).toBe(null);
  });
});

/*
 * 个人版没有按员工的学习开关，所以团队版存下的「这位员工不参与」（映射为 null）在个人版里把它带回来，
 * 只动 null 的那几个，其余的键原样留着。用的是部署唯一的那一行设置，测试前后原样放回。
 */
describe("every Bot takes part in Automatic Learning in the personal edition", () => {
  let saved: { settings: unknown } | undefined;

  beforeAll(async () => {
    [saved] = await asPlatform(() =>
      database
        .select({ settings: learningSettings.settings })
        .from(learningSettings)
        .where(eq(learningSettings.id, "current")),
    );
  });

  afterAll(async () => {
    await asPlatform(() =>
      saved
        ? database
            .update(learningSettings)
            .set({ settings: saved.settings as never })
            .where(eq(learningSettings.id, "current"))
        : database
            .delete(learningSettings)
            .where(eq(learningSettings.id, "current")),
    );
  });

  const writeMapping = async (agentsMapping: Record<string, unknown>) => {
    const settings = {
      enabled: true,
      defaultTarget: { containerId: `container-${suite}` },
      agents: agentsMapping,
    };
    await asPlatform(() =>
      database
        .insert(learningSettings)
        .values({ id: "current", settings: settings as never })
        .onConflictDoUpdate({
          target: learningSettings.id,
          set: { settings: settings as never },
        }),
    );
  };

  test("a Bot left out is taken back in, the others are kept, and a second start writes nothing", async () => {
    await writeMapping({
      [ASSISTANT]: null,
      [LATER]: { containerId: `kept-${suite}` },
    });
    expect(await ensurePersonalLearning(deps, audit)).toEqual([ASSISTANT]);
    const [row] = await asPlatform(() =>
      database
        .select({ settings: learningSettings.settings })
        .from(learningSettings)
        .where(eq(learningSettings.id, "current")),
    );
    expect(row?.settings.agents).toEqual({
      [LATER]: { containerId: `kept-${suite}` },
    });
    expect(await ensurePersonalLearning(deps, audit)).toEqual([]);
  });

  test("the team edition leaves a Bot out where an admin left it out", async () => {
    await writeMapping({ [ASSISTANT]: null });
    setEdition("team");
    expect(await ensurePersonalLearning(deps, audit)).toEqual([]);
    const [row] = await asPlatform(() =>
      database
        .select({ settings: learningSettings.settings })
        .from(learningSettings)
        .where(eq(learningSettings.id, "current")),
    );
    expect(row?.settings.agents).toEqual({ [ASSISTANT]: null });
  });
});

async function waitFor(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(25);
  }
}
