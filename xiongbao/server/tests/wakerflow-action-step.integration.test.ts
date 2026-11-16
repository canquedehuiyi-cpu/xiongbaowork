import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { WakerFlowPlan } from "../../shared/wakerflows";
import { BotPausedError } from "../src/agents/lifecycle";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { currentApprovalContext } from "../src/approvals/types";
import { createDatabase } from "../src/db/client";
import {
  agents,
  approvalPreferences,
  approvalRequests,
  approvalRules,
  flowConfirmations,
  flowRunEvents,
  groupTaskRuns,
  groupTaskTemplates,
  tasks,
  users,
  wakerFlowRequests,
  wakerFlows,
  wakerGroups,
} from "../src/db/schema";
import {
  type ActionStepDependencies,
  createActionStepRunner,
  isMcpToolRef,
} from "../src/pipeline/action-step";
import {
  createPipelineStore,
  type PipelineStepRunner,
} from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import {
  createWakerFlowStore,
  flowRunEventWriter,
  WakerFlowValidationError,
} from "../src/wakerflows/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * WF7-4 (spec 2026-11-04-wf7 §3.5, §5 WF7-4; ADR-0001 补充（2026-11-04）): an action step is one
 * fixed MCP call with no turn and no model, behind the gates a turn passes. The MCP vendor is a fake
 * counter; the approval gate is the real one on the real database.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const tenants: string[] = [];

afterAll(async () => {
  for (const tenantId of tenants) {
    await runAsTenant(tenantId, async () => {
      await database
        .delete(flowConfirmations)
        .where(eq(flowConfirmations.tenantId, tenantId));
      await database
        .delete(flowRunEvents)
        .where(eq(flowRunEvents.tenantId, tenantId));
      await database.delete(tasks).where(eq(tasks.tenantId, tenantId));
      await database
        .delete(groupTaskRuns)
        .where(eq(groupTaskRuns.tenantId, tenantId));
      await database
        .delete(groupTaskTemplates)
        .where(eq(groupTaskTemplates.tenantId, tenantId));
      await database
        .delete(wakerFlowRequests)
        .where(eq(wakerFlowRequests.tenantId, tenantId));
      await database
        .delete(wakerFlows)
        .where(eq(wakerFlows.tenantId, tenantId));
      await database
        .delete(wakerGroups)
        .where(eq(wakerGroups.tenantId, tenantId));
      await database.delete(agents).where(eq(agents.tenantId, tenantId));
      await database
        .delete(approvalRequests)
        .where(eq(approvalRequests.ownerUserId, tenantId));
      await database
        .delete(approvalRules)
        .where(eq(approvalRules.ownerUserId, tenantId));
      await database
        .delete(approvalPreferences)
        .where(eq(approvalPreferences.ownerUserId, tenantId));
    });
    await runAsTenant("platform", () =>
      database.delete(users).where(eq(users.id, tenantId)),
    );
  }
  await database.$client.close();
});

type StepCall = Parameters<PipelineStepRunner>[0];
const TOOL = "crm/create_note";

