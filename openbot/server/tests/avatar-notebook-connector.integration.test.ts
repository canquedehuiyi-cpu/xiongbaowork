import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  AVATAR_SOURCE_LIMIT,
  avatarSourcesForActor,
  createAvatarSourceRoutes,
  createAvatarSourceStore,
} from "../src/avatar-sources";
import { avatarSourcesGuidance } from "../src/copilot";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  approvalRules,
  auditEvents,
  avatarSources,
  credentials,
  knowledgeBindings,
  knowledgeNotebooks,
  mcpServers,
  mcpTools,
  pluginGrants,
  subscriptions,
  users,
} from "../src/db/schema";
import { createKnowledgeStore } from "../src/knowledge/store";
import { knowledgeTools } from "../src/knowledge/tools";
import { createPluginStore } from "../src/plugins/store";
import { grantedTools, REFUSAL_MARKER } from "../src/plugins/tools";
import { runAsTenant } from "../src/tenant/context";
import { avatarAgentId, provisionTenant } from "../src/tenant/provisioning";
import { untrustedNotice } from "../src/untrusted-content";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Story F1, stage 3: a person's own knowledge notebook (S3) and their own connected account (S4) as
 * information sources of their 分身.
 *
 * Against the real database with row security on, with three people, through the real stores that
 * own the access: RES1's knowledge store and its two tools, and the plugin store with its grants,
 * the real SEC1 approval service as its gate, and a vendor double that records whether anything was
 * sent. No model, no OAuth exchange and no vendor is reached: every refusal asserted here stops
 * before the network, and a connection is the vault row a consent would have written.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const personA = `avk-${suite}-a`;
const personB = `avk-${suite}-b`;
const personC = `avk-${suite}-c`;
const everyone = [personA, personB, personC];
const emailOf = (person: string) => `${person}@f1.test`;

/** Two connectors on the deployment, as `team` rows (G01-E P10): one listed for people, one not. */
const drive = `s4drive${suite}`;
const unlisted = `s4wiki${suite}`;
const READ = `${drive}/search_files`;
const WRITE = `${drive}/create_file`;

const knowledge = createKnowledgeStore(database);
const approvalStore = createApprovalStore(database);
const approvals = createApprovalService(approvalStore);
/** What reached the vendor. Every test here expects nothing to. */
const vendorCalls: Array<{ actorId?: string; toolName: string }> = [];
const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  // As index.ts wires it: every connector call goes through the SEC1 gate.
  approvalGate: approvals.gate,
  callVendor: async (connection, toolName) => {
    vendorCalls.push({ actorId: connection.actorId, toolName });
    return { text: "[vendor not reached in tests]", isError: false };
  },
});
const store = createAvatarSourceStore(database, { knowledge, plugins });

const actor =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", { id, email: emailOf(id), role: "user" });
    await runAsTenant(id, () => next());
  };

