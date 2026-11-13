import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, sql } from "drizzle-orm";
import { MCPMock } from "@copilotkit/aimock/mcp";
import { createAgentProfileStore } from "../src/agents/profile-store";
import {
  createHandoffDesk,
  HANDOFF_KIND,
} from "../src/agents/handoff";
import { createHandoffRunner } from "../src/agents/handoff-runner";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents as agentTable,
  credentials,
  mcpServers,
  mcpTools,
  pluginGrants,
  skills as skillTable,
  skillTools,
  users,
  workItems,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { grantedSkills } from "../src/plugins/tools";
import { pickedSkillGuidance } from "../src/plugins/picked-skill";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import {
  loadTenantPackage,
  synchronizeTenantPackage,
} from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * L0, from the package files to a tool call, in one piece (移植方案 §8 L3).
 *
 * Every stage here has its own suite: the sync is unit-tested with synthetic packages, the skill
 * pick with private skills, the desk with synthetic Bots, the connectors with catalogue apps. A
 * chain of green units is not a green chain — the seams between them are exactly where a real
 * package stops matching what the fixtures assumed, and one did: the assembler writes a skill's
 * `runnable` grade under `_porting`, the loader read only a top-level `runnable`, and every
 * audited-blocked skill of the ported package loaded as `full` until this file walked the whole
 * path and found it.
 *
 * The real package under test is `examples/xiongbao`, by a path resolved from THIS FILE, not from
 * the working directory: a test's truth must not depend on where bun happened to be started.
 * Only the model is played. Everything else — the files, the sync, row security, the queue, the
 * MCP wire — is the deployment's own code against PostgreSQL.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const OWNER = `port-l0-owner-${suite}`;
/** The vault and the store must seal and read with the same key. */
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const auditRows: { eventType: string; payload: Record<string, unknown> }[] = [];
const persisting = createAuditStore(database);
const auditStore = {
  insert: async (event: Parameters<typeof persisting.insert>[0]) => {
    auditRows.push({
      eventType: event.eventType,
      payload: (event.payload ?? {}) as Record<string, unknown>,
    });
    await persisting.insert(event);
  },
};

const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const queue = createWorkQueue(database);

const pluginStore = createPluginStore({
  database,
  auditStore,
  credentials: createCredentialStore(database),
  encryptionKey: ENCRYPTION_KEY,
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

/** The deployment's own grant check, read per hop: `index.ts` builds exactly this. */
const desk = createHandoffDesk({
  queue,
  profiles,
  actorFor: async (id) => ({ id, role: "user" as const }),
  mayAddress: async (fromBotId, toBotId) =>
    (
      await pluginStore
        .botsReachableFrom(fromBotId)
        .catch(() => [] as string[])
    ).includes(toBotId),
  auditStore,
  caps: { maxDepth: 2, maxPerRun: 3 },
});

/*
 * The package, by a path anchored to this file. `../examples/xiongbao` would be read against the
 * working directory, which is whoever started bun's choice, not the test's.
 */
const loaded = await loadTenantPackage(
  fileURLToPath(new URL("../../examples/xiongbao", import.meta.url)),
);

/*
 * The tapd connector declares `credential_env: TAPD_MCP_CREDENTIAL_ID`, and the value being set is
 * what turns 「待绑定」into a bound server: the sync stores it through the vault and stamps the
 * server row. Set before the sync, unset after the file, as a deployment's environment is.
 */
const TAPD_TOKEN = `port-l0-tapd-token-${suite}`;
process.env.TAPD_MCP_CREDENTIAL_ID = TAPD_TOKEN;

await runAsTenant("platform", () =>
  synchronizeTenantPackage(database, loaded, [], {
    encryptionKey: ENCRYPTION_KEY,
    credentials: createCredentialStore(database),
  }),
);

await runAsTenant("platform", () =>
  database
    .insert(users)
    .values({ id: OWNER, email: `${OWNER}@example.test`, name: OWNER })
    .onConflictDoNothing(),
);

const packageAgentIds = loaded.agents.map((agent) => agent.id);
const packageSkillSlugs = loaded.skills.map((skill) => skill.slug);

const agentRows = () =>
  runAsTenant("platform", () =>
    database
      .select({ id: agentTable.id })
      .from(agentTable)
      .where(inArray(agentTable.id, packageAgentIds)),
  );

const skillRow = async (slug: string) =>
  (
    await runAsTenant("platform", () =>
      database
        .select({ id: skillTable.id, runnable: skillTable.runnable })
        .from(skillTable)
        .where(eq(skillTable.id, slug))
        .limit(1),
    )
  )[0];

const botGrant = async () =>
  (
    await runAsTenant("platform", () =>
      database
        .select()
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, "bot"),
            eq(pluginGrants.agentId, "software-team-lead"),
            eq(pluginGrants.ref, "software-product-manager"),
          ),
        )
        .limit(1),
    )
  )[0];

