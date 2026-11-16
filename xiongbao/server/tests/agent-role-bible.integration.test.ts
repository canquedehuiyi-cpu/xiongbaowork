import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  personaTemplates,
  roleTemplates,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { avatarAgentId } from "../src/tenant/provisioning";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Story ROLE1, stage 1 (docs/specs/2026-11-04-role1-role-templates.md §5 ROLE1-1): a coworker's
 * 工作手册 and the role template it was taken from, on the real database under row-level security.
 *
 * The routes are the server's own, signed in through a stub that opens the person's frame the way the
 * session middleware does. The migration's persona-template copy is read from the file and run
 * verbatim, as the application role, inside a transaction that is rolled back.
 */
const url = testDatabaseUrl();
const database = createDatabase(url, TEST_POOL);
const managed = new URL("https://managed.example.test/ag-ui");
const store = createAgentProfileStore(database, managed);
const unmanaged = createAgentProfileStore(database, undefined);
const run = randomUUID().slice(0, 8);
const people: string[] = [];
const agentIds: string[] = [];

const MIGRATION = await Bun.file(
  new URL(
    "../recovery/recovery-20261018-v1/sql/0133_role_profiles.sql",
    import.meta.url,
  ),
).text();
const STATEMENTS = MIGRATION.split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

function ownerConnection(): SQL {
  const raw = process.env.TEST_DATABASE_ADMIN_URL?.trim();
  if (!raw) {
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must name the database owner, who runs the migration's copy.",
    );
  }
  const admin = new URL(raw);
  const target = new URL(url);
  return new SQL({
    adapter: "postgres",
    hostname: admin.hostname,
    port: admin.port ? Number(admin.port) : 5432,
    username: decodeURIComponent(admin.username),
    password: decodeURIComponent(admin.password),
    database: decodeURIComponent(target.pathname.replace(/^\//, "")),
    max: 1,
  });
}
const owner = ownerConnection();

afterAll(async () => {
  await runAsTenant("platform", async () => {
    for (const id of agentIds) {
      await database.delete(agents).where(eq(agents.id, id));
    }
  });
  for (const person of people) {
    await runAsTenant(person, async () => {
      await database
        .delete(roleTemplates)
        .where(eq(roleTemplates.ownerUserId, person));
      await database
        .delete(personaTemplates)
        .where(eq(personaTemplates.tenantId, person));
    });
    await runAsTenant("platform", () =>
      database.delete(users).where(eq(users.id, person)),
    );
  }
  await database.$client.close();
  await owner.close();
});

async function person(label: string): Promise<AgentActor> {
  const id = `role1-${run}-${label}-${randomUUID().slice(0, 6)}`;
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

function request(
  actor: AgentActor,
  method: "POST" | "PATCH" | "GET",
  path: string,
  body?: unknown,
  profiles = store,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createAgentRoutes(profiles, signedInAs(actor)));
  return app.request(`http://test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

const form = {
  name: "后端小熊",
  title: "后端工程师",
  roleDescription: "按需求写实现、跑测试。",
  visibility: "private",
};

async function createCoworker(actor: AgentActor, body: object = form) {
  const response = await request(actor, "POST", "/", body);
  expect(response.status).toBe(201);
  const { agent } = (await response.json()) as {
    agent: {
      id: string;
      bible: string | null;
      roleTemplate: { id: string; version: number } | null;
      acceptsRoleTemplate: boolean;
    };
  };
  agentIds.push(agent.id);
  return agent;
}

async function storedRow(actor: AgentActor, agentId: string) {
  return runAsTenant(actor.id, async () => {
    const [row] = await database
      .select({
        bible: agentProfiles.bible,
        roleTemplateId: agentProfiles.roleTemplateId,
        roleTemplateVersion: agentProfiles.roleTemplateVersion,
        configuration: agents.configuration,
      })
      .from(agentProfiles)
      .innerJoin(agents, eq(agents.id, agentProfiles.agentId))
      .where(eq(agentProfiles.agentId, agentId));
    return row;
  });
}

async function template(actor: AgentActor, name: string, version = 1) {
  return runAsTenant(actor.id, async () => {
    const [row] = await database
      .insert(roleTemplates)
      .values({
        ownerUserId: actor.id,
        name,
        profile: {
          identity: { title: "", roleDescription: "" },
          persona: { tone: "", principles: "", habits: "" },
          bible: "",
        },
        version,
      })
      .returning({ id: roleTemplates.id });
    if (!row) throw new Error("template not inserted");
    return row.id;
  });
}

describe("ROLE1-1: the Bible on a coworker", () => {
  test("PATCH writes the Bible, refuses one over 8000 characters, and an update without it keeps it", async () => {
    const actor = await person("writer");
    const agent = await createCoworker(actor);
    expect(agent.bible).toBeNull();
    expect(agent.roleTemplate).toBeNull();

    const written = await request(actor, "PATCH", `/${agent.id}`, {
      ...form,
      bible: "  # 术语表\n\nPR：合并请求。  ",
    });
    expect(written.status).toBe(200);
    const body = (await written.json()) as { agent: { bible: string } };
    expect(body.agent.bible).toBe("# 术语表\n\nPR：合并请求。");

    // 8000 is the limit, counted as the database counts: one emoji is one character, not two.
    const atLimit = "熊".repeat(7999) + "🐻";
    const ok = await request(actor, "PATCH", `/${agent.id}`, {
      ...form,
      bible: atLimit,
    });
    expect(ok.status).toBe(200);
    expect((await storedRow(actor, agent.id))?.bible).toBe(atLimit);

    const tooLong = await request(actor, "PATCH", `/${agent.id}`, {
      ...form,
      bible: `${atLimit}多`,
    });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { error: string }).error).toBe(
      "手册不能超过 8000 字。",
    );
    expect((await storedRow(actor, agent.id))?.bible).toBe(atLimit);

    const notText = await request(actor, "PATCH", `/${agent.id}`, {
      ...form,
      bible: 42,
    });
    expect(notText.status).toBe(400);

    // An edit that never sent the field leaves the handbook alone.
    const retitled = await request(actor, "PATCH", `/${agent.id}`, {
      ...form,
      title: "资深后端工程师",
    });
    expect(retitled.status).toBe(200);
    expect((await storedRow(actor, agent.id))?.bible).toBe(atLimit);

    // Null and blank both clear it.
    await request(actor, "PATCH", `/${agent.id}`, { ...form, bible: "   " });
    expect((await storedRow(actor, agent.id))?.bible).toBeNull();
  });

  test("the database refuses a handbook over the limit even when the route is bypassed", async () => {
    const actor = await person("bypass");
    const agent = await createCoworker(actor);
    await expect(
      runAsTenant(actor.id, async () => {
        await database
          .update(agentProfiles)
          .set({ bible: "x".repeat(8001) })
          .where(eq(agentProfiles.agentId, agent.id));
      }),
    ).rejects.toThrow();
  });

  test("the database refuses a template id without a version, and a version without an id", async () => {
    const actor = await person("pair");
    const agent = await createCoworker(actor);
    const templateId = await template(actor, "后端工程师");
    for (const half of [
      { roleTemplateId: templateId, roleTemplateVersion: null },
      { roleTemplateId: null, roleTemplateVersion: 1 },
      { roleTemplateId: templateId, roleTemplateVersion: 0 },
    ]) {
      await expect(
        runAsTenant(actor.id, async () => {
          await database
            .update(agentProfiles)
            .set(half)
            .where(eq(agentProfiles.agentId, agent.id));
        }),
      ).rejects.toThrow();
    }
    // Both together is the shape the store writes.
    await runAsTenant(actor.id, () =>
      database
        .update(agentProfiles)
        .set({ roleTemplateId: templateId, roleTemplateVersion: 1 })
        .where(eq(agentProfiles.agentId, agent.id)),
    );
    expect(await storedRow(actor, agent.id)).toMatchObject({
      roleTemplateId: templateId,
      roleTemplateVersion: 1,
    });
  });

  test("a built_in coworker takes a Bible without its systemPrompt changing", async () => {
    const actor = await person("builtin");
    // Shaped like the 分身: it runs on a systemPrompt that is not its role description.
    const agentId = `role1-${run}-builtin-${randomUUID().slice(0, 6)}`;
    agentIds.push(agentId);
    await runAsTenant(actor.id, async () => {
      await database.insert(agents).values({
        id: agentId,
        name: "我的分身",
        type: "built_in",
        configuration: { systemPrompt: "你是用户的个人分身。" },
      });
      await database.insert(agentProfiles).values({
        agentId,
        ownerUserId: actor.id,
        title: "个人分身",
        roleDescription: "代表你本人收集和整理工作信息。",
        avatarSeed: agentId,
        visibility: "private",
      });
    });
    const avatarForm = {
      name: "我的分身",
      title: "个人分身",
      roleDescription: "代表你本人收集和整理工作信息。",
      visibility: "private",
    };
    const response = await request(
      actor,
      "PATCH",
      `/${agentId}`,
      { ...avatarForm, bible: "周报写在飞书的「工作 / 周报」里。" },
      unmanaged,
    );
    expect(response.status).toBe(200);
    const { agent } = (await response.json()) as {
      agent: { bible: string; acceptsRoleTemplate: boolean };
    };
    expect(agent.bible).toBe("周报写在飞书的「工作 / 周报」里。");
    // D4, revised 2026-11-04: only the 分身 itself is refused a template, and this is not it.
    expect(agent.acceptsRoleTemplate).toBe(true);
    const row = await storedRow(actor, agentId);
    expect(row?.bible).toBe("周报写在飞书的「工作 / 周报」里。");
    expect(row?.configuration).toEqual({
      systemPrompt: "你是用户的个人分身。",
    });

    // Changing the role description is still what moves the prompt such a coworker runs on.
    await request(
      actor,
      "PATCH",
      `/${agentId}`,
      { ...avatarForm, roleDescription: "新的职责。" },
      unmanaged,
    );
    expect((await storedRow(actor, agentId))?.configuration).toEqual({
      systemPrompt: "新的职责。",
    });
    expect((await storedRow(actor, agentId))?.bible).toBe(
      "周报写在飞书的「工作 / 周报」里。",
    );
  });

  test("a new coworker records the template it started from, only if it is the creator's", async () => {
    const actor = await person("creator");
    const stranger = await person("stranger");
    const own = await template(actor, "代码审核员", 3);
    const theirs = await template(stranger, "代码审核员", 1);

    const created = await createCoworker(actor, {
      ...form,
      bible: "审核清单：测试、命名、边界。",
      roleTemplate: { id: own, version: 3 },
    });
    expect(created.roleTemplate).toEqual({ id: own, version: 3 });
    expect(created.bible).toBe("审核清单：测试、命名、边界。");
    expect(created.acceptsRoleTemplate).toBe(true);

    // Another person's template reads as absent under row security, as does a version not yet written.
    for (const roleTemplate of [
      { id: theirs, version: 1 },
      { id: own, version: 4 },
    ]) {
      const refused = await request(actor, "POST", "/", {
        ...form,
        roleTemplate,
      });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toBe(
        "所选角色模板不存在或已被删除，请重新选择。",
      );
    }
    const malformed = await request(actor, "POST", "/", {
      ...form,
      roleTemplate: { id: "not-a-uuid", version: 1 },
    });
    expect(malformed.status).toBe(400);

    // A coworker that runs here on its systemPrompt records its template too (D4, revised 2026-11-04).
    const builtIn = await request(
      actor,
      "POST",
      "/",
      { ...form, roleTemplate: { id: own, version: 3 } },
      unmanaged,
    );
    expect(builtIn.status).toBe(201);
    const { agent } = (await builtIn.json()) as {
      agent: {
        id: string;
        roleTemplate: unknown;
        acceptsRoleTemplate: boolean;
      };
    };
    agentIds.push(agent.id);
    expect(agent.roleTemplate).toEqual({ id: own, version: 3 });
    expect(agent.acceptsRoleTemplate).toBe(true);

    // A copy carries the handbook and, for the template's own owner, where it came from.
    const copied = await request(actor, "POST", `/${created.id}/duplicate`);
    expect(copied.status).toBe(201);
    const copy = (
      (await copied.json()) as {
        agent: { id: string; bible: string; roleTemplate: unknown };
      }
    ).agent;
    agentIds.push(copy.id);
    expect(copy.bible).toBe("审核清单：测试、命名、边界。");
    expect(copy.roleTemplate).toEqual({ id: own, version: 3 });
  });
});

describe("ROLE1-1: applying a role to a coworker in the store", () => {
  const role = {
    title: "代码审核员",
    roleDescription: "审查合并请求，指出风险。",
    persona: { tone: "直接", principles: "先读测试", habits: "不说空话" },
    bible: "# 审核清单\n\n- 测试\n- 命名",
  };

  test("it replaces identity, persona and Bible, records the source, and keeps the rest", async () => {
    const actor = await person("apply");
    const agent = await createCoworker(actor, {
      ...form,
      avatarSeed: "bear-1",
    });
    const templateId = await template(actor, "代码审核员", 2);
    const applied = await runAsTenant(actor.id, () =>
      store.applyRole(actor, agent.id, role, { id: templateId, version: 2 }),
    );
    expect(applied).toMatchObject({
      name: form.name,
      avatarSeed: "bear-1",
      modelRef: null,
      title: role.title,
      roleDescription: role.roleDescription,
      persona: role.persona,
      bible: role.bible,
      roleTemplate: { id: templateId, version: 2 },
    });
    // A version the template has not reached is refused, and nothing changes.
    await expect(
      runAsTenant(actor.id, () =>
        store.applyRole(
          actor,
          agent.id,
          { ...role, title: "别的" },
          { id: templateId, version: 3 },
        ),
      ),
    ).rejects.toThrow("所选角色模板不存在或已被删除，请重新选择。");
    expect((await storedRow(actor, agent.id))?.roleTemplateVersion).toBe(2);
  });

  test("a built_in coworker that is not the 分身 takes a template, and its prompt moves with the role (D4, revised 2026-11-04)", async () => {
    const actor = await person("apply-builtin");
    const response = await request(actor, "POST", "/", form, unmanaged);
    const { agent } = (await response.json()) as { agent: { id: string } };
    agentIds.push(agent.id);
    const templateId = await template(actor, "代码审核员");
    const applied = await runAsTenant(actor.id, () =>
      unmanaged.applyRole(actor, agent.id, role, {
        id: templateId,
        version: 1,
      }),
    );
    expect(applied).toMatchObject({
      roleDescription: role.roleDescription,
      persona: role.persona,
      bible: role.bible,
      roleTemplate: { id: templateId, version: 1 },
      acceptsRoleTemplate: true,
    });
    // It runs on its systemPrompt alone, so the template's role description is what it now runs on.
    expect(await storedRow(actor, agent.id)).toMatchObject({
      bible: role.bible,
      roleTemplateId: templateId,
      roleTemplateVersion: 1,
      configuration: { systemPrompt: role.roleDescription },
    });

    // A template that leaves the role description as it is leaves the prompt alone too.
    const personaOnly = await template(actor, "只换语气");
    await runAsTenant(actor.id, () =>
      unmanaged.applyRole(
        actor,
        agent.id,
        { ...role, persona: { tone: "温和", principles: "", habits: "" } },
        { id: personaOnly, version: 1 },
      ),
    );
    expect((await storedRow(actor, agent.id))?.configuration).toEqual({
      systemPrompt: role.roleDescription,
    });
  });

  test("the 分身 is still refused a template and keeps everything (D4)", async () => {
    const actor = await person("apply-avatar");
    const agentId = avatarAgentId(actor.id);
    agentIds.push(agentId);
    await runAsTenant(actor.id, async () => {
      await database.insert(agents).values({
        id: agentId,
        name: "我的分身",
        type: "built_in",
        configuration: { systemPrompt: "你是用户的个人分身。" },
      });
      await database.insert(agentProfiles).values({
        agentId,
        ownerUserId: actor.id,
        title: "个人分身",
        roleDescription: "代表你本人收集和整理工作信息。",
        avatarSeed: agentId,
        visibility: "private",
      });
    });
    const read = await runAsTenant(actor.id, () =>
      unmanaged.get(actor, agentId),
    );
    expect(read?.acceptsRoleTemplate).toBe(false);
    const templateId = await template(actor, "代码审核员");
    await expect(
      runAsTenant(actor.id, () =>
        unmanaged.applyRole(actor, agentId, role, {
          id: templateId,
          version: 1,
        }),
      ),
    ).rejects.toThrow("我的分身不能套用角色模板");
    expect(await storedRow(actor, agentId)).toEqual({
      bible: null,
      roleTemplateId: null,
      roleTemplateVersion: null,
      configuration: { systemPrompt: "你是用户的个人分身。" },
    });
    expect(
      await runAsTenant(actor.id, () => unmanaged.get(actor, agentId)),
    ).toMatchObject({
      title: "个人分身",
      roleDescription: "代表你本人收集和整理工作信息。",
      persona: null,
      roleTemplate: null,
    });
  });

  test("another person cannot apply a role to a coworker they cannot manage", async () => {
    const actor = await person("apply-owner");
    const other = await person("apply-other");
    const agent = await createCoworker(actor, {
      ...form,
      visibility: "public",
    });
    const theirs = await template(other, "代码审核员");
    await expect(
      runAsTenant(other.id, () =>
        store.applyRole(other, agent.id, role, { id: theirs, version: 1 }),
      ),
    ).rejects.toThrow();
    expect((await storedRow(actor, agent.id))?.roleTemplateId).toBeNull();
  });
});

/** Thrown to unwind the transaction, so the copy never touches the shared database's rows. */
class Rollback extends Error {}

describe("ROLE1-1: migration 0133 copies the old persona templates", () => {
  test("it adds the three columns and their checks, and leaves the dormant tables' structure alone", () => {
    expect(MIGRATION).toContain(
      'ALTER TABLE "public"."agent_profiles" ADD COLUMN "bible" text;',
    );
    expect(MIGRATION).toContain('ADD COLUMN "role_template_id" uuid;');
    expect(MIGRATION).toContain('ADD COLUMN "role_template_version" integer;');
    // Only data goes into role_templates: no ALTER, policy, grant or FORCE change on any 0082 table.
    const code = MIGRATION.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const table of [
      "role_templates",
      "employee_role_snapshots",
      "role_generation_requests",
      "role_write_receipts",
    ]) {
      expect(code).not.toMatch(
        new RegExp(`(ALTER|DROP|GRANT|REVOKE)[^;]*"?${table}"?`, "i"),
      );
      expect(code).not.toMatch(new RegExp(`POLICY[^;]*ON[^;]*${table}`, "i"));
    }
  });

  test("a tenant's two persona templates become two role templates of the same names, once", async () => {
    const copy = STATEMENTS.find((statement) => statement.startsWith("DO $$"));
    if (!copy) throw new Error("0133 has no persona-template copy.");
    const tenant = `role1-${run}-mig-${randomUUID().slice(0, 6)}`;
    const other = `role1-${run}-mig2-${randomUUID().slice(0, 6)}`;
    let seen:
      | { first: string[]; second: string[]; other: string[] }
      | undefined;
    try {
      await owner.begin(async (tx) => {
        await tx`insert into users (id, email, name) values
          (${tenant}, ${`${tenant}@role1.test`}, 'm'),
          (${other}, ${`${other}@role1.test`}, 'o')`;
        // Bound by row security like the application, which FORCE also does to a non-superuser owner.
        await tx`set local role openbot_app`;
        for (const [owning, name, tone] of [
          [tenant, "细心的审核员", "直接"],
          [tenant, "耐心的导师", "温和"],
          [other, "别人的人设", "冷静"],
        ] as const) {
          await tx`select set_config('app.tenant_id', ${owning}, true)`;
          await tx`insert into persona_templates (tenant_id, name, persona)
            values (${owning}, ${name}, ${JSON.stringify({ tone, principles: "先读代码", habits: "" })}::text::jsonb)`;
        }
        // A `team` row is never a person's template, so it is skipped.
        await tx`select set_config('app.tenant_id', 'platform', true)`;
        await tx`insert into persona_templates (tenant_id, name, persona)
          values ('team', ${`team-${run}`}, '{"tone":"","principles":"","habits":""}'::jsonb)`;

        const names = async (owning: string) => {
          await tx`select set_config('app.tenant_id', ${owning}, true)`;
          const rows = await tx`select name, profile, version, owner_user_id
            from role_templates where tenant_id = ${owning} order by name`;
          return rows as {
            name: string;
            profile: unknown;
            version: number;
            owner_user_id: string;
          }[];
        };

        await tx.unsafe(copy);
        const first = await names(tenant);
        expect(first.map((row) => row.version)).toEqual([1, 1]);
        expect(first.every((row) => row.owner_user_id === tenant)).toBe(true);
        expect(
          first.find((row) => row.name === "细心的审核员")?.profile,
        ).toEqual({
          identity: { title: "", roleDescription: "" },
          persona: { tone: "直接", principles: "先读代码", habits: "" },
          bible: "",
        });
        // The copy statement again: nothing new.
        await tx.unsafe(copy);
        const second = await names(tenant);
        await tx`select set_config('app.tenant_id', 'platform', true)`;
        const team =
          await tx`select count(*)::int as n from role_templates where tenant_id = 'team'`;
        expect(team[0]?.n).toBe(0);
        seen = {
          first: first.map((row) => row.name).sort(),
          second: second.map((row) => row.name).sort(),
          other: (await names(other)).map((row) => row.name),
        };
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    expect(seen).toEqual({
      first: ["细心的审核员", "耐心的导师"].sort(),
      second: ["细心的审核员", "耐心的导师"].sort(),
      other: ["别人的人设"],
    });
  });
});