async function fixture() {
  const tenantId = `flowaction-${randomUUID()}`;
  tenants.push(tenantId);
  const writer = `${tenantId}-writer`;
  await runAsTenant("platform", () =>
    database
      .insert(users)
      .values({ id: tenantId, email: `${tenantId}@example.test` }),
  );
  await runAsTenant(tenantId, () =>
    database.insert(agents).values({
      id: writer,
      tenantId,
      name: "小写",
      type: "built_in" as const,
      configuration: {},
    }),
  );
  const approvalStore = createApprovalStore(database);
  const approvals = createApprovalService(approvalStore);
  const state = {
    paused: false,
    useBots: true,
    usable: true,
    granted: new Set([TOOL]),
    /** Revoke the initiator's use of the coworker once the worker step has run (I6 mid-run). */
    revokeAfterTurn: false,
  };
  /** Every call that reached the vendor, after every gate let it through. */
  const vendor: { ref: string; args: Record<string, unknown> }[] = [];
  /** Every call that reached `callTool` at all. */
  const toolCalls: { ref: string; args: Record<string, unknown> }[] = [];
  const turns: StepCall[] = [];
  /**
   * A stand-in for `plugins/store.ts` `callTool`: the grant, then the real approval gate exactly as
   * that function asks it (a write, in the step's approval context), then the vendor.
   */
  const callTool: ActionStepDependencies["callTool"] = async (input) => {
    toolCalls.push({ ref: input.ref, args: input.args });
    if (!state.granted.has(input.ref)) throw new Error("not granted");
    const [server = ""] = input.ref.split("/");
    const permit = await approvals.gate({
      actorId: input.actorId,
      botId: input.botId,
      toolRef: input.ref,
      effect: "write",
      scope: server,
      args: input.args,
      continuation: currentApprovalContext(),
    });
    if (permit && "replay" in permit)
      return permit.replay as { text: string; isError: boolean };
    vendor.push({ ref: input.ref, args: input.args });
    const answer = {
      text: `已记录：${String(input.args.text)}`,
      isError: false,
    };
    await permit?.complete(answer);
    return answer;
  };
  const audits: { gate: string }[] = [];
  const actions = createActionStepRunner({
    guardTurn: async () => {
      if (state.paused) throw new BotPausedError();
    },
    refusal: async () => (state.useBots ? null : "Use Bots 已关闭。"),
    granted: async ({ tool }) => state.granted.has(tool),
    callTool,
    audit: async (event) => {
      audits.push({ gate: event.gate });
    },
  });
  const canUse = async (actor: string, agentId: string) =>
    actor === tenantId && agentId === writer && state.usable;
  const board = createTaskProjector(database);
  const pipeline = createPipelineStore({
    database,
    board,
    canUse,
    events: flowRunEventWriter,
    actions,
    executeStep: async (call: StepCall) => {
      turns.push(call);
      if (state.revokeAfterTurn) state.usable = false;
      return { status: "done" as const, output: "要点：客户想续约" };
    },
  });
  const drives: Promise<unknown>[] = [];
  const store = createWakerFlowStore({
    database,
    pipeline,
    board,
    canUse,
    drive: (run) => {
      drives.push(pipeline.advance(run));
    },
    // The deployment's wiring (`index.ts`): the grant, then SEC1's "disabled".
    actionTool: async ({ actor, agentId, tool }) => {
      if (!state.granted.has(tool)) return `员工没有被授权使用工具 ${tool}。`;
      if ((await approvals.disabledTools(actor, agentId))(tool))
        return `工具 ${tool} 已被设为禁用。`;
      return null;
    },
  });
  const plan = (tool = TOOL): WakerFlowPlan => ({
    name: "客户纪要",
    description: "",
    members: [{ agentId: writer, role: "记录员" }],
    inputs: [{ key: "customer", label: "客户", required: true }],
    steps: [
      {
        id: "summarize",
        agentId: writer,
        instruction: "总结通话要点",
        inputKeys: ["customer"],
        outputKey: "summary",
      },
      {
        id: "record",
        kind: "action",
        agentId: writer,
        tool,
        args: { text: "{{customer}}：{{summary}}", visibility: "team" },
        inputKeys: ["customer", "summary"],
        outputKey: "note",
      },
    ],
  });
  const save = async (value = plan()) => {
    const created = await store.create(tenantId, { idea: value.name });
    return store.save(tenantId, tenantId, created.id, {
      revision: 0,
      plan: value,
    });
  };
  const run = async (flow: { id: string; revision: number }) => {
    const request = await store.start(tenantId, tenantId, flow.id, {
      requestId: randomUUID(),
      revision: flow.revision,
      inputs: { customer: "甲公司" },
    });
    if (!request.runId) throw new Error("No run registered.");
    await Promise.all(drives);
    return request.runId;
  };
  const detail = (flowId: string, runId: string) =>
    store.run(tenantId, flowId, runId);
  return {
    tenantId,
    writer,
    state,
    vendor,
    toolCalls,
    turns,
    audits,
    approvals,
    approvalStore,
    pipeline,
    store,
    save,
    plan,
    run,
    detail,
    drives,
  };
}

test("an action calls its tool once with the filled arguments; its output is the tool's text; no turn, no model", async () => {
  const f = await fixture();
  const flow = await f.save();
  const runId = await f.run(flow);
  const run = await f.detail(flow.id, runId);
  expect(run.status).toBe("done");
  expect(f.vendor).toEqual([
    {
      ref: TOOL,
      args: { text: "甲公司：要点：客户想续约", visibility: "team" },
    },
  ]);
  const record = run.steps.find((step) => step.id === "record");
  expect(record).toMatchObject({
    state: "done",
    output: "已记录：甲公司：要点：客户想续约",
  });
  // ADR-0001 lock: the worker step went through the turn channel, and only it did.
  expect(f.turns.map((turn) => turn.agentId)).toEqual([f.writer]);
  expect(f.turns).toHaveLength(1);
});

