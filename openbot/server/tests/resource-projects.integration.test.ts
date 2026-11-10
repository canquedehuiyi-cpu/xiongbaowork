import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import {
  checkProjectSource,
  gitBranchProblem,
  gitUrlProblem,
  PROJECT_LIMIT_PER_DEVICE,
} from "../../shared/projects";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  projectContextBindings,
  registeredDevices,
  resourceProjects,
  users,
} from "../src/db/schema";
import { createDeviceStore, reportedRoots } from "../src/devices/store";
import {
  createProjectRoutes,
  PROJECT_BRANCHES_ACTION,
  PROJECT_SYNC_ACTION,
  type ProjectDevices,
} from "../src/projects/routes";
import { createProjectStore, type Project } from "../src/projects/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Story RES2, phase 1 (spec 2026-11-04-res2-resource-projects §5 RES2-1): projects on a paired
 * machine, their scope, and the coworker's current project, against the real database with row
 * security on (FORCE, migration 0138), in each person's own frame. Two people, each with their own
 * coworkers, and a Team Bot of the first.
 *
 * Fixture rows that no person could write themselves (the Team Bot, which lives in `team`) are
 * written as `platform`, the frame the deployment writes such rows in; everything under test runs as
 * the person.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const personA = `res2-${suite}-a`;
const personB = `res2-${suite}-b`;
const botX = `res2-${suite}-x`;
const botY = `res2-${suite}-y`;
const teamBot = `res2-${suite}-team`;
const botB = `res2-${suite}-b-bot`;
const store = createProjectStore(database);
const devices = createDeviceStore(database);

const READ_REF = "fld_RRRRRRRRRRRRRRRRRRRRRR";
const WRITE_REF = "fld_WWWWWWWWWWWWWWWWWWWWWW";
const OTHER_REF = "fld_OOOOOOOOOOOOOOOOOOOOOO";
const SECRET_PATH = `/home/${suite}/客户/机密项目`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const actor =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", { id, email: `${id}@res2.test`, role: "user" });
    await runAsTenant(id, () => next());
  };

/** What the routes were asked to send to a machine, and what the fake machine answers. */
const sent: Array<{ target: unknown; action: string; payload: unknown }> = [];
let online = true;
const fakeDevices: ProjectDevices = {
  isReachable: () => online,
  dispatch: async <T>(target: unknown, action: string, payload: unknown) => {
    sent.push({ target, action, payload });
    if (action === PROJECT_SYNC_ACTION)
      return { rootRef: OTHER_REF, commit: COMMIT } as T;
    if (action === PROJECT_BRANCHES_ACTION)
      return { branches: ["main", "release/1.0", 42, "x".repeat(300)] } as T;
    throw new Error("unexpected action");
  },
};

const routes = (person: string) =>
  createProjectRoutes(store, actor(person), fakeDevices);

