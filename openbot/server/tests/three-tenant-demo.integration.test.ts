import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  groupTaskRuns,
  mcpServers,
  mcpTools,
  pluginGrants,
  registeredDevices,
  tasks,
  usageCounters,
  users,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
import { createPipelineStore } from "../src/pipeline/store";
import { createPluginStore } from "../src/plugins/store";
import {
  billingPeriod,
  createQuotaService,
  QuotaExceeded,
} from "../src/quota/limits";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { provisionTenant } from "../src/tenant/provisioning";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec §5's "three workspaces at once" demonstration, as a test.
 *
 * The four things the spec says have to hold SIMULTANEOUSLY — isolation, quota, device routing, the
 * crew pipeline — are each covered by their own suites, and every one of those passing is compatible
 * with the product being broken in the combination: a quota counted against the wrong workspace, a crew
 * whose cards land in somebody else's board, a connector whose row two tenants share. This asks the
 * combination in one database, with three real tenant frames and no stub where the seam is the thing
 * under test.
 *
 * `executeStep` stays a stub on purpose. ADR-0001's option A routes a step through the deployment's
 * existing unattended turn channel, and that channel's governance (thread lock, pause gate, grant
 * check, audit) is tested where it is implemented; standing it up three times over here would test the
 * harness rather than the combination. What is NOT stubbed is the quota service, the board projector,
 * the plugin store and row-level security — those are the four things the combination could get wrong.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const board = createTaskProjector(database);
const quota = createQuotaService(database);
const suite = randomUUID().slice(0, 8);

const entryKey = "google-drive";
const toolRef = `${entryKey}/search_files`;

/** Three workspaces, as one person each (D12: a personal account IS a tenant). */
const tenants = [0, 1, 2].map((index) => `demo-${index}-${suite}`);

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: async () => null,
    create: async () => {
      throw new Error("this suite does not write credentials");
    },
    revoke: async () => {
      throw new Error("this suite does not revoke credentials");
    },
  },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

/** The coworker each workspace owns, so a crew step names somebody of ITS OWN. */
const agentOf = (tenant: string) => `${tenant}-worker`;
const groupOf = new Map<string, string>();

/*
 * Read in the operator's frame with the workspace named in the WHERE, not in that workspace's own
 * frame. Both numbers matter and they are different questions: "the crew opened no card" and "the
 * crew's card exists but its own workspace cannot read it" look identical from inside the tenant,
 * and the second one is the worse product fault -- a board that silently omits work in progress.
 */
const cardsOf = (tenant: string) =>
  runAsTenant(
    "platform",
    async () =>
      await database
        .select({
          id: tasks.id,
          status: tasks.status,
          source: tasks.source,
          executorAgentId: tasks.executorAgentId,
          runRef: tasks.runRef,
        })
        .from(tasks)
        .where(eq(tasks.tenantId, tenant))
        .orderBy(asc(tasks.createdAt)),
  );

const ownRowsFor = (tenant: string) =>
  runAsTenant(
    tenant,
    async () =>
      await database
        .select({ id: mcpServers.id, tenantId: mcpServers.tenantId })
        .from(mcpServers)
        .where(
          and(
            eq(mcpServers.catalogueKey, entryKey),
            eq(mcpServers.tenantId, tenant),
          ),
        ),
  );

function pipelineFor() {
  return createPipelineStore({
    database,
    board,
    executeStep: async () => ({ status: "done", output: "做完了" }),
    canUse: async (caller, agentId) => agentId === agentOf(caller),
    quota,
    newRunId: () => randomUUID(),
  });
}

const stepsOf = (tenant: string) => [
  { id: "only", agentId: agentOf(tenant), instruction: "把这件事做完" },
];

/*
 * The three workspaces and their people, written the way sign-up writes them: each row in its own
 * frame, because the INSERT check refuses a row stamped for somebody else and routing around that
 * would delete the very line this demonstration is about.
 */