async function call<T>(
  person: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await createAvatarSourceRoutes(store, actor(person)).request(
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

type Source = {
  id: string;
  kind: string;
  label: string;
  note: string;
  notebookId?: string;
  serverId?: string;
  title?: string;
};
type State = { sources: Source[]; configuredAt: string | null };
type ConnectorOption = {
  serverId: string;
  title: string;
  attached: boolean;
  attachable: boolean;
  reason: string | null;
};

const add = (person: string, body: unknown) =>
  call<{ source?: Source; error?: string }>(person, "POST", "/", body);
const stateOf = async (person: string) =>
  (await call<State>(person, "GET", "/")).body;
const remove = (person: string, id: string) =>
  call<{ removed?: boolean; error?: string }>(person, "DELETE", `/${id}`);
const connectorsOf = async (person: string) =>
  (await call<{ connectors: ConnectorOption[] }>(person, "GET", "/connectors"))
    .body.connectors;

/** A notebook of `person`'s holding one source with `content`. */
async function notebook(person: string, title: string, content: string) {
  return runAsTenant(person, async () => {
    const created = await knowledge.createNotebook(person, { title });
    await knowledge.addSource(person, created.id, {
      title: `${title}资料`,
      content,
    });
    return created.id;
  });
}

/** The knowledge tools a run of `person`'s 分身 is offered right now, by name. */
async function avatarKnowledgeTools(person: string) {
  const tools = await knowledgeTools({
    store: knowledge,
    ownerUserId: person,
    agentId: avatarAgentId(person),
  });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

/** The connector tools a run of `person`'s 分身 holds, through the plugin-grant path. */
const avatarConnectorTools = (person: string) =>
  runAsTenant(person, () =>
    grantedTools({
      store: plugins,
      botId: avatarAgentId(person),
      actorId: person,
    }),
  );

const grantsOn = (person: string) =>
  runAsTenant(person, () =>
    database
      .select({ ref: pluginGrants.ref, grantedBy: pluginGrants.grantedBy })
      .from(pluginGrants)
      .where(eq(pluginGrants.agentId, avatarAgentId(person))),
  );

const bindingsOf = (person: string) =>
  runAsTenant(person, () =>
    database
      .select({
        notebookId: knowledgeBindings.notebookId,
        agentId: knowledgeBindings.agentId,
      })
      .from(knowledgeBindings)
      .where(eq(knowledgeBindings.tenantId, person)),
  );

async function clear(person: string) {
  await runAsTenant(person, async () => {
    await database
      .delete(avatarSources)
      .where(eq(avatarSources.agentId, avatarAgentId(person)));
    await database
      .delete(knowledgeBindings)
      .where(eq(knowledgeBindings.tenantId, person));
    await database
      .delete(pluginGrants)
      .where(eq(pluginGrants.agentId, avatarAgentId(person)));
    await database
      .delete(approvalRules)
      .where(eq(approvalRules.ownerUserId, person));
  });
}

// --- fixtures -------------------------------------------------------------------------------------

for (const person of everyone) {
  await runAsTenant(person, () =>
    database
      .insert(users)
      .values({ id: person, email: emailOf(person), name: person })
      .onConflictDoNothing(),
  );
  await provisionTenant(database, { id: person, email: emailOf(person) });
}

/*
 * The deployment's connectors, written directly rather than through `addServer` so no vendor has to
 * be reachable: what is under test is who may attach them and what the 分身 then holds. One read tool
 * and one write tool on the listed connector, so "only what reads" is visible.
 */
await runAsTenant("platform", async () => {
  for (const [id, title] of [
    [drive, "云盘（测试）"],
    [unlisted, "团队百科（测试）"],
  ] as const) {
    await database.insert(mcpServers).values({
      id,
      tenantId: "team",
      title,
      vendor: "Test",
      url: `https://${id}.example.test/mcp`,
      provenance: "custom",
    });
  }
  await database.insert(mcpTools).values([
    {
      tenantId: "team",
      serverId: drive,
      name: "search_files",
      description: "Search the files of whoever is asking.",
      effect: "read",
    },
    {
      tenantId: "team",
      serverId: drive,
      name: "create_file",
      description: "Create a file.",
      effect: "write",
    },
    {
      tenantId: "team",
      serverId: unlisted,
      name: "search_pages",
      description: "Search pages.",
      effect: "read",
    },
  ]);
});
// Listed (上架) for people to install themselves, as an administrator would.
await runAsTenant("platform", () =>
  plugins.addInstallListing("mcp", drive, "ops@f1.test"),
);
// A and C connected their own accounts; B connected nothing. Each is the vault row a consent writes.
for (const [person, server] of [
  [personA, drive],
  [personA, unlisted],
  [personC, drive],
] as const) {
  await runAsTenant(person, () =>
    plugins.recordConnection({
      serverId: server,
      userId: person,
      refreshToken: `rt-${person}`,
      scope: "read",
    }),
  );
}

afterAll(async () => {
  for (const person of everyone) await clear(person);
  await runAsTenant("platform", () =>
    plugins.removeInstallListing("mcp", drive, "ops@f1.test"),
  );
  // The connector rows take their tools, the people's connections and any source with them.
  await runAsTenant("platform", () =>
    database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [drive, unlisted])),
  );
  for (const person of everyone) {
    await runAsTenant(person, async () => {
      await database.delete(credentials).where(eq(credentials.keyId, person));
      await database
        .delete(knowledgeNotebooks)
        .where(eq(knowledgeNotebooks.ownerUserId, person));
      await database
        .delete(agentProfiles)
        .where(eq(agentProfiles.tenantId, person));
      await database.delete(agents).where(eq(agents.tenantId, person));
      await database
        .delete(subscriptions)
        .where(eq(subscriptions.tenantId, person));
      await database.delete(users).where(eq(users.id, person));
    });
  }
  await database.$client.end({ timeout: 5 });
});

// --- S3: a notebook -------------------------------------------------------------------------------

describe("a notebook as an information source (S3)", () => {
  test("attaching one of your own notebooks binds it to the 分身 read only; the list and the prompt name it", async () => {
    const id = await notebook(personA, "客户纪要", "甲公司的续约时间是三月。");
    expect(await avatarKnowledgeTools(personA)).toEqual(new Map());

    const saved = await add(personA, {
      kind: "notebook",
      notebookId: id,
      note: "每次拜访后更新",
    });
    expect(saved.status).toBe(201);
    // An empty name is the notebook's own.
    expect(saved.body.source).toMatchObject({
      kind: "notebook",
      label: "客户纪要",
      note: "每次拜访后更新",
      notebookId: id,
      title: "客户纪要",
    });
    expect(await bindingsOf(personA)).toEqual([
      { notebookId: id, agentId: avatarAgentId(personA) },
    ]);
    // RES1's own binding, so the knowledge screen shows the 分身 as reading it.
    const forAgent = await runAsTenant(personA, () =>
      knowledge.notebooksForAgent(personA, avatarAgentId(personA)),
    );
    expect(forAgent).toEqual([
      { notebookId: id, title: "客户纪要", accessMode: "read_only" },
    ]);
    expect((await stateOf(personA)).sources.map((s) => s.kind)).toEqual([
      "notebook",
    ]);

    // The prompt names it, inside the untrusted envelope, and points at the knowledge tools.
    const told = await avatarSourcesForActor(store)(personA)(
      avatarAgentId(personA),
    );
    expect(told).toEqual([
      {
        label: "客户纪要",
        note: "每次拜访后更新",
        notebook: { id, title: "客户纪要" },
      },
    ]);
    const guidance = avatarSourcesGuidance(told) ?? "";
    expect(guidance).toContain("search_knowledge");
    expect(guidance).toContain(id);
    expect(guidance).toContain(
      untrustedNotice("information source notebook content"),
    );
    // Not a declaration: the "you have no access" sentence is not what it is told.
    expect(guidance).not.toContain("A declaration gives you no access");
    // Nobody else's Bot is told about it, without a read.
    expect(
      await avatarSourcesForActor(store)(personA)("some-other-bot"),
    ).toEqual([]);
    await clear(personA);
  });

  test("the knowledge tools reach exactly the attached notebooks, and removing the source refuses the next call", async () => {
    const shared = await notebook(personA, "项目甲", "里程碑：九月上线。");
    const kept = await notebook(personA, "私人日记", "里程碑：搬家。");
    const theirs = await notebook(personB, "B 的项目", "里程碑：B 的秘密。");

    const saved = await add(personA, { kind: "notebook", notebookId: shared });
    expect(saved.status).toBe(201);

    const tools = await avatarKnowledgeTools(personA);
    expect([...tools.keys()].sort()).toEqual([
      "list_knowledge",
      "search_knowledge",
    ]);
    const listed = (await tools.get("list_knowledge")?.execute({})) as string;
    expect(listed).toContain("项目甲");
    expect(listed).not.toContain("私人日记");
    expect(listed).not.toContain("B 的项目");

    const found = (await tools
      .get("search_knowledge")
      ?.execute({ query: "里程碑" })) as string;
    expect(found).toContain("九月上线");
    expect(found).not.toContain("搬家");
    expect(found).not.toContain("B 的秘密");
    // Naming a notebook that is not attached, the person's own or anybody else's, is refused.
    for (const other of [kept, theirs]) {
      const refused = (await tools
        .get("search_knowledge")
        ?.execute({ query: "里程碑", notebookId: other })) as string;
      expect(refused.startsWith(REFUSAL_MARKER)).toBe(true);
      expect(refused).not.toContain("搬家");
      expect(refused).not.toContain("B 的秘密");
    }

    // Removing the source takes the binding away first: the tools the run already holds are refused.
    expect((await remove(personA, saved.body.source?.id ?? "")).status).toBe(
      200,
    );
    expect(await bindingsOf(personA)).toEqual([]);
    const after = (await tools
      .get("search_knowledge")
      ?.execute({ query: "里程碑" })) as string;
    expect(after.startsWith(REFUSAL_MARKER)).toBe(true);
    expect(after).not.toContain("九月上线");
    expect(await avatarKnowledgeTools(personA)).toEqual(new Map());
    expect(
      await avatarSourcesForActor(store)(personA)(avatarAgentId(personA)),
    ).toEqual([]);
    // The removal is a fact: the row stays with `revoked_at`, and RES1's trail has the revoke.
    const [row] = await runAsTenant(personA, () =>
      database
        .select({ revokedAt: avatarSources.revokedAt })
        .from(avatarSources)
        .where(eq(avatarSources.id, saved.body.source?.id ?? "")),
    );
    expect(row?.revokedAt).toBeInstanceOf(Date);
    const trail = await runAsTenant(personA, () =>
      database
        .select({ eventType: auditEvents.eventType })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetId, shared),
            like(auditEvents.eventType, "knowledge.binding_%"),
          ),
        ),
    );
    expect(trail.map((entry) => entry.eventType).sort()).toEqual([
      "knowledge.binding_granted",
      "knowledge.binding_revoked",
    ]);
    await clear(personA);
  });

  test("another person's notebook cannot be attached, and their notebook and 分身 are untouched", async () => {
    const theirs = await notebook(personB, "B 的合同", "B 的合同内容。");
    const before = await bindingsOf(personB);

    expect(
      await add(personA, { kind: "notebook", notebookId: theirs }),
    ).toEqual({ status: 404, body: { error: "找不到你的这个知识库。" } });
    // A notebook that does not exist answers the same, so the refusal says nothing about B's.
    expect(
      await add(personA, { kind: "notebook", notebookId: randomUUID() }),
    ).toEqual({ status: 404, body: { error: "找不到你的这个知识库。" } });
    expect(
      await add(personA, { kind: "notebook", notebookId: "not-a-notebook" }),
    ).toEqual({ status: 400, body: { error: "请选择一个你自己的知识库。" } });

    expect((await stateOf(personA)).sources).toEqual([]);
    expect(await bindingsOf(personA)).toEqual([]);
    expect(await bindingsOf(personB)).toEqual(before);
    expect(await avatarKnowledgeTools(personA)).toEqual(new Map());
    // B's own 分身 attaches it fine, which is what makes the refusal above isolation.
    expect(
      (await add(personB, { kind: "notebook", notebookId: theirs })).status,
    ).toBe(201);
    // And A cannot remove B's source by its id.
    const [source] = (await stateOf(personB)).sources;
    expect((await remove(personA, source?.id ?? "")).status).toBe(404);
    expect((await stateOf(personB)).sources).toHaveLength(1);
    await clear(personB);
  });

  test("attaching twice is refused; unbinding on the knowledge screen ends the source, and it can be attached again", async () => {
    const id = await notebook(personA, "周报", "第 45 周：完成迁移。");
    expect(
      (await add(personA, { kind: "notebook", notebookId: id })).status,
    ).toBe(201);
    expect(await add(personA, { kind: "notebook", notebookId: id })).toEqual({
      status: 409,
      body: { error: "这个知识库已经添加过了。" },
    });

    await runAsTenant(personA, () =>
      knowledge.unbind(personA, id, avatarAgentId(personA)),
    );
    // No longer held, so no longer a source: not listed, not told, not counted.
    expect((await stateOf(personA)).sources).toEqual([]);
    expect(
      await avatarSourcesForActor(store)(personA)(avatarAgentId(personA)),
    ).toEqual([]);
    expect(
      (await add(personA, { kind: "notebook", notebookId: id })).status,
    ).toBe(201);

    // Deleting the notebook on the knowledge screen ends it the same way.
    await runAsTenant(personA, async () => {
      const current = await knowledge.getNotebook(personA, id);
      await knowledge.deleteNotebook(personA, id, {
        revision: current.notebook.revision,
      });
    });
    expect((await stateOf(personA)).sources).toEqual([]);
    expect(await avatarKnowledgeTools(personA)).toEqual(new Map());
    await clear(personA);
  });
});