async function call<T>(
  person: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await routes(person).request(
    new Request(`http://openbot.test${path}`, {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as T,
  };
}

type One = { project?: Project; error?: string };

/** A machine of `person`'s, reporting a read-only folder and a writable one, as a heartbeat does. */
async function machine(person: string) {
  const runnerId = `${person}-${randomUUID().slice(0, 6)}`;
  const [row] = await runAsTenant(person, () =>
    database
      .insert(registeredDevices)
      .values({
        tenantId: person,
        deviceId: runnerId,
        name: "书房电脑",
        platform: "linux",
        tokenHash: randomUUID(),
        lastSeenAt: new Date(),
      })
      .returning({ id: registeredDevices.id }),
  );
  if (!row) throw new Error("no device row");
  /*
   * What the socket does with a heartbeat: the report is filtered, and a path is never kept. The
   * second folder was registered for writing on the machine (decision D3), and the runner says so.
   */
  await devices.heartbeat(
    person,
    runnerId,
    reportedRoots([
      { ref: READ_REF, name: "合同", path: SECRET_PATH },
      { ref: WRITE_REF, name: "后端代码", mode: "write", path: SECRET_PATH },
    ]),
  );
  return { id: row.id, runnerId };
}

const localBody = (
  deviceId: string,
  extra: Record<string, unknown> = {},
  source: Record<string, unknown> = {},
) => ({
  deviceId,
  name: "合同审阅",
  description: "法务部的合同模板",
  source: { kind: "local", rootRef: READ_REF, writable: false, ...source },
  ...extra,
});

const gitBody = (deviceId: string, source: Record<string, unknown> = {}) => ({
  deviceId,
  name: "官网",
  description: "公司官网前端",
  source: {
    kind: "git",
    url: "https://git.example.test/web/site.git",
    branch: "main",
    ...source,
  },
});

beforeAll(async () => {
  await runAsTenant("platform", () =>
    database.insert(users).values(
      [personA, personB].map((id) => ({
        id,
        email: `${id}@res2.test`,
        name: id,
      })),
    ),
  );
  const bot = (id: string) => ({
    id,
    name: id,
    type: "built_in" as const,
    configuration: {},
  });
  const profile = (agentId: string, tenantId: string, owner: string) => ({
    agentId,
    tenantId,
    ownerUserId: owner,
    title: agentId,
    roleDescription: "测试员工",
    avatarSeed: agentId,
    visibility: "private" as const,
  });
  await runAsTenant(personA, async () => {
    await database.insert(agents).values([bot(botX), bot(botY)]);
    await database
      .insert(agentProfiles)
      .values([
        profile(botX, personA, personA),
        profile(botY, personA, personA),
      ]);
  });
  await runAsTenant(personB, async () => {
    await database.insert(agents).values(bot(botB));
    await database
      .insert(agentProfiles)
      .values(profile(botB, personB, personB));
  });
  // A Team Bot is stamped `team`, which is nobody's frame; the deployment writes it as `platform`.
  await runAsTenant("platform", async () => {
    await database.insert(agents).values({ ...bot(teamBot), tenantId: "team" });
    await database
      .insert(agentProfiles)
      .values(profile(teamBot, "team", personA));
  });
});

afterAll(async () => {
  for (const person of [personA, personB])
    await runAsTenant(person, () =>
      database
        .delete(registeredDevices)
        .where(eq(registeredDevices.tenantId, person)),
    );
  await runAsTenant("platform", async () => {
    await database
      .delete(agents)
      .where(inArray(agents.id, [botX, botY, teamBot, botB]));
    await database.delete(users).where(inArray(users.id, [personA, personB]));
  });
  await database.$client.end({ timeout: 5 });
});

describe("the database", () => {
  test("both tables are FORCE row security, with the platform read beside the owner policies", async () => {
    const rows = (await runAsTenant("platform", () =>
      database.execute(sql`
        select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as force
          from pg_class c
         where c.relname in ('resource_projects', 'project_context_bindings')
         order by c.relname`),
    )) as unknown as Array<{ name: string; rls: boolean; force: boolean }>;
    expect(rows).toEqual([
      { name: "project_context_bindings", rls: true, force: true },
      { name: "resource_projects", rls: true, force: true },
    ]);
    const policies = (await runAsTenant("platform", () =>
      database.execute(sql`
        select tablename as "table", cmd from pg_policies
         where policyname = 'platform_scope_select'
           and tablename in ('resource_projects', 'project_context_bindings')
         order by tablename`),
    )) as unknown as Array<{ table: string; cmd: string }>;
    expect(policies).toEqual([
      { table: "project_context_bindings", cmd: "SELECT" },
      { table: "resource_projects", cmd: "SELECT" },
    ]);
  });

  test("acceptance 5: the source CHECK refuses a path, a credential, file://, ext:: and a bad branch written straight to the table", async () => {
    const device = await machine(personA);
    const insert = (source: unknown) =>
      runAsTenant(personA, () =>
        database.insert(resourceProjects).values({
          id: randomUUID(),
          tenantId: personA,
          deviceId: device.id,
          scope: "public",
          name: "直接写入",
          // Whatever the case writes, straight past the route: the CHECK is what refuses it.
          source: source as Record<string, unknown>,
        }),
      );
    const git = (fields: Record<string, unknown>) => ({
      kind: "git",
      url: "https://git.example.test/a.git",
      branch: "main",
      rootRef: null,
      writable: true,
      syncedAt: null,
      commit: null,
      ...fields,
    });
    const refused = [
      { kind: "local", rootRef: SECRET_PATH, label: "x", writable: false },
      {
        kind: "local",
        rootRef: READ_REF,
        label: "x",
        writable: false,
        path: SECRET_PATH,
      },
      { kind: "local", rootRef: READ_REF, label: "x" },
      git({ url: "https://user:pass@git.example.test/a.git" }),
      git({ url: "https://token@git.example.test/a.git" }),
      git({ url: "ssh://user:pass@git.example.test/a.git" }),
      git({ url: "file:///srv/repo.git" }),
      git({ url: "/srv/repo.git" }),
      git({ url: "ext::sh -c touch% /tmp/pwned" }),
      git({ url: "http://git.example.test/a.git" }),
      git({ url: "-u@git.example.test:a.git" }),
      git({ branch: "main;rm -rf /" }),
      git({ branch: "../../etc" }),
      git({ branch: "-delete" }),
      git({ branch: "a.lock" }),
      git({ commit: "not-a-commit" }),
      git({ rootRef: "/home/me/clone" }),
      git({ token: "secret" }),
      (() => {
        const { syncedAt: _, ...rest } = git({});
        return rest;
      })(),
      "a string",
      [],
    ];
    for (const source of refused) {
      const error = await insert(source).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(
        String((error as Error & { cause?: Error }).cause ?? error),
      ).toMatch(/resource_projects_source_check|check constraint/);
    }
    for (const source of [
      { kind: "local", rootRef: READ_REF, label: "合同", writable: false },
      git({}),
      git({ url: "git@git.example.test:team/a.git", branch: "feat/x-1" }),
      git({
        url: "ssh://git@10.0.0.5:2222/team/a.git",
        rootRef: OTHER_REF,
        syncedAt: new Date().toISOString(),
        commit: COMMIT,
      }),
    ])
      await insert(source);
  });
});

describe("the shared checks", () => {
  test("acceptance 5: an address with a credential, a local or ext:: transport, or a non-https scheme is refused; a private host is not", () => {
    for (const url of [
      "https://user:pass@github.com/a/b.git",
      "https://ghp_token@github.com/a/b.git",
      "ssh://git:pw@host/a.git",
      "file:///tmp/repo",
      "/tmp/repo",
      "./repo",
      "ext::sh -c id",
      "http://github.com/a/b.git",
      "-oProxyCommand=id@host:a",
      "https://github.com/",
      "ssh://-oProxyCommand=id/a",
      "",
      `https://github.com/${"a".repeat(500)}`,
    ])
      expect(gitUrlProblem(url)).not.toBeNull();
    for (const url of [
      "https://github.com/a/b.git",
      "https://gitlab.corp.internal:8443/group/b.git",
      "ssh://git@192.168.1.10:2222/a.git",
      "git@github.com:a/b.git",
    ])
      expect(gitUrlProblem(url)).toBeNull();
    for (const branch of [
      "main;rm -rf ~",
      "$(id)",
      "a b",
      "..",
      "a..b",
      "-x",
      "/a",
      "a/",
      "a.",
      "a//b",
      "a/.b",
      "x.lock",
      "HEAD",
      "",
    ])
      expect(gitBranchProblem(branch)).not.toBeNull();
    for (const branch of ["main", "release/1.0", "feat/RES2-1_x"])
      expect(gitBranchProblem(branch)).toBeNull();
    expect(
      checkProjectSource({
        kind: "local",
        rootRef: READ_REF,
        label: "x",
        writable: false,
        path: "/etc",
      }).ok,
    ).toBe(false);
  });
});

describe("making and changing projects", () => {
  test("acceptance 5: the API refuses each bad address and branch, and a source with fields it does not know", async () => {
    const device = await machine(personA);
    for (const source of [
      { url: "https://user:pass@git.example.test/a.git" },
      { url: "file:///srv/repo.git" },
      { url: "ext::sh -c id" },
      { branch: "main;rm -rf /" },
      { branch: "../x" },
    ]) {
      const answer = await call<One>(
        personA,
        "POST",
        "/",
        gitBody(device.id, source),
      );
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBeTruthy();
    }
    const unknownRoot = await call<One>(
      personA,
      "POST",
      "/",
      localBody(device.id, {}, { rootRef: OTHER_REF }),
    );
    expect(unknownRoot.status).toBe(400);
    expect(unknownRoot.body.error).toContain("没有这个本地目录");
    const noName = await call<One>(
      personA,
      "POST",
      "/",
      localBody(device.id, { name: "  " }),
    );
    expect(noName.status).toBe(400);
  });

  test("a local project keeps the machine's folder name and reference; the path is stored nowhere", async () => {
    const device = await machine(personA);
    const made = await call<One>(personA, "POST", "/", localBody(device.id));
    expect(made.status).toBe(201);
    expect(made.body.project?.source).toEqual({
      kind: "local",
      rootRef: READ_REF,
      label: "合同",
      writable: false,
    });
    const stored = await runAsTenant(personA, async () => ({
      projects: await database
        .select()
        .from(resourceProjects)
        .where(eq(resourceProjects.tenantId, personA)),
      devices: await database
        .select()
        .from(registeredDevices)
        .where(eq(registeredDevices.tenantId, personA)),
    }));
    expect(JSON.stringify(stored)).not.toContain(SECRET_PATH);
    expect(JSON.stringify(stored)).not.toContain("/home/");
  });

  test("D3: a folder the machine registered read-only cannot be a writable project; a writable one can, and the server can make it stricter", async () => {
    const device = await machine(personA);
    const wider = await call<One>(
      personA,
      "POST",
      "/",
      localBody(device.id, {}, { writable: true }),
    );
    expect(wider.status).toBe(400);
    expect(wider.body.error).toContain("只读");

    const writable = await call<One>(
      personA,
      "POST",
      "/",
      localBody(
        device.id,
        { name: "后端" },
        { rootRef: WRITE_REF, writable: true },
      ),
    );
    expect(writable.status).toBe(201);
    expect(writable.body.project?.source).toMatchObject({ writable: true });
    const id = writable.body.project?.id;

    const stricter = await call<One>(personA, "PATCH", `/${id}`, {
      revision: 1,
      writable: false,
    });
    expect(stricter.status).toBe(200);
    expect(stricter.body.project?.source).toMatchObject({ writable: false });
    expect(stricter.body.project?.revision).toBe(2);

    // The machine's owner turned the folder read-only: the project cannot be made writable again.
    await devices.heartbeat(
      personA,
      device.runnerId,
      reportedRoots([{ ref: WRITE_REF, name: "后端代码" }]),
    );
    const reopened = await call<One>(personA, "PATCH", `/${id}`, {
      revision: 2,
      writable: true,
    });
    expect(reopened.status).toBe(400);
  });

  test("a change made against an old revision is refused rather than overwriting the newer one", async () => {
    const device = await machine(personA);
    const made = await call<One>(personA, "POST", "/", localBody(device.id));
    const id = made.body.project?.id;
    expect(
      (await call<One>(personA, "PATCH", `/${id}`, { revision: 1, name: "一" }))
        .status,
    ).toBe(200);
    const stale = await call<One>(personA, "PATCH", `/${id}`, {
      revision: 1,
      name: "二",
    });
    expect(stale.status).toBe(409);
    expect((await store.get(personA, String(id)))?.name).toBe("一");
  });

  test("D10: a machine holds at most 50 projects", async () => {
    const device = await machine(personA);
    for (let index = 0; index < PROJECT_LIMIT_PER_DEVICE; index += 1)
      await store.create(personA, {
        deviceId: device.id,
        scope: "public",
        agentId: null,
        name: `项目 ${index}`,
        description: "",
        source: { kind: "local", rootRef: READ_REF, writable: false },
      });
    const over = await call<One>(personA, "POST", "/", localBody(device.id));
    expect(over.status).toBe(409);
    expect(over.body.error).toContain("50");
  });
});

describe("who sees a project", () => {
  test("acceptance 1: a public project is in every coworker's picker on its machine, a coworker's own only in that coworker's, the Team Bot's included", async () => {
    const device = await machine(personA);
    const shared = await call<One>(personA, "POST", "/", localBody(device.id));
    const xs = await call<One>(
      personA,
      "POST",
      "/",
      localBody(device.id, { name: "X 的项目", scope: "agent", agentId: botX }),
    );
    const teams = await call<One>(
      personA,
      "POST",
      "/",
      localBody(device.id, {
        name: "团队 Bot 的项目",
        scope: "agent",
        agentId: teamBot,
      }),
    );
    expect([shared.status, xs.status, teams.status]).toEqual([201, 201, 201]);
    const picker = async (agent: string) =>
      (
        await call<{ projects: Project[] }>(
          personA,
          "GET",
          `/?device=${device.id}&agent=${agent}`,
        )
      ).body.projects.map((project) => project.name);
    expect(await picker(botX)).toEqual(["合同审阅", "X 的项目"]);
    expect(await picker(botY)).toEqual(["合同审阅"]);
    expect(await picker(teamBot)).toEqual(["合同审阅", "团队 Bot 的项目"]);
    const all = await call<{ projects: Project[] }>(
      personA,
      "GET",
      `/?device=${device.id}`,
    );
    expect(all.body.projects).toHaveLength(3);
  });

  test("an agent project needs a coworker of this person's; another person's coworker is not found", async () => {
    const device = await machine(personA);
    const noAgent = await call<One>(
      personA,
      "POST",
      "/",
      localBody(device.id, { scope: "agent" }),
    );
    expect(noAgent.status).toBe(400);
    const theirs = await call<One>(
      personA,
      "POST",
      "/",
      localBody(device.id, { scope: "agent", agentId: botB }),
    );
    expect(theirs.status).toBe(404);
  });

  test("acceptance 4: another person cannot make a project on this person's machine, nor read, change, delete or pick one", async () => {
    const device = await machine(personA);
    const made = await call<One>(personA, "POST", "/", localBody(device.id));
    const id = made.body.project?.id;

    const onTheirMachine = await call<One>(
      personB,
      "POST",
      "/",
      localBody(device.id),
    );
    expect(onTheirMachine.status).toBe(404);
    expect((await call<One>(personB, "GET", `/${id}`)).status).toBe(404);
    expect(
      (await call<One>(personB, "PATCH", `/${id}`, { revision: 1, name: "改" }))
        .status,
    ).toBe(404);
    expect((await call<One>(personB, "DELETE", `/${id}`)).status).toBe(404);
    const list = await call<{ projects: Project[] }>(
      personB,
      "GET",
      `/?device=${device.id}`,
    );
    expect(list.body.projects).toEqual([]);
    expect(
      (
        await call<One>(personB, "PUT", "/current", {
          deviceId: device.id,
          agentId: botB,
          projectId: id,
        })
      ).status,
    ).toBe(404);

    // Straight to the table in B's frame: the database's own policy refuses A's machine.
    const direct = await runAsTenant(personB, () =>
      database
        .insert(resourceProjects)
        .values({
          id: randomUUID(),
          tenantId: personB,
          deviceId: device.id,
          scope: "public",
          name: "越权",
          source: {
            kind: "local",
            rootRef: READ_REF,
            label: "合同",
            writable: false,
          },
        })
        .catch((error: unknown) => error),
    );
    expect(direct).toBeInstanceOf(Error);
    expect(
      await runAsTenant(personB, () =>
        database
          .select()
          .from(resourceProjects)
          .where(eq(resourceProjects.id, String(id))),
      ),
    ).toEqual([]);
    // A's own read is still there.
    expect((await store.get(personA, String(id)))?.name).toBe("合同审阅");
  });
});

describe("the current project", () => {
  test("a coworker's current project is chosen, read back, replaced and cleared", async () => {
    const device = await machine(personA);
    const first = await store.create(personA, {
      deviceId: device.id,
      scope: "public",
      agentId: null,
      name: "一",
      description: "",
      source: { kind: "local", rootRef: READ_REF, writable: false },
    });
    const second = await store.create(personA, {
      deviceId: device.id,
      scope: "agent",
      agentId: botX,
      name: "二",
      description: "",
      source: { kind: "local", rootRef: WRITE_REF, writable: true },
    });
    const choose = (projectId: string | null) =>
      call<One>(personA, "PUT", "/current", {
        deviceId: device.id,
        agentId: botX,
        projectId,
      });
    expect((await choose(first.id)).status).toBe(200);
    const read = async () =>
      (
        await call<{ currentProjectId: string | null }>(
          personA,
          "GET",
          `/?device=${device.id}&agent=${botX}`,
        )
      ).body.currentProjectId;
    expect(await read()).toBe(first.id);
    expect((await choose(second.id)).status).toBe(200);
    expect(await read()).toBe(second.id);
    expect((await choose(null)).status).toBe(200);
    expect(await read()).toBeNull();
    // A Team Bot of this person's can work in a public project too.
    expect(
      (
        await call<One>(personA, "PUT", "/current", {
          deviceId: device.id,
          agentId: teamBot,
          projectId: first.id,
        })
      ).status,
    ).toBe(200);
    expect((await store.current(personA, device.id, teamBot))?.id).toBe(
      first.id,
    );
  });

  test("acceptance 2: binding coworker Y to coworker X's own project is refused by the API and by the database's policy", async () => {
    const device = await machine(personA);
    const xs = await store.create(personA, {
      deviceId: device.id,
      scope: "agent",
      agentId: botX,
      name: "X 的",
      description: "",
      source: { kind: "local", rootRef: READ_REF, writable: false },
    });
    const viaApi = await call<One>(personA, "PUT", "/current", {
      deviceId: device.id,
      agentId: botY,
      projectId: xs.id,
    });
    expect(viaApi.status).toBe(403);
    const direct = await runAsTenant(personA, () =>
      database
        .insert(projectContextBindings)
        .values({
          tenantId: personA,
          deviceId: device.id,
          agentId: botY,
          projectId: xs.id,
        })
        .catch((error: unknown) => error),
    );
    expect(
      String((direct as Error & { cause?: Error }).cause ?? direct),
    ).toMatch(/row-level security/);
  });

  test("acceptance 3: a binding on one machine to a project on another is refused by the API and by the database's policy", async () => {
    const here = await machine(personA);
    const there = await machine(personA);
    const project = await store.create(personA, {
      deviceId: there.id,
      scope: "public",
      agentId: null,
      name: "那台电脑上的",
      description: "",
      source: { kind: "local", rootRef: READ_REF, writable: false },
    });
    const viaApi = await call<One>(personA, "PUT", "/current", {
      deviceId: here.id,
      agentId: botX,
      projectId: project.id,
    });
    expect(viaApi.status).toBe(400);
    expect(viaApi.body.error).toContain("另一台设备");
    const direct = await runAsTenant(personA, () =>
      database
        .insert(projectContextBindings)
        .values({
          tenantId: personA,
          deviceId: here.id,
          agentId: botX,
          projectId: project.id,
        })
        .catch((error: unknown) => error),
    );
    expect(
      String((direct as Error & { cause?: Error }).cause ?? direct),
    ).toMatch(/row-level security/);
  });

  test("a public project made one coworker's own leaves the other coworkers' bindings behind", async () => {
    const device = await machine(personA);
    const project = await store.create(personA, {
      deviceId: device.id,
      scope: "public",
      agentId: null,
      name: "收窄",
      description: "",
      source: { kind: "local", rootRef: READ_REF, writable: false },
    });
    await store.choose(personA, device.id, botX, project.id);
    await store.choose(personA, device.id, botY, project.id);
    const narrowed = await call<One>(personA, "PATCH", `/${project.id}`, {
      revision: 1,
      scope: "agent",
      agentId: botX,
    });
    expect(narrowed.status).toBe(200);
    expect((await store.current(personA, device.id, botX))?.id).toBe(
      project.id,
    );
    expect(await store.current(personA, device.id, botY)).toBeNull();
  });

  test("acceptance 6: removing the machine removes its projects and every binding to them", async () => {
    const device = await machine(personA);
    const project = await store.create(personA, {
      deviceId: device.id,
      scope: "public",
      agentId: null,
      name: "随设备删除",
      description: "",
      source: { kind: "local", rootRef: READ_REF, writable: false },
    });
    await store.choose(personA, device.id, botX, project.id);
    expect(await devices.remove(personA, device.id)).toBe(true);
    const left = await runAsTenant(personA, async () => ({
      projects: await database
        .select()
        .from(resourceProjects)
        .where(eq(resourceProjects.deviceId, device.id)),
      bindings: await database
        .select()
        .from(projectContextBindings)
        .where(eq(projectContextBindings.deviceId, device.id)),
    }));
    expect(left).toEqual({ projects: [], bindings: [] });
  });

  test("deleting a project deletes the bindings to it, so no coworker is left in a project that is gone", async () => {
    const device = await machine(personA);
    const project = await store.create(personA, {
      deviceId: device.id,
      scope: "public",
      agentId: null,
      name: "删除",
      description: "",
      source: { kind: "local", rootRef: READ_REF, writable: false },
    });
    await store.choose(personA, device.id, botX, project.id);
    expect((await call(personA, "DELETE", `/${project.id}`)).status).toBe(200);
    expect(await store.current(personA, device.id, botX)).toBeNull();
  });
});

describe("Git projects", () => {
  test("a sync asks the machine with the stored address and branch, and records the clone's reference and commit", async () => {
    const device = await machine(personA);
    const made = await call<One>(personA, "POST", "/", gitBody(device.id));
    expect(made.status).toBe(201);
    expect(made.body.project?.source).toEqual({
      kind: "git",
      url: "https://git.example.test/web/site.git",
      branch: "main",
      rootRef: null,
      writable: true,
      syncedAt: null,
      commit: null,
    });
    sent.length = 0;
    online = true;
    const synced = await call<One>(
      personA,
      "POST",
      `/${made.body.project?.id}/sync`,
      { url: "file:///etc", branch: "evil" },
    );
    expect(synced.status).toBe(200);
    expect(sent).toEqual([
      {
        target: { tenantId: personA, deviceId: device.runnerId },
        action: PROJECT_SYNC_ACTION,
        payload: {
          rootRef: null,
          url: "https://git.example.test/web/site.git",
          branch: "main",
        },
      },
    ]);
    expect(synced.body.project?.source).toMatchObject({
      rootRef: OTHER_REF,
      commit: COMMIT,
    });
    const syncedSource = synced.body.project?.source;
    if (syncedSource?.kind !== "git") throw new Error("not a Git project");
    expect(Number.isNaN(Date.parse(String(syncedSource.syncedAt)))).toBe(false);

    // A branch change keeps the clone and forgets the commit until the next sync.
    const moved = await call<One>(
      personA,
      "PATCH",
      `/${made.body.project?.id}`,
      { revision: synced.body.project?.revision, branch: "release/1.0" },
    );
    expect(moved.body.project?.source).toMatchObject({
      branch: "release/1.0",
      rootRef: OTHER_REF,
      commit: null,
      syncedAt: null,
    });
  });

  test("RES2-4 acceptance 3: a machine that is offline is not asked; the person is told why", async () => {
    const device = await machine(personA);
    const made = await call<One>(personA, "POST", "/", gitBody(device.id));
    sent.length = 0;
    online = false;
    const sync = await call<One>(
      personA,
      "POST",
      `/${made.body.project?.id}/sync`,
    );
    const branches = await call<One>(personA, "POST", "/branches", {
      deviceId: device.id,
      url: "https://git.example.test/web/site.git",
    });
    online = true;
    expect([sync.status, branches.status]).toEqual([409, 409]);
    expect(sync.body.error).toContain("离线");
    expect(sent).toEqual([]);
  });

  test("the branch list comes from the machine, and only names survive", async () => {
    const device = await machine(personA);
    const refused = await call<One>(personA, "POST", "/branches", {
      deviceId: device.id,
      url: "file:///srv/repo",
    });
    expect(refused.status).toBe(400);
    const listed = await call<{ branches: string[] }>(
      personA,
      "POST",
      "/branches",
      { deviceId: device.id, url: "git@git.example.test:web/site.git" },
    );
    expect(listed.status).toBe(200);
    expect(listed.body.branches).toEqual(["main", "release/1.0"]);
  });

  test("a local project cannot be synced", async () => {
    const device = await machine(personA);
    const made = await store.create(personA, {
      deviceId: device.id,
      scope: "public",
      agentId: null,
      name: "本地",
      description: "",
      source: { kind: "local", rootRef: READ_REF, writable: false },
    });
    expect((await call(personA, "POST", `/${made.id}/sync`)).status).toBe(400);
  });
});