for (const tenant of tenants) {
  await database.insert(users).values({
    id: tenant,
    email: `${tenant}@example.test`,
  });
  const groupId = randomUUID();
  groupOf.set(tenant, groupId);
  // The plan, the seat-free 分身 and the rest of what a real workspace is born with. `planFor`
  // answers null for a workspace nobody provisioned, and null means NOTHING IS INTERCEPTED -- so a
  // quota test without this line is a quota test that never asks the question.
  await provisionTenant(database, {
    id: tenant,
    email: `${tenant}@example.test`,
  });
  await runAsTenant(
    tenant,
    async () =>
      await database.insert(wakerGroups).values({
        id: groupId,
        tenantId: tenant,
        name: `演示小组-${tenant}`,
      }),
  );
  // Its own employee is a member of it, which is what lets a pipeline step be written for anybody.
  await runAsTenant(
    tenant,
    async () =>
      await database
        .insert(wakerGroupMembers)
        .values({ groupId, agentId: agentOf(tenant), position: "0" }),
  );
  await runAsTenant(
    tenant,
    async () =>
      await database
        .insert(agents)
        .values({
          id: agentOf(tenant),
          name: `员工-${tenant}`,
          type: "built_in",
          configuration: {},
        })
        .onConflictDoNothing(),
  );
}

afterAll(async () => {
  const rows = await runAsTenant("platform", async () =>
    database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(inArray(mcpServers.tenantId, tenants)),
  );
  for (const tenant of tenants) {
    await runAsTenant(
      tenant,
      async () =>
        await database
          .delete(pluginGrants)
          .where(eq(pluginGrants.agentId, agentOf(tenant))),
    );
    await runAsTenant(
      tenant,
      async () =>
        await database.delete(tasks).where(eq(tasks.tenantId, tenant)),
    );
    await runAsTenant(
      tenant,
      async () =>
        await database
          .delete(usageCounters)
          .where(eq(usageCounters.tenantId, tenant)),
    );
    await runAsTenant(
      tenant,
      async () =>
        await database
          .delete(registeredDevices)
          .where(eq(registeredDevices.tenantId, tenant)),
    );
    await runAsTenant(
      tenant,
      async () =>
        await database.delete(agents).where(eq(agents.id, agentOf(tenant))),
    );
    await runAsTenant(
      tenant,
      async () =>
        await database
          .delete(wakerGroups)
          .where(eq(wakerGroups.tenantId, tenant)),
    );
  }
  if (rows.length > 0) {
    await runAsTenant("platform", async () => {
      await database.delete(mcpTools).where(
        inArray(
          mcpTools.serverId,
          rows.map((row) => row.id),
        ),
      );
      await database.delete(mcpServers).where(
        inArray(
          mcpServers.id,
          rows.map((row) => row.id),
        ),
      );
    });
  }
  await database.delete(users).where(inArray(users.id, tenants));
});

/**
 * The connector, which is what ticket 028 was for.
 *
 * Before the split, the second of these three presses was a 500: the whole deployment could hold one
 * `google-drive` row, and the later tenants were competing for it rather than provisioning it.
 */
test("all three workspaces open the same catalogue entry", async () => {
  for (const tenant of tenants) {
    await runAsTenant(
      tenant,
      async () =>
        await store.addServer({ key: entryKey, by: `${tenant}@example.test` }),
    );
  }

  const ids = new Set<string>();
  for (const tenant of tenants) {
    const rows = await ownRowsFor(tenant);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(tenant);
    ids.add(rows[0]?.id ?? "");
  }
  // Three presses of one entry, three rows: a shared row would mean a shared credential and one
  // consent history for three customers.
  expect(ids.size).toBe(3);
});

/**
 * The grant, which is what the row exists to carry.
 *
 * The ref names the APP while the tool row hangs off a ROW, and the two only came apart in this
 * release. Asserted per workspace because a lookup that resolved through somebody else's row would
 * hand back the same words and a wrong set of actions behind them.
 */