// --- S4: a connector ------------------------------------------------------------------------------

describe("a connector as an information source (S4)", () => {
  test("the picker lists only the person's own connections, and says why one cannot be attached", async () => {
    const byServer = (entries: ConnectorOption[]) =>
      [...entries].sort((left, right) =>
        left.serverId.localeCompare(right.serverId),
      );
    expect(byServer(await connectorsOf(personA))).toEqual([
      {
        serverId: drive,
        title: "云盘（测试）",
        attached: false,
        attachable: true,
        reason: null,
      },
      {
        serverId: unlisted,
        title: "团队百科（测试）",
        attached: false,
        attachable: false,
        reason: "管理员还没有把这个连接器上架给个人使用，暂时不能交给分身。",
      },
    ]);
    // Ordered by title for the picker, whatever order the connections came in.
    expect((await connectorsOf(personA)).map((entry) => entry.title)).toEqual(
      ["云盘（测试）", "团队百科（测试）"].sort((left, right) =>
        left.localeCompare(right, "zh"),
      ),
    );
    // B connected nothing: the deployment's connectors are not B's to attach.
    expect(await connectorsOf(personB)).toEqual([]);
    expect(
      await add(personA, { kind: "connector", serverId: unlisted }),
    ).toEqual({
      status: 400,
      body: {
        error: "管理员还没有把这个连接器上架给个人使用，暂时不能交给分身。",
      },
    });
    expect(await grantsOn(personA)).toEqual([]);
  });

  test("attaching grants the connector's read tools to the 分身 through the plugin grants; removing takes them away at once", async () => {
    expect(await avatarConnectorTools(personA)).toEqual([]);

    const saved = await add(personA, {
      kind: "connector",
      serverId: drive,
      label: "我的云盘",
      note: "合同和报价单",
    });
    expect(saved.status).toBe(201);
    expect(saved.body.source).toMatchObject({
      kind: "connector",
      label: "我的云盘",
      serverId: drive,
      title: "云盘（测试）",
    });
    // Only what reads, written as the person's own self-service grant (the assembly page shows it).
    expect(await grantsOn(personA)).toEqual([
      { ref: READ, grantedBy: emailOf(personA) },
    ]);
    const installedByMe = await runAsTenant(personA, () =>
      plugins.grantsWrittenBy(avatarAgentId(personA), emailOf(personA)),
    );
    expect(installedByMe).toEqual([{ kind: "mcp", ref: READ }]);

    const tools = await avatarConnectorTools(personA);
    expect(tools.map((tool) => tool.name)).toEqual([
      `mcp__${drive}__search_files`,
    ]);
    expect(tools.map((tool) => tool.ref)).not.toContain(WRITE);
    // The picker now says it is attached.
    expect(
      (await connectorsOf(personA)).find((entry) => entry.serverId === drive),
    ).toMatchObject({ attached: true, attachable: false });

    // The prompt names it and the prefix its tools carry, inside the untrusted envelope.
    const told = await avatarSourcesForActor(store)(personA)(
      avatarAgentId(personA),
    );
    expect(told).toEqual([
      {
        label: "我的云盘",
        note: "合同和报价单",
        connector: { title: "云盘（测试）", tools: `mcp__${drive}__` },
      },
    ]);
    const guidance = avatarSourcesGuidance(told) ?? "";
    expect(guidance).toContain(`mcp__${drive}__`);
    expect(guidance).toContain(
      untrustedNotice("information source connector content"),
    );

    expect(await add(personA, { kind: "connector", serverId: drive })).toEqual({
      status: 409,
      body: { error: "这个连接器已经添加过了。" },
    });

    // Removed: the grant goes, the run's tool is refused before anything is sent, nothing is told.
    expect((await remove(personA, saved.body.source?.id ?? "")).status).toBe(
      200,
    );
    expect(await grantsOn(personA)).toEqual([]);
    expect(await avatarConnectorTools(personA)).toEqual([]);
    const refused = (await runAsTenant(personA, () =>
      tools[0]?.execute({ query: "合同" }),
    )) as string;
    expect(refused.startsWith(REFUSAL_MARKER)).toBe(true);
    expect(vendorCalls).toEqual([]);
    expect(
      await avatarSourcesForActor(store)(personA)(avatarAgentId(personA)),
    ).toEqual([]);
    await clear(personA);
  });

  test("a connector only somebody else connected cannot be attached, and their 分身 is untouched", async () => {
    // C connected the drive and attaches it; B never connected it.
    expect(
      (await add(personC, { kind: "connector", serverId: drive })).status,
    ).toBe(201);
    expect(await add(personB, { kind: "connector", serverId: drive })).toEqual({
      status: 404,
      body: {
        error:
          "找不到这个连接器，或者你还没有用自己的账号连接它。请先在「设置 › 已连接的账号」里连接。",
      },
    });
    expect(
      await add(personB, { kind: "connector", serverId: "no-such-server" }),
    ).toMatchObject({ status: 404 });
    expect(await grantsOn(personB)).toEqual([]);
    expect(await avatarConnectorTools(personB)).toEqual([]);
    // B cannot remove C's source, and C's grant stands.
    const [source] = (await stateOf(personC)).sources;
    expect((await remove(personB, source?.id ?? "")).status).toBe(404);
    expect(await grantsOn(personC)).toEqual([
      { ref: READ, grantedBy: emailOf(personC) },
    ]);
    await clear(personC);
  });

  test("SEC1 still governs the attached connector: a deny rule takes it off what the 分身 is offered, and the gate refuses a call", async () => {
    expect(
      (await add(personA, { kind: "connector", serverId: drive })).status,
    ).toBe(201);
    const [tool] = await avatarConnectorTools(personA);
    expect(tool?.ref).toBe(READ);
    const disabledBefore = await runAsTenant(personA, () =>
      approvals.disabledTools(personA, avatarAgentId(personA)),
    );
    expect(disabledBefore(READ)).toBe(false);

    const policy = approvalStore.policy;
    if (!policy) throw new Error("No approval policy store.");
    await runAsTenant(personA, () =>
      policy.createRule(personA, {
        botId: avatarAgentId(personA),
        toolRef: READ,
        effect: "*",
        scope: "*",
        behaviour: "deny",
      }),
    );
    // What index.ts offers a run: granted tools, less the ones SEC1 disabled for this person and Bot.
    const disabled = await runAsTenant(personA, () =>
      approvals.disabledTools(personA, avatarAgentId(personA)),
    );
    expect(disabled(READ)).toBe(true);
    expect(
      (await avatarConnectorTools(personA)).filter(
        (offered) => !disabled(offered.ref),
      ),
    ).toEqual([]);
    // Called anyway, the gate refuses it before any credential or vendor is touched.
    const refused = (await runAsTenant(personA, () =>
      tool?.execute({ query: "合同" }),
    )) as string;
    expect(refused.startsWith(REFUSAL_MARKER)).toBe(true);
    expect(vendorCalls).toEqual([]);
    await clear(personA);
  });
});

