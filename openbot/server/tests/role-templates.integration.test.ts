import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { emptyRoleProfile, type RoleProfile } from "../../shared/role-profile";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agents,
  personaTemplates,
  roleTemplates,
  users,
} from "../src/db/schema";
import { createPersonaRoutes } from "../src/personas/routes";
import { createPersonaTemplateStore } from "../src/personas/store";
import { createRoleTemplateRoutes } from "../src/roles/routes";
import {
  createRoleTemplateStore,
  officialTemplatesFrom,
} from "../src/roles/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Story ROLE1, stage 2 (spec §5 ROLE1-2): the role template library, applying a template to a
 * coworker, the "新版本" notice, and `/api/personas` as a compatibility layer over it. Real database,
 * every request in the signed-in person's frame, the server's own routes.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const managed = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const unmanaged = createAgentProfileStore(database, undefined);
const run = randomUUID().slice(0, 8);
const people: string[] = [];
const agentIds: string[] = [];

const official = officialTemplatesFrom([
  {
    id: "backend-engineer",
    name: "后端工程师",
    title: "Backend Engineer",
    roleDescription: "按需求写实现、跑测试。",
    type: "built_in",
    configuration: { systemPrompt: "你是一名后端工程师。先读现有代码再动手。" },
  },
  {
    id: "remote-reviewer",
    name: "远程审核员",
    title: "Reviewer",
    roleDescription: "审差异。",
    type: "remote_ag_ui",
    configuration: { endpoint: "https://reviewer.example.test/ag-ui" },
  },
]);

afterAll(async () => {
  await runAsTenant("platform", async () => {
    for (const id of agentIds) {
      await database.delete(agents).where(eq(agents.id, id));
    }
  });
  for (const id of people) {
    await runAsTenant(id, async () => {
      await database
        .delete(personaTemplates)
        .where(eq(personaTemplates.tenantId, id));
      await database
        .delete(roleTemplates)
        .where(eq(roleTemplates.ownerUserId, id));
    });
    await runAsTenant("platform", () =>
      database.delete(users).where(eq(users.id, id)),
    );
  }
  await database.$client.close();
});

async function person(label: string): Promise<AgentActor> {
  const id = `role1-tpl-${run}-${label}-${randomUUID().slice(0, 6)}`;
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@role1.test`, name: label }),
  );
  people.push(id);
  return { id, role: "user" };
}

function signedInAs(
  actor: AgentActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { ...actor, email: `${actor.id}@role1.test` });
    await runAsTenant(actor.id, () => next());
  };
}

function client(actor: AgentActor, profiles = managed) {
  const app = new Hono<{ Variables: AppVariables }>();
  const signedIn = signedInAs(actor);
  app.route("/api/agents", createAgentRoutes(profiles, signedIn));
  app.route(
    "/api/role-templates",
    createRoleTemplateRoutes(
      createRoleTemplateStore({
        database,
        profiles,
        official: () => official,
      }),
      signedIn,
    ),
  );
  app.route(
    "/api/personas",
    createPersonaRoutes(createPersonaTemplateStore(database), signedIn),
  );
  return async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`http://test${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    });
    const text = await response.text();
    return {
      status: response.status,
      // biome-ignore lint/suspicious/noExplicitAny: test reads loosely-shaped JSON bodies.
      body: (text ? JSON.parse(text) : null) as any,
    };
  };
}

const reviewer: RoleProfile = {
  identity: {
    title: "代码审核员",
    roleDescription: "审查合并请求，指出风险。",
  },
  persona: { tone: "直接", principles: "先读测试", habits: "不说空话" },
  bible: "# 审核清单\n\n- 测试\n- 命名",
};

const form = {
  name: "小审",
  title: "实习生",
  roleDescription: "什么都做一点。",
  visibility: "private",
  avatarSeed: "bear-7",
};

async function coworker(call: ReturnType<typeof client>, body: object = form) {
  const created = await call("POST", "/api/agents", body);
  expect(created.status).toBe(201);
  agentIds.push(created.body.agent.id);
  return created.body.agent as { id: string };
}

