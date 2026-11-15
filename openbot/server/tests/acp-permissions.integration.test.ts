import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { and, eq, inArray, like } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import {
  type AcpPermissionRequest,
  DeviceAcpAgent,
} from "../src/agents/acp/agent";
import {
  ACP_BAD_OPTION,
  ACP_PERMISSION_EXPIRED,
  type AcpApprovalCard,
  createAcpApprovalHirer,
  createAcpEmployeeLoader,
  createAcpPermissionBridge,
} from "../src/agents/acp/permissions";
import { createAcpRelay } from "../src/agents/acp/relay";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  approvalRequests,
  tasks,
  users,
  workItems,
} from "../src/db/schema";
import { approvalConversationGrants } from "../src/db/schema/approval-conversation-grants";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { createMemoryAcpTurnStore } from "./support/acp-turns-memory";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 外部员工的许可桥（permissions.ts），经真的审批存储、服务、路由和看板：电脑上的智能体请求许可
 * （测试扮演 runner 往上发帧，真 relay + 真 DeviceAcpAgent 把它交给许可桥），熊宝开「等你确认」、
 * 看板卡进「需要操作」，招聘人回答后答案经 relay 回到电脑。
 */

type Frame = Record<string, unknown>;

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const projector = createTaskProjector(database);
const store = createApprovalStore(database, projector);
const service = createApprovalService(store, undefined, undefined, {
  externalAgentHirer: createAcpApprovalHirer(database),
});
const prefix = `acp-perm-${randomUUID().slice(0, 8)}`;
const createdUsers: string[] = [];
const createdAgents: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await runAsTenant("platform", async () => {
    if (createdAgents.length) {
      const ids = createdAgents.splice(0);
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, ids));
      await database.delete(agents).where(inArray(agents.id, ids));
    }
    for (const id of createdUsers.splice(0)) {
      const requests = await database
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(eq(approvalRequests.ownerUserId, id));
      if (requests.length)
        await database.delete(workItems).where(
          and(
            eq(workItems.kind, "approval.resume"),
            inArray(
              workItems.key,
              requests.map((request) => request.id),
            ),
          ),
        );
      await database
        .delete(approvalConversationGrants)
        .where(eq(approvalConversationGrants.ownerUserId, id));
      await database
        .delete(approvalRequests)
        .where(eq(approvalRequests.ownerUserId, id));
      await runAsTenant(id, () =>
        database.delete(tasks).where(eq(tasks.tenantId, id)),
      );
      await database.delete(users).where(eq(users.id, id));
    }
  });
});
afterAll(async () => {
  await database.$client.close();
});

async function person(name: string): Promise<AgentActor> {
  const id = `${prefix}-${name}-${randomUUID().slice(0, 6)}`;
  await runAsTenant(id, () =>
    database.insert(users).values({ id, email: `${id}@example.test`, name }),
  );
  createdUsers.push(id);
  return { id, role: "user" };
}