// --- every kind together --------------------------------------------------------------------------

describe("the limit and the kinds", () => {
  test(`at most ${AVATAR_SOURCE_LIMIT} sources of every kind together; a refused save writes no binding or grant`, async () => {
    const id = await notebook(personA, "限额测试", "内容。");
    for (let index = 0; index < AVATAR_SOURCE_LIMIT - 1; index += 1) {
      expect(
        (await add(personA, { label: `声明 ${index + 1}`, note: "" })).status,
      ).toBe(201);
    }
    expect(
      (await add(personA, { kind: "notebook", notebookId: id })).status,
    ).toBe(201);
    expect(await add(personA, { kind: "connector", serverId: drive })).toEqual({
      status: 409,
      body: {
        error: `每个分身最多登记 ${AVATAR_SOURCE_LIMIT} 个信息来源。请先删掉不再需要的。`,
      },
    });
    expect(await grantsOn(personA)).toEqual([]);
    expect((await stateOf(personA)).sources).toHaveLength(AVATAR_SOURCE_LIMIT);

    // Removing the notebook makes room, and the connector then fits.
    const attached = (await stateOf(personA)).sources.find(
      (source) => source.kind === "notebook",
    );
    expect((await remove(personA, attached?.id ?? "")).status).toBe(200);
    expect(
      (await add(personA, { kind: "connector", serverId: drive })).status,
    ).toBe(201);
    await clear(personA);
  });

  test("the database holds each kind to its own pointer, whoever writes", async () => {
    const id = await notebook(personA, "约束测试", "内容。");
    for (const values of [
      { kind: "notebook" as const, label: "缺知识库" },
      { kind: "connector" as const, label: "缺连接器" },
      { kind: "declaration" as const, label: "多指针", notebookId: id },
      { kind: "declaration" as const, label: "多指针", serverId: drive },
      {
        kind: "notebook" as const,
        label: "多指针",
        notebookId: id,
        serverId: drive,
      },
    ]) {
      await expect(
        runAsTenant(personA, async () => {
          await database.insert(avatarSources).values({
            tenantId: personA,
            agentId: avatarAgentId(personA),
            ...values,
          });
        }),
      ).rejects.toThrow();
    }
    expect((await stateOf(personA)).sources).toEqual([]);
    await clear(personA);
  });

  test("a store built without the knowledge base or plugins still refuses those kinds, as stage 1 did", async () => {
    const plain = createAvatarSourceStore(database);
    const response = await createAvatarSourceRoutes(
      plain,
      actor(personA),
    ).request(
      new Request("http://openbot.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "notebook", notebookId: randomUUID() }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "目前只支持文字声明和本地文件夹这两种信息来源。",
    });
    // This store takes all four, and says so for a kind that does not exist.
    expect(await add(personA, { kind: "spreadsheet", label: "表格" })).toEqual({
      status: 400,
      body: {
        error: "目前只支持文字声明、本地文件夹、知识库和连接器这几种信息来源。",
      },
    });
  });
});
