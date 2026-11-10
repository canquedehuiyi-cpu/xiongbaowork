import { afterEach, describe, expect, test } from "bun:test";
import { setEdition } from "../src/edition";
import {
  ALWAYS_ON_REFUSAL,
  alwaysOnHere,
  EVERY_BOT_ASKS_REFUSAL,
  EVERY_BOT_REFUSAL,
  ensureAlwaysOnApp,
  ensurePersonalSkills,
  isAlwaysOn,
  personalRevokeRefusal,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";

/**
 * 个人版的默认，对着一个假的 store（上游 `personal-plugin-defaults.test.ts`，按 fork 的规则改写）。
 *
 * 和上游的差别：团队版里 Routines 不自动加、不自动给（fork 的 Routines 在团队版里由管理员授予）；包装只给
 * 这个人能看见的员工（`bots()` 里有的），所以「之后建的员工」先出现在 `bots()` 里，像真的库那样。
 */

type Tool = { ref: string };

const ROUTINES: Tool[] = [
  { ref: "routines/list_routines" },
  { ref: "routines/create_routine" },
];
const NOTION: Tool[] = [
  { ref: "notion/search" },
  { ref: "notion/create_page" },
];

/**
 * 一个 store：每个应用下次刷新时列出测试说 vendor 会答的东西。`vendors` 是应用下次刷新时列出的，`added`
 * 是部署到目前为止添加的。
 */
function fakeStore(
  vendors: Record<string, Tool[]>,
  existingSkills: string[] = [],
  bots: string[] = ["assistant", "researcher"],
) {
  const listed = new Map<string, Tool[]>();
  const grants: string[] = [];
  /** 每条授予在轨迹上写的是谁，按 `agent:ref`。 */
  const grantedBy = new Map<string, string>();
  /** grantTools 每次调用写的一行轨迹。 */
  const trail: { app: string; refs: string[]; bot: string; by: string }[] = [];
  const added: string[] = [];
  const skills = new Set<string>(existingSkills);
  const given = new Set<string>();
  const store = {
    async refreshTools(serverId: string, _actorId = "") {
      listed.set(serverId, vendors[serverId] ?? []);
      return { tools: listed.get(serverId)?.length ?? 0 };
    },
    async grant(
      _kind: "mcp" | "skill",
      ref: string,
      agentId: string,
      by: string,
    ) {
      grants.push(`${agentId}:${ref}`);
      grantedBy.set(`${agentId}:${ref}`, by);
    },
    async grantTools(app: string, refs: string[], agentId: string, by: string) {
      trail.push({ app, refs, bot: agentId, by });
      for (const ref of refs) {
        grants.push(`${agentId}:${ref}`);
        grantedBy.set(`${agentId}:${ref}`, by);
      }
      return refs;
    },
    /** 方法之间经 `this` 互相调用，和真的 store 一样。 */
    async addServer(input: { key: string; by: string }) {
      added.push(input.key);
      await this.refreshTools(input.key);
    },
    async serverAddress(serverId: string) {
      return added.includes(serverId) ? { id: serverId } : undefined;
    },
    async refreshOwnListings() {
      return [];
    },
    async listForAgent(agentId: string) {
      return grants.filter((grant) => grant.startsWith(`${agentId}:`));
    },
    async installSkill(input: { slug: string; by: string }) {
      skills.add(input.slug);
    },
  };
  const deps = {
    tools: async (serverId: string) => listed.get(serverId) ?? [],
    bots: async () => bots,
    granted: async (agentId: string, serverId: string) =>
      new Set(
        grants
          .filter((grant) => grant.startsWith(`${agentId}:${serverId}/`))
          .map((grant) => grant.slice(agentId.length + 1)),
      ),
    servers: async () => added,
    skillExists: async (slug: string) => skills.has(slug),
    skills: async () => [...skills],
    heldSkills: async (agentId: string) =>
      new Set(
        grants
          .filter((grant) => grant.startsWith(`${agentId}:`))
          .map((grant) => grant.slice(agentId.length + 1))
          .filter((ref) => skills.has(ref)),
      ),
    skillsGiven: async (agentId: string) => given.has(agentId),
    rememberSkillsGiven: async (agentId: string) => {
      given.add(agentId);
    },
    includeEveryBotInLearning: async () => [] as string[],
  };
  const wrapped = withPersonalDefaults(store, deps);
  return { store: wrapped, grants, grantedBy, added, deps, bots, trail };
}

afterEach(() => setEdition("team"));

describe("a connected app in the personal edition", () => {
  test("gives every Bot every tool, including the ones that change things", async () => {
    setEdition("personal");
    const { store, grants } = fakeStore({ notion: NOTION });
    await store.addServer({ key: "notion", by: "me" });
    expect(grants.sort()).toEqual([
      "assistant:notion/create_page",
      "assistant:notion/search",
      "researcher:notion/create_page",
      "researcher:notion/search",
    ]);
  });

  test("a refresh gives only what a Bot doesn't hold yet", async () => {
    setEdition("personal");
    const { store, grants } = fakeStore({ notion: NOTION });
    await store.addServer({ key: "notion", by: "me" });
    const before = grants.length;
    await store.refreshTools("notion");
    expect(grants).toHaveLength(before);
  });

  /*
   * 一次升级给 Routines 加七个动作时，逐个授予会给每位员工各写七行；每位员工每个应用一行才说清发生了什么。
   * 这里的刷新是谁按的就记谁。
   */
  test("one trail row per Bot and app, naming every tool it was given", async () => {
    setEdition("personal");
    const { store, trail } = fakeStore({ notion: NOTION });
    await store.addServer({ key: "notion", by: "me" });
    trail.length = 0;
    await store.refreshTools("notion", "me");
    expect(trail).toEqual([]);
    const later = fakeStore({ notion: NOTION });
    await later.store.refreshTools("notion", "me");
    const { trail: pressed } = later;
    expect(pressed).toEqual([
      {
        app: "notion",
        refs: ["notion/create_page", "notion/search"],
        bot: "assistant",
        by: "me",
      },
      {
        app: "notion",
        refs: ["notion/create_page", "notion/search"],
        bot: "researcher",
        by: "me",
      },
    ]);
  });

  test("a Bot made later gets every connected app the first time it runs", async () => {
    setEdition("personal");
    const { store, deps, bots } = fakeStore({
      notion: NOTION,
      routines: ROUTINES,
    });
    await ensureAlwaysOnApp(store, deps);
    await store.addServer({ key: "notion", by: "me" });
    bots.push("travel");
    expect((await store.listForAgent("travel")).sort()).toEqual([
      "travel:notion/create_page",
      "travel:notion/search",
      "travel:routines/create_routine",
      "travel:routines/list_routines",
    ]);
  });

  test("the trail says why a Bot made later holds each app", async () => {
    setEdition("personal");
    const { store, deps, grantedBy, bots } = fakeStore({
      notion: NOTION,
      routines: ROUTINES,
    });
    await ensureAlwaysOnApp(store, deps);
    await store.addServer({ key: "notion", by: "me" });
    bots.push("travel");
    await store.listForAgent("travel");
    expect(grantedBy.get("travel:notion/search")).toBe(
      "openbot:personal-defaults",
    );
    expect(grantedBy.get("travel:routines/list_routines")).toBe(
      "openbot:always-on",
    );
  });

  /*
   * 行安全看不见的员工不是这个人的：被列出时什么也不给它，免得一次运行把别人的员工也写进这个人的授予里。
   */
  test("a Bot the person cannot see is given nothing when it is listed", async () => {
    setEdition("personal");
    const { store, grants } = fakeStore({ notion: NOTION });
    await store.addServer({ key: "notion", by: "me" });
    expect(await store.listForAgent("someone-elses")).toEqual([]);
    expect(grants.some((grant) => grant.startsWith("someone-elses:"))).toBe(
      false,
    );
  });
});

test("the team edition gives nothing for an app an admin adds", async () => {
  const { store, grants } = fakeStore({ notion: NOTION });
  await store.addServer({ key: "notion", by: "me" });
  expect(grants).toEqual([]);
  expect(await store.listForAgent("assistant")).toEqual([]);
});

describe("Routines in the personal edition", () => {
  test("is added at startup and every Bot gets all its tools, including ones that change things", async () => {
    setEdition("personal");
    const { store, grants, added, deps } = fakeStore({ routines: ROUTINES });
    await ensureAlwaysOnApp(store, deps);
    expect(added).toEqual(["routines"]);
    expect(grants.sort()).toEqual([
      "assistant:routines/create_routine",
      "assistant:routines/list_routines",
      "researcher:routines/create_routine",
      "researcher:routines/list_routines",
    ]);
  });

  test("a second startup writes nothing", async () => {
    setEdition("personal");
    const { store, grants, added, deps } = fakeStore({ routines: ROUTINES });
    await ensureAlwaysOnApp(store, deps);
    const before = grants.length;
    await ensureAlwaysOnApp(store, deps);
    expect(added).toEqual(["routines"]);
    expect(grants).toHaveLength(before);
  });

  test("cannot be turned off or taken from a Bot", () => {
    setEdition("personal");
    expect(isAlwaysOn("routines")).toBe(true);
    expect(isAlwaysOn("routines/create_routine")).toBe(true);
    expect(isAlwaysOn("notion")).toBe(false);
    expect(alwaysOnHere("team:routines")).toBe(true);
    expect(alwaysOnHere("routines/create_routine")).toBe(true);
    expect(personalRevokeRefusal("mcp", "routines/create_routine")).toBe(
      ALWAYS_ON_REFUSAL,
    );
  });

  /*
   * fork 的 Routines 在团队版里是管理员像对待别的应用一样授予的能力：启动时不加、不给，也可以关、可以收回。
   */
  test("the team edition neither adds it nor gives it, and leaves it removable", async () => {
    const { store, grants, added, deps } = fakeStore({ routines: ROUTINES });
    await ensureAlwaysOnApp(store, deps);
    expect(added).toEqual([]);
    expect(grants).toEqual([]);
    expect(alwaysOnHere("routines")).toBe(false);
    expect(alwaysOnHere("team:routines")).toBe(false);
    expect(personalRevokeRefusal("mcp", "routines/create_routine")).toBe(null);
  });
});

describe("taking something from one Bot", () => {
  test("is refused for an app or another Bot in the personal edition, not for a skill", () => {
    setEdition("personal");
    expect(personalRevokeRefusal("mcp", "notion/search")).toBe(
      EVERY_BOT_REFUSAL,
    );
    expect(personalRevokeRefusal("bot", "researcher")).toBe(
      EVERY_BOT_ASKS_REFUSAL,
    );
    expect(personalRevokeRefusal("skill", "standup")).toBe(null);
  });

  test("is left to the admin's rules in the team edition", () => {
    expect(personalRevokeRefusal("mcp", "notion/search")).toBe(null);
    expect(personalRevokeRefusal("bot", "researcher")).toBe(null);
  });
});

describe("a new skill in the personal edition", () => {
  test("goes to every Bot", async () => {
    setEdition("personal");
    const { store, grants, grantedBy } = fakeStore({});
    await store.installSkill({ slug: "standup", by: "me" });
    expect(grants.sort()).toEqual(["assistant:standup", "researcher:standup"]);
    expect(grantedBy.get("assistant:standup")).toBe("me");
  });

  test("saving it again does not turn it back on for a Bot it was taken from", async () => {
    setEdition("personal");
    const { store, grants } = fakeStore({});
    await store.installSkill({ slug: "standup", by: "me" });
    grants.splice(grants.indexOf("researcher:standup"), 1);
    await store.installSkill({ slug: "standup", by: "me" });
    expect(grants).toEqual(["assistant:standup"]);
  });

  test("goes to no Bot in the team edition, where an admin chooses", async () => {
    const { store, grants } = fakeStore({});
    await store.installSkill({ slug: "standup", by: "me" });
    expect(grants).toEqual([]);
  });
});

describe("the skills there are, in the personal edition", () => {
  test("every Bot is given every skill at startup", async () => {
    setEdition("personal");
    const { store, grants, deps } = fakeStore({}, ["standup", "triage"]);
    await ensurePersonalSkills(store, deps);
    expect(grants.sort()).toEqual([
      "assistant:standup",
      "assistant:triage",
      "researcher:standup",
      "researcher:triage",
    ]);
  });

  test("a skill switched off for a Bot stays off after the next start and run", async () => {
    setEdition("personal");
    const { store, grants, deps } = fakeStore({}, ["standup"]);
    await ensurePersonalSkills(store, deps);
    grants.splice(grants.indexOf("researcher:standup"), 1);
    await ensurePersonalSkills(store, deps);
    await store.listForAgent("researcher");
    expect(grants).toEqual(["assistant:standup"]);
  });

  test("a Bot made later gets every skill the first time it runs", async () => {
    setEdition("personal");
    const bots = ["assistant"];
    const { store, grants, deps } = fakeStore({}, ["standup", "triage"], bots);
    await ensurePersonalSkills(store, deps);
    bots.push("writer");
    await store.listForAgent("writer");
    expect(
      grants.filter((grant) => grant.startsWith("writer:")).sort(),
    ).toEqual(["writer:standup", "writer:triage"]);
  });

  test("the team edition gives none, where an admin chooses", async () => {
    const { store, grants, deps } = fakeStore({}, ["standup"]);
    await ensurePersonalSkills(store, deps);
    await store.listForAgent("assistant");
    expect(grants.filter((grant) => grant.endsWith(":standup"))).toEqual([]);
  });
});