test("each workspace grants the same action to its own coworker", async () => {
  for (const tenant of tenants) {
    await runAsTenant(
      tenant,
      async () =>
        await store.grant(
          "mcp",
          toolRef,
          agentOf(tenant),
          `${tenant}@example.test`,
        ),
    );
  }

  for (const tenant of tenants) {
    const granted = await runAsTenant(
      tenant,
      async () => await store.listForAgent(agentOf(tenant)),
    );
    expect(granted.tools.map((tool) => tool.ref)).toContain(toolRef);
  }

  // A coworker of one workspace is not a coworker of another: the same Bot id asked for in a stranger's
  // frame answers with nothing rather than with the owner's grants.
  const strangerSees = await runAsTenant(
    tenants[1] ?? "",
    async () => await store.listForAgent(agentOf(tenants[0] ?? "")),
  );
  expect(strangerSees.tools).toHaveLength(0);
});

/**
 * Device routing, at the layer everything above it rests on.
 *
 * A run is routed to a machine by name, so the load-bearing fact is that a workspace cannot even READ
 * another's device: a queue that could see it could fill it. The pairing ceremony has its own suites;
 * this is the isolation half, and it is the half a routing bug would reopen.
 */
test("a machine belongs to exactly one workspace", async () => {
  const [first, second] = [tenants[0] ?? "", tenants[1] ?? ""];
  await runAsTenant(
    first,
    async () =>
      await database.insert(registeredDevices).values({
        id: randomUUID(),
        tenantId: first,
        deviceId: `machine-${suite}`,
        name: "演示电脑",
        platform: "linux",
        // A hash of a token that exists nowhere. The routing question is about who can read the
        // row, and nothing here authenticates a runner.
        tokenHash: `no-token-${suite}`,
      }),
  );

  const seenByOwner = await runAsTenant(
    first,
    async () =>
      await database
        .select({ id: registeredDevices.id })
        .from(registeredDevices)
        .where(eq(registeredDevices.deviceId, `machine-${suite}`)),
  );
  const seenByStranger = await runAsTenant(
    second,
    async () =>
      await database
        .select({ id: registeredDevices.id })
        .from(registeredDevices)
        .where(eq(registeredDevices.deviceId, `machine-${suite}`)),
  );

  expect(seenByOwner).toHaveLength(1);
  expect(seenByStranger).toHaveLength(0);
});

/**
 * Quota, asked of the real service.
 *
 * The plan's ceiling is read rather than hard-coded, because the assertion is "this workspace ran out
 * of ITS plan's tasks this month" and a written-down number would drift the day the catalogue changes.
 * A workspace with no plan is deliberately not intercepted (ticket 022's rule), which is why the other
 * two still start.
 */