const refusals = (reason: string) =>
  auditRows.filter(
    (row) =>
      row.eventType === "agent.handoff_refused" &&
      row.payload.reason === reason,
  );

/** A hop from the lead, as the run the lead is in would send it. */
const leadSends = (depth: number) =>
  runAsTenant(OWNER, () =>
    desk.send({
      from: {
        botId: "software-team-lead",
        actorId: OWNER,
        runId: `run-${suite}`,
        threadId: `thread-${suite}`,
        depth,
      },
      target: "software-product-manager",
      envelope: {
        task: "把登录页的验收标准整理成一份可勾选的清单",
        expecting: "一份验收清单",
      },
    }),
  );

afterAll(async () => {
  await runAsTenant("platform", async () => {
    // The hop rows this file queued, by the actor their payload carries (a hop's key is a hash
    // pair, so a prefix matches nothing — the same sweep agent-handoff-endtoend uses).
    await database
      .delete(workItems)
      .where(sql`${workItems.payload}->>'actorId' = ${OWNER}`);
    // What the tool listing of the mock left behind: a redeploy refreshes it from the real URL,
    // so a stale row is a dead name, and a dead name in a picker is worse than none.
    await database.delete(mcpTools).where(eq(mcpTools.serverId, "tapd"));
    // The credential this file's environment bound, and the pointer to it: the row is this
    // suite's plaintext, nobody else's.
    await database
      .update(mcpServers)
      .set({ credentialId: null })
      .where(eq(mcpServers.id, "tapd"));
    await database
      .delete(credentials)
      .where(eq(credentials.keyId, "mcp-tapd"));
    // The tool grant the lead held, in the owner's frame where it was written.
    await database
      .delete(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "mcp"),
          eq(pluginGrants.agentId, "software-team-lead"),
          eq(pluginGrants.ref, "tapd/list_issues"),
        ),
      );
  });
  await runAsTenant(OWNER, async () => {
    await database
      .delete(pluginGrants)
      .where(and(eq(pluginGrants.kind, "mcp"), eq(pluginGrants.agentId, "software-team-lead")));
  });
  await runAsTenant("platform", () =>
    database.delete(users).where(eq(users.id, OWNER)),
  );
  delete process.env.TAPD_MCP_CREDENTIAL_ID;
  await database.$client.close();
});