test("the ADR-0001 gates refuse before the tool: paused, Use Bots off, I6, not granted", async () => {
  const cases: [
    string,
    (f: Awaited<ReturnType<typeof fixture>>) => void,
    string,
  ][] = [
    [
      "paused",
      (f) => {
        f.state.paused = true;
      },
      "guardBotTurn",
    ],
    [
      "Use Bots off",
      (f) => {
        f.state.useBots = false;
      },
      "headlessTurnRefusal",
    ],
    [
      "grant revoked",
      (f) => {
        f.state.granted.delete(TOOL);
      },
      "not_granted",
    ],
  ];
  for (const [name, refuse, gate] of cases) {
    const f = await fixture();
    const flow = await f.save();
    refuse(f);
    const runId = await f.run(flow);
    const run = await f.detail(flow.id, runId);
    expect({ name, status: run.status }).toEqual({ name, status: "failed" });
    expect(run.steps.find((step) => step.id === "record")?.state).toBe(
      "failed",
    );
    expect({ name, calls: f.toolCalls.length }).toEqual({ name, calls: 0 });
    expect(f.audits).toEqual([{ gate }]);
  }
  // I6: the initiator's use of the coworker is revoked mid-run; the orchestrator refuses the action
  // step before its runner, with the same check a worker step gets.
  const f = await fixture();
  const flow = await f.save();
  f.state.revokeAfterTurn = true;
  const runId = await f.run(flow);
  const run = await f.detail(flow.id, runId);
  expect(run.status).toBe("failed");
  expect(run.steps.find((step) => step.id === "record")?.error).toContain(
    "你没有使用权",
  );
  expect(f.toolCalls).toHaveLength(0);
});