test("one workspace over its monthly ceiling does not stop the other two", async () => {
  const atCap = tenants[0] ?? "";
  const plan = await quota.planFor(atCap);
  const ceiling = plan?.limits.tasksPerMonth ?? 0;
  const period = billingPeriod(new Date());
  await runAsTenant(
    atCap,
    async () =>
      await database.insert(usageCounters).values({
        tenantId: atCap,
        period,
        metric: "tasks",
        value: Math.max(ceiling, 1),
      }),
  );

  const startedBy: Record<string, string> = {};
  for (const tenant of tenants) {
    const pipeline = pipelineFor();
    const templateId = await pipeline.createTemplate({
      tenantId: tenant,
      groupId: groupOf.get(tenant) ?? "",
      name: `演示流水线-${tenant}`,
      steps: stepsOf(tenant),
    });
    if (tenant === atCap) {
      // The ceiling is asked before any card exists, so a refusal leaves nothing to clean up.
      const before = (await cardsOf(tenant)).length;
      await expect(
        pipeline.start({
          tenantId: tenant,
          templateId,
          task: "这个月不该再开了",
          initiatedBy: tenant,
        }),
      ).rejects.toBeInstanceOf(QuotaExceeded);
      expect((await cardsOf(tenant)).length).toBe(before);
      continue;
    }
    const started = await pipeline.start({
      tenantId: tenant,
      templateId,
      task: "照常做",
      initiatedBy: tenant,
    });
    // `start` opens the run and its parent card; the steps run as it is advanced. The routes do
    // this in a fire-and-forget `drive`, and a test that only started would be asserting that
    // opening a row is the same as finishing work.
    await pipeline.advance({ tenantId: tenant, runId: started.runId });
    startedBy[tenant] = started.runId;
  }

  // Two crews started while one was refused: the refusal is arithmetic about one workspace, not a
  // switch on the deployment.
  expect(Object.keys(startedBy)).toHaveLength(tenants.length - 1);

  for (const [tenant, runId] of Object.entries(startedBy)) {
    const row = await runAsTenant(tenant, async () => {
      const [found] = await database
        .select({ status: groupTaskRuns.status, cursor: groupTaskRuns.cursor })
        .from(groupTaskRuns)
        .where(eq(groupTaskRuns.id, runId))
        .limit(1);
      return found;
    });
    // The store's own vocabulary: a crew that ran out of steps is `done`. Naming it "finished" here
    // would only make the test disagree with the page a person reads.
    expect(row?.status).toBe("done");
    // The run row lives in its own workspace and nowhere else.
    const inAStrangerFrame = await runAsTenant(
      atCap === tenant ? (tenants[2] ?? "") : atCap,
      async () =>
        await database
          .select({ id: groupTaskRuns.id })
          .from(groupTaskRuns)
          .where(eq(groupTaskRuns.id, runId)),
    );
    expect(inAStrangerFrame).toHaveLength(0);
  }
});

/**
 * The board, which is where a person looks.
 *
 * Two separate failures live here and they are not interchangeable: a card that was never opened, and a
 * card that exists but whose own workspace cannot read it. The second is the worse product fault -- the
 * run is happening and the board says nothing -- so this reads as the owner first, then proves the same
 * row is invisible to a stranger rather than shared with one.
 */
test("each workspace's own board shows its own crew", async () => {
  const [owner, stranger] = [tenants[1] ?? "", tenants[2] ?? ""];
  const pipeline = pipelineFor();
  const templateId = await pipeline.createTemplate({
    tenantId: owner,
    groupId: groupOf.get(owner) ?? "",
    name: "看板演示",
    steps: stepsOf(owner),
  });
  const started = await pipeline.start({
    tenantId: owner,
    templateId,
    task: "这件事要在我自己的看板上看得见",
    initiatedBy: owner,
  });
  await pipeline.advance({ tenantId: owner, runId: started.runId });

  const asOwner = await runAsTenant(
    owner,
    async () =>
      await database
        .select({
          id: tasks.id,
          status: tasks.status,
          executorAgentId: tasks.executorAgentId,
          runRef: tasks.runRef,
        })
        .from(tasks)
        .where(eq(tasks.parentTaskId, started.parentTaskId)),
  );
  // Each step is its own card under the parent, and its own run: `runRef` on a step card is the step's
  // run id, which is what lets the approval gate park exactly that card. So the crew's cards are found
  // by the parent they hang off, not by the run the person started.
  expect(asOwner.length).toBeGreaterThan(0);
  expect(asOwner.every((card) => card.executorAgentId === agentOf(owner))).toBe(
    true,
  );

  // The card the person watches, in the same board.
  const parentVisible = await runAsTenant(
    owner,
    async () =>
      await database
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, started.parentTaskId)),
  );
  expect(parentVisible).toHaveLength(1);

  // A stranger cannot read it, and "cannot read it" is the row genuinely not being there rather than a
  // filter this suite wrote: the same select, in the other workspace's frame, answers with nothing.
  const asStranger = await runAsTenant(
    stranger,
    async () =>
      await database
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.parentTaskId, started.parentTaskId)),
  );
  expect(asStranger).toHaveLength(0);
});