/** The approval routes as production mounts them: the request framed as the signed-in person. */
const call = (actorId: string, path: string, body?: unknown) => {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actorId,
      email: `${actorId}@example.test`,
      role: "user",
    });
    await runAsTenant(actorId, () => next());
  };
  return createApprovalRoutes(service, requireUser).request(
    new Request(`http://openbot.test/${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
  );
};

const OPTIONS = [
  { optionId: "yes", kind: "allow_once", name: "Allow" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "no", kind: "reject_once", name: "Reject" },
];

/**
 * A hirer's external employee on the hirer's computer, one turn of it running in a thread (as a
 * person's chat, or a group member's @, starts it: in the hirer's tenant), its board card, and the
 * permission bridge.
 */
async function harness(
  hirer: AgentActor,
  permissions: Record<string, string> = {},
) {
  const profile = await runAsTenant(hirer.id, () =>
    profileStore.create(hirer, {
      name: "小码",
      title: "Engineer",
      roleDescription: "Writes code.",
      visibility: "private",
    }),
  );
  const agentId = profile.id;
  createdAgents.push(agentId);
  // The hirer's approvals switch is left as it is by default (off): it does not relax what the
  // employee's own rules ask (spec §4, layer 5).
  await runAsTenant("platform", () =>
    database
      .update(agents)
      .set({
        type: "device_acp",
        configuration: {
          deviceId: "laptop",
          harness: "codex",
          workdirRef: "fld_work",
          permissions,
        },
      })
      .where(eq(agents.id, agentId)),
  );
  const tenantId = hirer.id;
  const turns = createMemoryAcpTurnStore();
  const down: Frame[] = [];
  const relay = createAcpRelay({
    channel: {
      notify: (_target, frame) => {
        down.push(frame);
        return true;
      },
      isReachable: () => true,
      connectionOf: () => "conn-1",
    },
    turns,
    startQueuedTurn: async () => undefined,
    log: () => undefined,
  });
  const pending: Promise<void>[] = [];
  const bridge = createAcpPermissionBridge({
    relay,
    turns,
    approvals: service.store,
    onDecided: (listener) => service.onDecided(listener),
    policy: (candidate) => service.policyOutcome(candidate),
    board: projector,
    employee: createAcpEmployeeLoader(database, {
      list: async () => [{ deviceId: "laptop", name: "何总的 MacBook Pro" }],
    }),
    every: () => () => undefined,
    log: () => undefined,
  });
  cleanups.push(() => bridge.dispose());
  const threadId = `${prefix}-thread-${randomUUID().slice(0, 6)}`;
  const runRef = `${prefix}-run-${randomUUID().slice(0, 6)}`;
  await projector.opened({
    tenantId,
    title: "推送登录页修复",
    executorAgentId: agentId,
    source: "chat",
    channelRef: threadId,
    runRef,
  });
  const agent = new DeviceAcpAgent({
    agentId,
    ownerUserId: hirer.id,
    tenantId,
    deviceId: "laptop",
    harness: "codex",
    workdirRef: "fld_work",
    name: "小码",
    relay,
    turns,
    reachable: () => true,
    context: async () => [],
    every: () => () => undefined,
    onPermission: (request: AcpPermissionRequest) => {
      pending.push(bridge.onRequest(request));
    },
    log: () => undefined,
  });
  const events: BaseEvent[] = [];
  const subscription = agent
    .run({
      threadId,
      runId: runRef,
      messages: [{ id: "u1", role: "user", content: "修好登录页再推送" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    })
    .subscribe({ next: (event) => events.push(event) });
  cleanups.push(() => subscription.unsubscribe());
  const from = { tenantId, deviceId: "laptop", connectionId: "conn-1" };
  const settled = async () => {
    await relay.drain(from);
    while (pending.length) await Promise.all(pending.splice(0));
  };
  const device = async (frame: Frame) => {
    relay.fromRunner(from, { agentId, threadId, ...frame });
    await settled();
  };
  // The turn reaches the computer: open, session, prompt, ack.
  await until(() => down.some((frame) => frame.type === "acp.open"), "open");
  await device({ type: "acp.session", sessionId: "s-1", loaded: true });
  await until(
    () => down.some((frame) => frame.type === "acp.prompt"),
    "prompt",
  );
  const turnId = (down.find((frame) => frame.type === "acp.prompt") as Frame)
    .turnId as string;
  await device({ type: "acp.turn.ack", turnId });
  const request = (
    requestId: string,
    command: string,
    toolCallId = `call-${requestId}`,
  ) =>
    device({
      type: "acp.permission.request",
      turnId,
      requestId,
      toolCall: {
        toolCallId,
        kind: "execute",
        title: command,
        rawInput: { command },
      },
      options: OPTIONS,
      facts: { insideWorkdir: true, paths: [] },
    });
  const answers = () =>
    down.filter((frame) => frame.type === "acp.permission.answer");
  const approvals = () =>
    runAsTenant(hirer.id, () =>
      database
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.ownerUserId, hirer.id),
            like(approvalRequests.toolCallId, "acp:%"),
          ),
        ),
    );
  const card = async () => {
    const rows = await runAsTenant(tenantId, () =>
      database
        .select({
          status: tasks.status,
          pendingApprovalId: tasks.pendingApprovalId,
        })
        .from(tasks)
        .where(eq(tasks.runRef, runRef)),
    );
    expect(rows).toHaveLength(1);
    return rows[0] as { status: string; pendingApprovalId: string | null };
  };
  return {
    agentId,
    turnId,
    threadId,
    events,
    device,
    request,
    answers,
    approvals,
    card,
    settled,
    bridge,
  };
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  what: string,
) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const decide = async (actorId: string, id: string, decision: string) =>
  call(actorId, `${id}/decision`, { decision });

describe("an external employee's permission requests", () => {
  test("same requestId reported twice opens one approval", async () => {
    const hirer = await person("hirer");
    const { request, approvals, answers, card, device, turnId } =
      await harness(hirer);
    // What the turn did before it asked: a step finished, a file changed.
    await device({
      type: "acp.update",
      turnId,
      seq: 1,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "edit-1",
        kind: "edit",
        title: "Fix the login form",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "src/login.ts",
            oldText: "a\n",
            newText: "b\n",
          },
        ],
      },
    });
    await request("req-1", "git push origin main");
    // The computer reconnects and reports the same request again.
    await request("req-1", "git push origin main");
    const rows = await approvals();
    expect(rows).toHaveLength(1);
    const row = rows[0] as (typeof rows)[number];
    expect(row.status).toBe("pending");
    expect(answers()).toHaveLength(0);
    // What the card shows: the command as the agent sent it, who, where, and why it asks.
    expect(row.action.toolRef).toBe("acp/execute");
    expect(row.action.args).toEqual({ command: "git push origin main" });
    expect(row.action.policy?.source).toBe("acp_rule");
    const shown = (row.action.target as { acp: AcpApprovalCard }).acp;
    expect(shown).toMatchObject({
      employee: "小码",
      computer: "何总的 MacBook Pro",
      action: "小码想要运行命令：git push origin main",
      // Not on the list of everyday commands, and a push.
      hit: "提交并推送代码、运行命令",
      offerConversation: true,
      requestId: "req-1",
      summary: "这一轮已完成：Fix the login form",
      files: ["src/login.ts"],
    });
    // The turn's one card waits on it.
    expect(await card()).toEqual({
      status: "needs_action",
      pendingApprovalId: row.id,
    });
  });

  test("a group member who is not the hirer gets 403 deciding", async () => {
    const hirer = await person("hirer");
    const member = await person("member");
    const groupOwner = await person("owner");
    const { request, approvals, answers, card } = await harness(hirer);
    await request("req-1", "git push origin main");
    const [row] = await approvals();
    if (!row) throw new Error("expected an approval");
    // The member who @-mentioned it, and the group's owner: not theirs to answer.
    for (const stranger of [member, groupOwner]) {
      const refused = await decide(stranger.id, row.id, "allow_once");
      expect(refused.status).toBe(403);
    }
    expect((await approvals())[0]?.status).toBe("pending");
    expect(answers()).toHaveLength(0);
    expect((await card()).status).toBe("needs_action");
    // "Always allow here" is not one of the hirer's three answers either.
    expect((await decide(hirer.id, row.id, "allow_always")).status).toBe(400);
    // The hirer can.
    const allowed = await decide(hirer.id, row.id, "allow_once");
    expect(allowed.status).toBe(200);
    expect(answers()).toEqual([
      expect.objectContaining({ requestId: "req-1", optionId: "yes" }),
    ]);
    await until(
      async () => (await card()).status === "running",
      "the card back to running",
    );
    expect((await card()).pendingApprovalId).toBeNull();
  });

  test("allow_conversation answers allow_always and auto-allows the next same-kind request in the thread", async () => {
    const hirer = await person("hirer");
    const { request, approvals, answers } = await harness(hirer);
    await request("req-1", "git push origin main");
    const [row] = await approvals();
    if (!row) throw new Error("expected an approval");
    expect((await decide(hirer.id, row.id, "allow_conversation")).status).toBe(
      200,
    );
    expect(answers()).toEqual([
      expect.objectContaining({ requestId: "req-1", optionId: "always" }),
    ]);
    // The same command asked again in this thread is let through, once, with no new approval.
    await request("req-2", "git push  origin main");
    expect(answers()).toHaveLength(2);
    expect(answers()[1]).toMatchObject({ requestId: "req-2", optionId: "yes" });
    expect(await approvals()).toHaveLength(1);
    // Any other command still asks: another push, another kind of request.
    await request("req-3", "git push origin feature");
    await request("req-4", "pnpm add zod");
    expect(await approvals()).toHaveLength(3);
    expect(answers()).toHaveLength(2);
  });

  test("after rm -rf build was allowed once, rm -rf ~ still asks", async () => {
    const hirer = await person("hirer");
    const { request, approvals, answers } = await harness(hirer, {
      runCommand: "direct",
    });
    await request("req-1", "rm -rf build");
    const [row] = await approvals();
    if (!row) throw new Error("expected an approval");
    // A floor: only allow once.
    expect(row.action.policy?.source).toBe("destructive_tool");
    expect(
      (row.action.target as { acp: AcpApprovalCard }).acp.offerConversation,
    ).toBe(false);
    expect((await decide(hirer.id, row.id, "allow_conversation")).status).toBe(
      400,
    );
    expect((await decide(hirer.id, row.id, "allow_once")).status).toBe(200);
    expect(answers()).toEqual([
      expect.objectContaining({ requestId: "req-1", optionId: "yes" }),
    ]);
    await request("req-2", "rm -rf ~");
    await request("req-3", "rm -rf build");
    const rows = await approvals();
    expect(rows).toHaveLength(3);
    expect(rows.filter((entry) => entry.status === "pending")).toHaveLength(2);
    expect(answers()).toHaveLength(1);
  });

  test("switch_mode is refused at once, with no approval", async () => {
    const hirer = await person("hirer");
    const { device, turnId, approvals, answers } = await harness(hirer);
    await device({
      type: "acp.permission.request",
      turnId,
      requestId: "req-mode",
      toolCall: {
        toolCallId: "m",
        kind: "switch_mode",
        title: "Auto-accept edits",
      },
      options: OPTIONS,
      facts: { insideWorkdir: null, paths: [] },
    });
    expect(await approvals()).toHaveLength(0);
    expect(answers()).toEqual([
      expect.objectContaining({ requestId: "req-mode", optionId: "no" }),
    ]);
  });

  test("deny answers reject_once", async () => {
    const hirer = await person("hirer");
    const { request, approvals, answers, card } = await harness(hirer);
    await request("req-1", "git push origin main");
    const [row] = await approvals();
    if (!row) throw new Error("expected an approval");
    expect((await decide(hirer.id, row.id, "deny")).status).toBe(200);
    expect(answers()).toEqual([
      expect.objectContaining({ requestId: "req-1", optionId: "no" }),
    ]);
    // The turn goes on running on the computer: its card is not failed by a refusal.
    await until(
      async () => (await card()).status === "running",
      "the card back to running",
    );
    // Nothing is resumed by the approval loop for an external employee's request.
    const queued = await runAsTenant("platform", () =>
      database
        .select({ key: workItems.key })
        .from(workItems)
        .where(eq(workItems.key, row.id)),
    );
    expect(queued).toHaveLength(0);
  });

  test("a rule that refuses answers reject_once at once and says which rule", async () => {
    const hirer = await person("hirer");
    const harnessed = await harness(hirer);
    await runAsTenant(hirer.id, () =>
      store.policy.createRule(hirer.id, {
        botId: harnessed.agentId,
        toolRef: "acp/execute",
        effect: "*",
        scope: "*",
        behaviour: "deny",
      }),
    );
    await harnessed.request("req-1", "npm test");
    expect(await harnessed.approvals()).toHaveLength(0);
    expect(harnessed.answers()).toEqual([
      expect.objectContaining({ requestId: "req-1", optionId: "no" }),
    ]);
    const said = harnessed.events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as { delta?: string }).delta)
      .join("");
    expect(said).toContain("已按你的规则自动拒绝");
  });

  for (const [how, ending] of [
    [
      "cancelled",
      {
        type: "acp.turn.end",
        stopReason: "cancelled",
        interrupted: false,
      },
    ],
    [
      "interrupted",
      { type: "acp.turn.end", stopReason: "interrupted", interrupted: true },
    ],
    [
      "ask_mode_lost",
      {
        type: "acp.error",
        code: "ask_mode_lost",
        message: "智能体离开了先问再做的模式。",
      },
    ],
  ] as const)
    test(`a turn that ends (${how}) while its approval is open expires it and leaves the card unparked`, async () => {
      const hirer = await person("hirer");
      const { request, approvals, device, turnId, card, answers } =
        await harness(hirer);
      await request("req-1", "git push origin main");
      expect((await card()).status).toBe("needs_action");
      await device({ ...ending, turnId });
      await until(
        async () => (await approvals())[0]?.status === "denied",
        "the approval expired",
      );
      const [row] = await approvals();
      expect(row?.result?.error).toBe(ACP_PERMISSION_EXPIRED);
      await until(
        async () => (await card()).status !== "needs_action",
        "the card unparked",
      );
      expect((await card()).pendingApprovalId).toBeNull();
      // Answering it afterwards does nothing: it is no longer waiting.
      if (row)
        expect((await decide(hirer.id, row.id, "allow_once")).status).toBe(400);
      expect(answers()).toHaveLength(0);
    });

  test("an answer the agent does not take marks the approval failed and is not sent again", async () => {
    const hirer = await person("hirer");
    const { request, approvals, device, turnId, answers } =
      await harness(hirer);
    await request("req-1", "git push origin main");
    const [row] = await approvals();
    if (!row) throw new Error("expected an approval");
    await decide(hirer.id, row.id, "allow_once");
    expect(answers()).toHaveLength(1);
    await device({
      type: "acp.error",
      turnId,
      code: "bad_option",
      message: "这个回答不是智能体给出的选项之一，已按取消处理。",
    });
    await until(
      async () => (await approvals())[0]?.result?.error === ACP_BAD_OPTION,
      "the approval marked failed",
    );
    // Reported again: not answered again.
    await request("req-1", "git push origin main");
    expect(answers()).toHaveLength(1);
  });
});
