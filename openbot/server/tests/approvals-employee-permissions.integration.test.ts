import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { TOOL_DISABLED } from "../src/approvals/policy";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import type { ApprovalCandidate } from "../src/approvals/types";
import { createAdminScope } from "../src/auth/admin-scope";
import { createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, approvalTeamSettings } from "../src/db/schema";
import { users } from "../src/db/schema/core";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * SEC1 §4.5 over HTTP, against real tables and row security: a Bot's permissions page reads and
 * writes per-tool modes (直接 / 询问 / 禁用) and the dangerous-command and sensitive-path floors, only
 * its owner changes them, a teammate who uses the Bot reads the owner's settings (D9), and only an
 * administrator changes the team's 强制危险命令审批 switch (D10).
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `employee-perm-${randomUUID()}`;
const owner = `${prefix}-owner`;
const member = `${prefix}-member`;
const admin = `${prefix}-admin`;
const teamBot = `${prefix}-team-bot`;
const privateBot = `${prefix}-private-bot`;
const store = createApprovalStore(database);
const service = createApprovalService(store);
const scope = createAdminScope({
  roleRepository: createRoleRepository(database),
});
let releaseRoleWriter: (() => Promise<void>) | undefined;
let priorTeam: typeof approvalTeamSettings.$inferSelect | undefined;
const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