describe("the ported package, end to end", () => {
  test("every one of the package's 28 员工 is on the roster, with a unique avatar seed", async () => {
    expect(loaded.agents).toHaveLength(28);
    expect(await agentRows()).toHaveLength(28);

    const seeded = await runAsTenant("platform", () =>
      database
        .select({ agentId: agentProfiles.agentId, seed: agentProfiles.avatarSeed })
        .from(agentProfiles)
        .where(inArray(agentProfiles.agentId, packageAgentIds)),
    );
    expect(seeded).toHaveLength(28);
    expect(new Set(seeded.map((row) => row.seed)).size).toBe(28);
  });

  test("the audit's grades reach the database: 35 blocked skills are blocked, not silently full", async () => {
    /*
     * The gap this chain exists to catch: the assembler writes the grade under `_porting`, the
     * loader used to read only a top-level `runnable`, and the whole package loaded as `full` —
     * 35 「暂不可用」skills advertised as 完整可用. `docs/porting/tool-ref-audit.md` is the table
     * this count must agree with.
     */
    const blocked = loaded.skills.filter(
      (skill) => skill.runnable === "blocked",
    );
    expect(blocked).toHaveLength(35);
    expect(blocked.map((skill) => skill.slug)).toContain("bot-creator");

    // Every slug the package declares landed, with the grade the audit gave it.
    const rows = await runAsTenant("platform", () =>
      database
        .select({ id: skillTable.id, runnable: skillTable.runnable })
        .from(skillTable)
        .where(inArray(skillTable.id, packageSkillSlugs)),
    );
    expect(rows).toHaveLength(loaded.skills.length);
    const gradeOf = new Map(rows.map((row) => [row.id, row.runnable]));
    for (const skill of loaded.skills) {
      expect(gradeOf.get(skill.slug)).toBe(skill.runnable);
    }
    expect((await skillRow("bot-creator"))?.runnable).toBe("blocked");
  });

  test("a picked skill's instructions reach the run, and declaring tools grants none", async () => {
    // The run's own frame: a person types `/bot-creator …` to a Bot that holds the skill.
    const held = await runAsTenant(OWNER, () =>
      grantedSkills({ store: pluginStore, botId: "general-assistant" }),
    );
    expect(held.map((skill) => skill.slug)).toContain("bot-creator");

    const guidance = pickedSkillGuidance(
      {
        messages: [
          { id: "q", role: "user" as const, content: "/bot-creator 帮我造一个员工" },
        ],
      },
      held,
    );
    expect(guidance).toContain("bot-creator");
    // The instructions are the package's own stored text, not a guess from the name: a sentence
    // that exists only inside the skill body.
    expect(guidance).toContain("mcp__staffing__list_staff");

    // A declaration is a selector, not a grant (§4): no package skill declares a tool into
    // existence, so nothing is offered because a skill named it.
    const declared = await runAsTenant("platform", () =>
      database
        .select({ ref: skillTools.ref })
        .from(skillTools)
        .where(inArray(skillTools.skillId, packageSkillSlugs)),
    );
    expect(declared).toEqual([]);

    const offered = await runAsTenant(OWNER, () =>
      pluginStore.listForAgent("general-assistant"),
    );
    const granted = new Set(
      (
        await runAsTenant(OWNER, () =>
          database
            .select({ ref: pluginGrants.ref })
            .from(pluginGrants)
            .where(
              and(
                eq(pluginGrants.kind, "mcp"),
                eq(pluginGrants.agentId, "general-assistant"),
              ),
            ),
        )
      ).map((row) => row.ref),
    );
    for (const tool of offered.tools) {
      expect(granted.has(tool.ref)).toBe(true);
    }
  });

  test("a team lead hands work to a member, and what allows it is the grant the package wrote", async () => {
    const outcome = await leadSends(0);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.to).toBe("software-product-manager");

    // The hop is a row, and only a row: the asking run and the delivery never speak directly.
    const queued = await runAsTenant("platform", () =>
      database
        .select({ payload: workItems.payload })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, HANDOFF_KIND),
            sql`${workItems.payload}->>'actorId' = ${OWNER}`,
          ),
        ),
    );
    expect(
      queued.some((row) => JSON.stringify(row.payload).includes("software-product-manager")),
    ).toBe(true);

    // Another replica, sharing nothing but the row: the delivery reads what the ask wrote.
    const delivered: { work: { toBotId: string; threadId: string } }[] = [];
    const runner = createHandoffRunner({
      queue: createWorkQueue(database),
      owner: `replica-${suite}`,
      sign: () => "signed",
      auditStore,
      delivery: {
        deliver: async ({ work }) => {
          delivered.push({ work });
          return { answer: null };
        },
      },
    });
    await runner.sweep();
    expect(
      delivered.some(
        ({ work }) =>
          work.toBotId === "software-product-manager" &&
          work.threadId === `thread-${suite}`,
      ),
    ).toBe(true);

    // The grant is the whole contract. Take it away, the same ask is refused — and the refusal is
    // an answer, not an error, with its reason on the trail.
    const grant = await botGrant();
    expect(grant).toBeDefined();
    await runAsTenant("platform", () =>
      database
        .delete(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, "bot"),
            eq(pluginGrants.agentId, "software-team-lead"),
            eq(pluginGrants.ref, "software-product-manager"),
          ),
        ),
    );
    const refused = await leadSends(0);
    expect(refused.ok).toBe(false);
    expect(refusals("not_granted").length).toBeGreaterThan(0);

    // Leave the deployment as it was found: the package's own grant, restored verbatim.
    await runAsTenant("platform", () => database.insert(pluginGrants).values(grant!));
    const restored = await botGrant();
    expect(restored).toBeDefined();
  });

  test("a chain stops at the depth cap, however politely it asks", async () => {
    // depth 2 with maxDepth 2: A asked B, B asked C, and C reaching for D is where it stops.
    const outcome = await leadSends(2);
    expect(outcome.ok).toBe(false);
    const hits = refusals("depth_cap");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.payload.bot).toBe("software-team-lead");
  });

  test("a declared connector binds a credential, lists, grants a tool, and calls it", async () => {
    // Bound, not 「待绑定」: the sync read credential_env through the vault this file handed it.
    const [server] = await runAsTenant("platform", () =>
      database
        .select({ id: mcpServers.id, credentialId: mcpServers.credentialId })
        .from(mcpServers)
        .where(eq(mcpServers.id, "tapd"))
        .limit(1),
    );
    expect(server).toBeDefined();
    expect(server?.credentialId).not.toBeNull();

    // The real MCP wire, against a mock that speaks the protocol: the package's URL is where the
    // deployment would go, and this file answers there.
    const mock = new MCPMock();
    mock.addTool({
      name: "list_issues",
      description: "List the issues a project holds.",
      inputSchema: { type: "object", properties: {} },
    });
    mock.onToolCall("list_issues", () => "3 open issues on the board");
    const mockUrl = await mock.start();
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input instanceof Request ? input.url : input);
      if (target.startsWith("https://websocket.tapd.cn")) {
        return realFetch(mockUrl, init);
      }
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      // The administrator's refresh, as the Plugins page runs it.
      await runAsTenant("platform", () =>
        pluginStore.refreshTools("tapd", OWNER),
      );
      const listed = await runAsTenant("platform", () =>
        database
          .select({ name: mcpTools.name })
          .from(mcpTools)
          .where(eq(mcpTools.serverId, "tapd")),
      );
      expect(listed.map((row) => row.name)).toContain("list_issues");

      // Granting is still an administrator's decision; the package never granted a tool.
      await runAsTenant(OWNER, () =>
        pluginStore.grant(
          "mcp",
          "tapd/list_issues",
          "software-team-lead",
          OWNER,
        ),
      );

      // The employee calls it, and the answer crosses the wire both ways.
      const result = await runAsTenant(OWNER, () =>
        pluginStore.callTool({
          ref: "tapd/list_issues",
          args: {},
          botId: "software-team-lead",
          actorId: OWNER,
        }),
      );
      expect(result.isError).toBe(false);
      expect(result.text).toBe("3 open issues on the board");
    } finally {
      globalThis.fetch = realFetch;
      await mock.stop?.();
    }
  });
});