describe("the template library", () => {
  test("create, list beside the official ones, read, and refuse a duplicate name", async () => {
    const call = client(await person("lib"));
    const created = await call("POST", "/api/role-templates", {
      name: "  代码审核员 ",
      profile: reviewer,
    });
    expect(created.status).toBe(201);
    expect(created.body.template).toMatchObject({
      name: "代码审核员",
      version: 1,
      profile: reviewer,
      official: false,
    });

    const listed = await call("GET", "/api/role-templates");
    expect(listed.body.templates.map((t: { name: string }) => t.name)).toEqual([
      "代码审核员",
    ]);
    // D5: the package's seed cards, read-only and never stored.
    expect(listed.body.official).toEqual([
      {
        id: "official:backend-engineer",
        name: "后端工程师",
        version: 1,
        official: true,
        profile: {
          identity: {
            title: "Backend Engineer",
            roleDescription: "按需求写实现、跑测试。",
          },
          persona: {
            tone: "",
            principles: "你是一名后端工程师。先读现有代码再动手。",
            habits: "",
          },
          bible: "",
        },
      },
      {
        id: "official:remote-reviewer",
        name: "远程审核员",
        version: 1,
        official: true,
        profile: {
          ...emptyRoleProfile(),
          identity: { title: "Reviewer", roleDescription: "审差异。" },
        },
      },
    ]);

    const read = await call(
      "GET",
      `/api/role-templates/${created.body.template.id}`,
    );
    expect(read.body.template.profile).toEqual(reviewer);

    const again = await call("POST", "/api/role-templates", {
      name: "代码审核员",
      profile: reviewer,
    });
    expect(again.status).toBe(409);

    for (const bad of [
      { name: "", profile: reviewer },
      { name: "长".repeat(81), profile: reviewer },
      { name: "坏", profile: { ...reviewer, bible: "册".repeat(8001) } },
      { name: "坏", profile: "not an object" },
    ]) {
      expect((await call("POST", "/api/role-templates", bad)).status).toBe(400);
    }
    expect((await call("GET", "/api/role-templates/not-a-uuid")).status).toBe(
      404,
    );
  });

  test("an edit on a stale version is 409 and changes nothing; a good one is version + 1", async () => {
    const call = client(await person("ver"));
    const { body } = await call("POST", "/api/role-templates", {
      name: "后端",
      profile: reviewer,
    });
    const id = body.template.id;
    const first = await call("PUT", `/api/role-templates/${id}`, {
      profile: { ...reviewer, bible: "v2" },
      version: 1,
    });
    expect(first.status).toBe(200);
    expect(first.body.template).toMatchObject({ version: 2, name: "后端" });

    const stale = await call("PUT", `/api/role-templates/${id}`, {
      name: "改名",
      profile: { ...reviewer, bible: "from a stale tab" },
      version: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.version).toBe(2);
    const after = await call("GET", `/api/role-templates/${id}`);
    expect(after.body.template).toMatchObject({ version: 2, name: "后端" });
    expect(after.body.template.profile.bible).toBe("v2");

    const renamed = await call("PUT", `/api/role-templates/${id}`, {
      name: "资深后端",
      profile: reviewer,
      version: 2,
    });
    expect(renamed.body.template).toMatchObject({
      version: 3,
      name: "资深后端",
    });
    expect(
      (await call("PUT", `/api/role-templates/${id}`, { profile: reviewer }))
        .status,
    ).toBe(400);
  });

  test("another person reads, edits, applies and deletes none of it: 404", async () => {
    const callA = client(await person("a"));
    const b = await person("b");
    const callB = client(b);
    const { body } = await callA("POST", "/api/role-templates", {
      name: "A 的模板",
      profile: reviewer,
    });
    const id = body.template.id;
    const mine = await coworker(callB);

    expect((await callB("GET", `/api/role-templates/${id}`)).status).toBe(404);
    expect(
      (
        await callB("PUT", `/api/role-templates/${id}`, {
          profile: reviewer,
          version: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await callB("POST", `/api/role-templates/${id}/apply`, {
          agentId: mine.id,
          version: 1,
        })
      ).status,
    ).toBe(404);
    expect((await callB("DELETE", `/api/role-templates/${id}`)).status).toBe(
      404,
    );
    expect((await callB("GET", "/api/role-templates")).body.templates).toEqual(
      [],
    );
    // Still A's, untouched.
    expect(
      (await callA("GET", `/api/role-templates/${id}`)).body.template,
    ).toMatchObject({ version: 1, name: "A 的模板" });
  });
});

describe("a template and the coworkers made from it", () => {
  test("applying replaces identity, persona and Bible, records the source, and keeps the rest", async () => {
    const call = client(await person("apply"));
    const agent = await coworker(call);
    const { body } = await call("POST", "/api/role-templates", {
      name: "代码审核员",
      profile: reviewer,
    });
    const templateId = body.template.id;

    const applied = await call(
      "POST",
      `/api/role-templates/${templateId}/apply`,
      { agentId: agent.id, version: 1 },
    );
    expect(applied.status).toBe(200);
    expect(applied.body.status).toEqual({
      acceptsRoleTemplate: true,
      source: {
        id: templateId,
        version: 1,
        name: "代码审核员",
        latestVersion: 1,
        hasUpdate: false,
        modified: false,
      },
    });
    const read = (await call("GET", `/api/agents/${agent.id}`)).body.agent;
    expect(read).toMatchObject({
      name: form.name,
      avatarSeed: form.avatarSeed,
      modelRef: null,
      platformModelRef: null,
      title: reviewer.identity.title,
      roleDescription: reviewer.identity.roleDescription,
      persona: reviewer.persona,
      bible: reviewer.bible,
      roleTemplate: { id: templateId, version: 1 },
    });

    // An edit by hand keeps the source and is reported as a change on top of it.
    await call("PATCH", `/api/agents/${agent.id}`, {
      ...form,
      title: read.title,
      roleDescription: read.roleDescription,
      bible: `${reviewer.bible}\n- 文档`,
    });
    const edited = await call(
      "GET",
      `/api/role-templates/employees/${agent.id}`,
    );
    expect(edited.body.source).toMatchObject({ version: 1, modified: true });
  });

  test("after the template moves to v2 the coworker is told so, and its content stays until updated", async () => {
    const call = client(await person("newer"));
    const agent = await coworker(call);
    const { body } = await call("POST", "/api/role-templates", {
      name: "后端工程师",
      profile: reviewer,
    });
    const templateId = body.template.id;
    await call("POST", `/api/role-templates/${templateId}/apply`, {
      agentId: agent.id,
      version: 1,
    });
    const v2 = { ...reviewer, bible: "# 新版手册" };
    await call("PUT", `/api/role-templates/${templateId}`, {
      profile: v2,
      version: 1,
    });

    const status = await call(
      "GET",
      `/api/role-templates/employees/${agent.id}`,
    );
    expect(status.body).toEqual({
      acceptsRoleTemplate: true,
      source: {
        id: templateId,
        version: 1,
        name: "后端工程师",
        latestVersion: 2,
        hasUpdate: true,
        modified: null,
      },
    });
    // D2: no automatic follow.
    expect(
      (await call("GET", `/api/agents/${agent.id}`)).body.agent,
    ).toMatchObject({
      bible: reviewer.bible,
      roleTemplate: { id: templateId, version: 1 },
    });

    // Updating from the old version's diff is refused; from the new one it lands.
    const stale = await call(
      "POST",
      `/api/role-templates/${templateId}/apply`,
      {
        agentId: agent.id,
        version: 1,
      },
    );
    expect(stale.status).toBe(409);
    const updated = await call(
      "POST",
      `/api/role-templates/${templateId}/apply`,
      {
        agentId: agent.id,
        version: 2,
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.agent).toMatchObject({
      bible: "# 新版手册",
      roleTemplate: { id: templateId, version: 2 },
    });
    expect(updated.body.status.source).toMatchObject({
      hasUpdate: false,
      modified: false,
    });
  });

  test("a template with an empty identity keeps the coworker's own title and role description", async () => {
    const call = client(await person("persona-only"));
    const agent = await coworker(call);
    const { body } = await call("POST", "/api/role-templates", {
      name: "耐心的导师",
      profile: { ...emptyRoleProfile(), persona: reviewer.persona },
    });
    const applied = await call(
      "POST",
      `/api/role-templates/${body.template.id}/apply`,
      {
        agentId: agent.id,
        version: 1,
      },
    );
    expect(applied.body.agent).toMatchObject({
      title: form.title,
      roleDescription: form.roleDescription,
      persona: reviewer.persona,
      bible: null,
    });
    expect(applied.body.status.source.modified).toBe(false);
  });

  test("a built_in coworker is refused a template with 400 (D4)", async () => {
    const actor = await person("builtin");
    const call = client(actor, unmanaged);
    const agent = await coworker(call);
    const { body } = await call("POST", "/api/role-templates", {
      name: "代码审核员",
      profile: reviewer,
    });
    const refused = await call(
      "POST",
      `/api/role-templates/${body.template.id}/apply`,
      {
        agentId: agent.id,
        version: 1,
      },
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("内置员工");
    expect(
      (await call("GET", `/api/role-templates/employees/${agent.id}`)).body,
    ).toEqual({
      acceptsRoleTemplate: false,
      source: null,
    });
    expect(
      (await call("GET", `/api/agents/${agent.id}`)).body.agent.title,
    ).toBe(form.title);
  });

  test("deleting a template keeps the coworker's content and clears its source", async () => {
    const call = client(await person("delete"));
    const agent = await coworker(call);
    const { body } = await call("POST", "/api/role-templates", {
      name: "临时",
      profile: reviewer,
    });
    await call("POST", `/api/role-templates/${body.template.id}/apply`, {
      agentId: agent.id,
      version: 1,
    });
    expect(
      (await call("DELETE", `/api/role-templates/${body.template.id}`)).status,
    ).toBe(200);
    const read = (await call("GET", `/api/agents/${agent.id}`)).body.agent;
    expect(read).toMatchObject({ bible: reviewer.bible, roleTemplate: null });
    expect(
      (await call("GET", `/api/role-templates/employees/${agent.id}`)).body,
    ).toEqual({
      acceptsRoleTemplate: true,
      source: null,
    });
    expect(
      (await call("GET", "/api/role-templates/employees/nobody")).status,
    ).toBe(404);
  });
});

describe("/api/personas over the role templates (D6)", () => {
  test("a persona saved through it is a role template's persona, and saving again moves its version", async () => {
    const actor = await person("compat");
    const call = client(actor);
    const persona = { tone: "温和", principles: "先问清楚", habits: "" };
    const saved = await call("POST", "/api/personas", {
      name: "导师",
      persona,
    });
    expect(saved.status).toBe(201);
    const templates = (await call("GET", "/api/role-templates")).body.templates;
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      id: saved.body.template.id,
      name: "导师",
      version: 1,
      profile: { ...emptyRoleProfile(), persona },
    });

    // A role template's identity and handbook survive a persona saved over it by name.
    await call("PUT", `/api/role-templates/${templates[0].id}`, {
      profile: { ...reviewer, persona },
      version: 1,
    });
    await call("POST", "/api/personas", {
      name: "导师",
      persona: { ...persona, habits: "不打断" },
    });
    const after = (await call("GET", `/api/role-templates/${templates[0].id}`))
      .body.template;
    expect(after.version).toBe(3);
    expect(after.profile).toEqual({
      ...reviewer,
      persona: { ...persona, habits: "不打断" },
    });
  });

  test("the list also shows a persona still in the old table, the role template winning a shared name", async () => {
    const actor = await person("legacy");
    const call = client(actor);
    await runAsTenant(actor.id, () =>
      database.insert(personaTemplates).values([
        { name: "旧的", persona: { tone: "旧", principles: "", habits: "" } },
        { name: "同名", persona: { tone: "旧表", principles: "", habits: "" } },
      ]),
    );
    await call("POST", "/api/role-templates", {
      name: "同名",
      profile: {
        ...emptyRoleProfile(),
        persona: { tone: "新表", principles: "", habits: "" },
      },
    });
    const listed = (await call("GET", "/api/personas")).body.templates as {
      id: string;
      name: string;
      persona: { tone: string };
    }[];
    expect(listed.map((entry) => [entry.name, entry.persona.tone])).toEqual(
      [
        ["同名", "新表"],
        ["旧的", "旧"],
      ].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    );
    // And an old row can still be removed by the id the list gave.
    const legacy = listed.find((entry) => entry.name === "旧的");
    expect((await call("DELETE", `/api/personas/${legacy?.id}`)).status).toBe(
      200,
    );
    expect(
      (
        (await call("GET", "/api/personas")).body.templates as {
          name: string;
        }[]
      ).map((entry) => entry.name),
    ).toEqual(["同名"]);
  });
});