/** A signed-in request, in the person's own frame, the way the app's session middleware runs it. */
function client(id: string, role: "user" | "admin" = "user") {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/approvals",
    createApprovalRoutes(
      service,
      async (context, next) => {
        context.set("actor", { id, role });
        await runAsTenant(id, () => next());
      },
      scope.adminCapability,
    ),
  );
  return async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`http://openbot.test/api/approvals${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
}
const asOwner = client(owner);
const asMember = client(member);
const asAdmin = client(admin, "admin");

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database.insert(users).values(
      [owner, member, admin].map((id) => ({ id, email: `${id}@example.test` })),
    );
    [priorTeam] = await database
      .select()
      .from(approvalTeamSettings)
      .where(eq(approvalTeamSettings.id, "team"));
    await setRole(database, admin, "admin");
    await database.insert(agents).values({
      id: teamBot,
      tenantId: "team",
      name: "Desk",
      type: "built_in",
      configuration: {},
    });
    await database.insert(agents).values({
      id: privateBot,
      tenantId: owner,
      name: "Mine",
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: privateBot,
      tenantId: owner,
      ownerUserId: owner,
      title: "Mine",
      roleDescription: "Private.",
      avatarSeed: "seed",
      visibility: "private",
    });
    await database.insert(agentProfiles).values({
      agentId: teamBot,
      tenantId: "team",
      ownerUserId: owner,
      title: "Desk",
      roleDescription: "Shared desk.",
      avatarSeed: "seed",
      visibility: "public",
    });
  });
});
afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(approvalTeamSettings)
      .where(eq(approvalTeamSettings.id, "team"));
    if (priorTeam) await database.insert(approvalTeamSettings).values(priorTeam);
    await database.delete(agents).where(inArray(agents.id, [teamBot, privateBot]));
    await database.delete(users).where(inArray(users.id, [owner, member, admin]));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

function call(actorId: string, toolRef: string): ApprovalCandidate {
  const toolCallId = randomUUID();
  return {
    actorId,
    botId: teamBot,
    toolRef,
    effect: "write",
    scope: "workspace",
    args: { command: "ls" },
    continuation: {
      runId: randomUUID(),
      threadId: `${prefix}-${toolCallId}`,
      toolCallId,
      toolName: toolRef,
      args: { command: "ls" },
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
  };
}

test("the owner sets a tool to 禁用, a teammate using the Bot is refused and sees it as the owner's setting", async () => {
  const before = await asOwner("GET", `/employees/${teamBot}`);
  expect(before.status).toBe(200);
  expect(before.body).toMatchObject({
    editable: true,
    ownedByAnother: false,
    modes: [],
    security: { dangerousCommands: "ask", sensitivePaths: "ask" },
  });
  expect(before.body.defaultSensitivePaths).toContain(".env*");

  const saved = await asOwner("PUT", `/employees/${teamBot}/tools`, {
    toolRef: "computer_run_command",
    mode: "disabled",
  });
  expect(saved.status).toBe(200);
  expect(saved.body.rule).toMatchObject({
    botId: teamBot,
    toolRef: "computer_run_command",
    effect: "*",
    scope: "*",
    behaviour: "deny",
  });
  await expect(
    runAsTenant(member, () => service.gate(call(member, "computer_run_command"))),
  ).rejects.toThrow(TOOL_DISABLED);

  const seen = await asMember("GET", `/employees/${teamBot}`);
  expect(seen.body).toMatchObject({
    editable: false,
    ownedByAnother: true,
    modes: [{ toolRef: "computer_run_command", behaviour: "deny" }],
  });
  const refused = await asMember("PUT", `/employees/${teamBot}/tools`, {
    toolRef: "computer_run_command",
    mode: "direct",
  });
  expect(refused.status).toBe(400);
  expect(String(refused.body.error)).toContain("owner");
  await expect(
    runAsTenant(member, () => service.gate(call(member, "computer_run_command"))),
  ).rejects.toThrow(TOOL_DISABLED);
});

test("changing a mode replaces the rule; 默认 removes it", async () => {
  await asOwner("PUT", `/employees/${teamBot}/tools`, {
    toolRef: "computer_write_file",
    mode: "direct",
  });
  await asOwner("PUT", `/employees/${teamBot}/tools`, {
    toolRef: "computer_write_file",
    mode: "ask",
  });
  const live = (await runAsTenant(owner, () => store.rules(owner))).filter(
    (rule) => rule.botId === teamBot && rule.toolRef === "computer_write_file",
  );
  expect(live.map((rule) => rule.behaviour)).toEqual(["ask"]);
  await asOwner("PUT", `/employees/${teamBot}/tools`, {
    toolRef: "computer_write_file",
    mode: "default",
  });
  expect(
    (await runAsTenant(owner, () => store.rules(owner))).filter(
      (rule) => rule.botId === teamBot && rule.toolRef === "computer_write_file",
    ),
  ).toEqual([]);
  expect(
    (
      await asOwner("PUT", `/employees/${teamBot}/tools`, {
        toolRef: "computer_write_file",
        mode: "sometimes",
      })
    ).status,
  ).toBe(400);
});

test("the floors: defaults can be switched off but not removed, added paths are checked, only the owner saves", async () => {
  const saved = await asOwner("PATCH", `/employees/${teamBot}/security`, {
    dangerousCommands: "off",
    disabledDefaultPaths: [".env*", ".env*"],
    extraSensitivePaths: ["config/prod/**"],
  });
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({
    dangerousCommands: "off",
    sensitivePaths: "ask",
    disabledDefaultPaths: [".env*"],
    extraSensitivePaths: ["config/prod/**"],
  });
  // A default stays a default: there is no way to name something else as one to switch off.
  for (const body of [
    { disabledDefaultPaths: ["src/**"] },
    { extraSensitivePaths: ["/etc/passwd"] },
    { extraSensitivePaths: ["$(rm -rf)"] },
    { dangerousPatterns: ["curl"] },
    {},
  ])
    expect(
      (await asOwner("PATCH", `/employees/${teamBot}/security`, body)).status,
    ).toBe(400);
  const memberTry = await asMember("PATCH", `/employees/${teamBot}/security`, {
    sensitivePaths: "off",
  });
  expect(memberTry.status).toBe(400);
  const seen = await asMember("GET", `/employees/${teamBot}`);
  expect(seen.body.security).toMatchObject({
    dangerousCommands: "off",
    sensitivePaths: "ask",
  });
  // The owner's added path binds the teammate's run.
  const reading = call(member, "computer_read_file");
  reading.effect = "read";
  reading.target = { filePath: "config/prod/db.yaml" };
  await expect(
    runAsTenant(member, () => service.gate(reading)),
  ).rejects.toMatchObject({ name: "HeadlessToolSuspension" });
});

test("only an administrator changes the team's 强制危险命令审批 switch, and it shows on the Bot's page", async () => {
  expect(
    (await asMember("PATCH", "/team", { enforceDangerousCommands: true })).status,
  ).toBe(403);
  const changed = await asAdmin("PATCH", "/team", {
    enforceDangerousCommands: true,
  });
  expect(changed.status).toBe(200);
  expect(changed.body).toMatchObject({ enforceDangerousCommands: true });
  expect(
    (await asOwner("GET", `/employees/${teamBot}`)).body,
  ).toMatchObject({ enforceDangerousCommands: true });
  await asAdmin("PATCH", "/team", { enforceDangerousCommands: false });
});

test("with custom rules off, a tool can still be asked about or disabled, but not set to run directly (D6)", async () => {
  await asAdmin("PATCH", "/team", { customRulesEnabled: false });
  try {
    expect(
      (
        await asOwner("PUT", `/employees/${teamBot}/tools`, {
          toolRef: "mcp/gmail/send_email",
          mode: "direct",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await asOwner("PUT", `/employees/${teamBot}/tools`, {
          toolRef: "mcp/gmail/send_email",
          mode: "disabled",
        })
      ).status,
    ).toBe(200);
    await expect(
      runAsTenant(member, () => service.gate(call(member, "mcp/gmail/send_email"))),
    ).rejects.toThrow(TOOL_DISABLED);
  } finally {
    await asAdmin("PATCH", "/team", { customRulesEnabled: true });
  }
});

test("another person's private Bot is not found, and its settings are not read out", async () => {
  await asOwner("PUT", `/employees/${privateBot}/tools`, {
    toolRef: "computer_click",
    mode: "disabled",
  });
  expect((await asOwner("GET", `/employees/${privateBot}`)).body).toMatchObject({
    editable: true,
    modes: [{ toolRef: "computer_click", behaviour: "deny" }],
  });
  const stranger = await asMember("GET", `/employees/${privateBot}`);
  expect(stranger.status).toBe(404);
  expect(JSON.stringify(stranger.body)).not.toContain("computer_click");
  expect((await asMember("GET", `/employees/${prefix}-nobody`)).status).toBe(404);
});