test("only MCP tools: a computer, host, hand-off or built-in tool is refused on Save and again when run", async () => {
  for (const ref of [
    "computer_run_command",
    "host/run_command",
    "bot/handoff",
    "openbot/share_private_information",
    "files/computer_click",
  ])
    expect({ ref, mcp: isMcpToolRef(ref) }).toEqual({ ref, mcp: false });
  expect(isMcpToolRef(TOOL)).toBe(true);

  const f = await fixture();
  const refused = await f.save(f.plan("host/run_command")).then(
    () => null,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(WakerFlowValidationError);
  expect((refused as Error).message).toContain("只能调用 MCP 工具");

  // At run time too, whatever a template holds.
  const runner = createActionStepRunner({
    guardTurn: async () => undefined,
    refusal: async () => null,
    granted: async () => true,
    callTool: async () => {
      throw new Error("must not be called");
    },
  });
  expect(
    await runner({
      tenantId: f.tenantId,
      runId: randomUUID(),
      stepRunRef: randomUUID(),
      stepId: "x",
      agentId: f.writer,
      tool: "host/run_command",
      args: {},
      values: {},
      initiatedBy: f.tenantId,
    }),
  ).toMatchObject({ status: "failed" });
});

test("a tool that is not granted, or that SEC1 disabled, cannot be saved in an action step", async () => {
  const f = await fixture();
  const notGranted = await f.save(f.plan("crm/delete_everything")).then(
    () => null,
    (error: unknown) => error,
  );
  expect(notGranted).toBeInstanceOf(WakerFlowValidationError);
  expect((notGranted as Error).message).toContain("没有被授权使用工具");

  const policy = f.approvalStore.policy;
  if (!policy) throw new Error("No approval policy store.");
  await runAsTenant(f.tenantId, () =>
    policy.createRule(f.tenantId, {
      botId: f.writer,
      toolRef: TOOL,
      effect: "*",
      scope: "*",
      behaviour: "deny",
    }),
  );
  const disabled = await f.save().then(
    () => null,
    (error: unknown) => error,
  );
  expect(disabled).toBeInstanceOf(WakerFlowValidationError);
  expect((disabled as Error).message).toContain("已被设为禁用");
});

test("an action that needs approval parks with the approval's id; approved, the tool runs exactly once", async () => {
  const f = await fixture();
  const flow = await f.save();
  await runAsTenant(f.tenantId, () =>
    f.approvalStore.setEnabled(f.tenantId, true),
  );
  const runId = await f.run(flow);
  let run = await f.detail(flow.id, runId);
  expect(run.status).toBe("awaiting_action");
  const parked = run.steps.find((step) => step.id === "record");
  expect(parked?.state).toBe("awaiting_action");
  const approvalId = parked?.approvalId;
  if (!approvalId) throw new Error("No approval id.");
  expect(f.vendor).toHaveLength(0);

  await runAsTenant(f.tenantId, () =>
    f.approvals.decide(f.tenantId, approvalId, "allow_once"),
  );
  // What the approval queue does for a crew's action step (`index.ts`).
  const holder = await f.pipeline.actionHoldingApproval({ approvalId });
  expect(holder).toEqual({ tenantId: f.tenantId, runId });
  expect(
    await runAsTenant(f.tenantId, () =>
      f.pipeline.resumeAction({ tenantId: f.tenantId, runId, approvalId }),
    ),
  ).toBe(true);
  run = await f.detail(flow.id, runId);
  expect(run.status).toBe("done");
  expect(f.vendor).toHaveLength(1);
  expect(run.steps.find((step) => step.id === "record")).toMatchObject({
    state: "done",
    output: "已记录：甲公司：要点：客户想续约",
  });
  // The queue delivering the decision again carries nothing out a second time.
  expect(
    await runAsTenant(f.tenantId, () =>
      f.pipeline.resumeAction({ tenantId: f.tenantId, runId, approvalId }),
    ),
  ).toBe(false);
  expect(f.vendor).toHaveLength(1);
});

test("an action whose approval is declined fails, and the tool never runs", async () => {
  const f = await fixture();
  const flow = await f.save();
  await runAsTenant(f.tenantId, () =>
    f.approvalStore.setEnabled(f.tenantId, true),
  );
  const runId = await f.run(flow);
  const approvalId = (await f.detail(flow.id, runId)).steps.find(
    (step) => step.id === "record",
  )?.approvalId;
  if (!approvalId) throw new Error("No approval id.");
  await runAsTenant(f.tenantId, () =>
    f.approvals.decide(f.tenantId, approvalId, "deny"),
  );
  await runAsTenant(f.tenantId, () =>
    f.pipeline.resumeAction({ tenantId: f.tenantId, runId, approvalId }),
  );
  const run = await f.detail(flow.id, runId);
  expect(run.status).toBe("failed");
  expect(run.steps.find((step) => step.id === "record")?.state).toBe("failed");
  expect(f.vendor).toHaveLength(0);
});

test("ADR-0001 lock: the deployment runs worker steps only through createPipelineStepRunner", () => {
  const source = readFileSync(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  const wiring = source.slice(
    source.indexOf("const pipelineStore = createPipelineStore({"),
    source.indexOf("const wakerFlowStore = createWakerFlowStore({"),
  );
  expect(wiring).toContain(
    "executeStep: createPipelineStepRunner({ runTurn: unattendedTurnRunner }),",
  );
  expect(wiring).toContain("actions: createActionStepRunner({");
  expect(wiring).toContain("guardTurn: (input) => guardBotTurn(input),");
  expect(wiring).toContain("refusal: (input) => headlessTurnRefusal(input),");
  // The approval worker asserts an action run's owner and resumes it in that frame (G01-E R10, R14),
  // beside the crew resume it leaves exactly as it was. M3: upstream moved that worker out of
  // index.ts into approvals/resume-sweep.ts, where the owner check is its `ownedBy`.
  const sweep = readFileSync(
    new URL("../src/approvals/resume-sweep.ts", import.meta.url),
    "utf8",
  );
  expect(sweep).toMatch(
    /const ownedBy = \([\s\S]{0,300}return assertPersonTenant\(parked\.tenantId, ownerUserId\);/,
  );
  const lookup = sweep.indexOf("pipeline?.actionHoldingApproval(");
  expect(lookup).toBeGreaterThan(-1);
  expect(lookup).toBeLessThan(sweep.indexOf("pipeline?.runHoldingApproval("));
  const window = sweep.slice(lookup, lookup + 2500);
  expect(window).toMatch(
    /ownedBy\(\s*parkedAction,\s*input\.ownerUserId,\s*"parked-action-owner-mismatch",/,
  );
  expect(window).toMatch(
    /runAsTenant\(actionTenant, \(\) =>\s*pipeline\.resumeAction\(\{\s*tenantId: actionTenant,/,
  );
  expect(sweep.match(/\.resumeAction\(/g)?.length).toBe(1);
  expect(source.match(/\.resumeAction\(/g)).toBeNull();
  // The orchestrator hands a worker step to `executeStep` and an action step to `actions`, nothing else.
  const pipeline = readFileSync(
    new URL("../src/pipeline/store.ts", import.meta.url),
    "utf8",
  );
  expect(pipeline.match(/await executeStep\(/g)).toHaveLength(1);
  expect(pipeline.match(/\bactions\(\{/g)).toHaveLength(1);
});
