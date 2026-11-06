import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  APPROVAL_OUTCOME_UNKNOWN,
  ApprovalRecoveryBlockedError,
  type ApprovalResumeDependencies,
  createApprovalService,
  DECLINED_BY_PERSON,
} from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalAction,
  type ApprovalContinuation,
  ApprovalNotFoundError,
  type ApprovalStore,
  parseApprovalContinuation,
  withApprovalContext,
} from "../src/approvals/types";
import { createComputerGateway } from "../src/computer/gateway";
import {
  createHeadlessComputerTools,
  HeadlessToolSuspension,
} from "../src/computer/headless-tools";
import { createDatabase } from "../src/db/client";
import { approvalRequests } from "../src/db/schema/approvals";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The production composition of approval resume (`settlement: "database"`, as index.ts builds it):
 * no Root-attested port, the real Postgres store and row security, the real gateway and gate. The
 * Bot asks to run a dangerous command, the SEC1 floor holds it for the person, and the person's
 * answer is carried out by the server, fenced on the approval row. The machine is a local fetch seam
 * that counts every command that reached it.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `settle-${randomUUID()}`;
const owner = `${prefix}-owner`;
const stranger = `${prefix}-stranger`;
const botId = `${prefix}-bot`;
const realStore = createApprovalStore(database);
const asOwner = <T>(work: () => T) => runAsTenant(owner, work);
const DANGEROUS = "Remove-Item -Recurse -Force C:\\xiongbao-test";

/** Every command that reached the machine, in order. */
const commands: string[] = [];
/** Set to hold the machine mid-command, so a test can act while the action is running. */
let holdMachine: Promise<void> | undefined;
let machineEntered: (() => void) | undefined;

const gateway = createComputerGateway({
  provider: {
    name: "test",
    isolation: "per-bot",
    locate: async () => "http://computer:4100",
    status: async (id) => ({ botId: id, state: "ready" }),
    list: async () => [],
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
  },
  auditStore: { insert: async () => undefined },
  policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
  approvalGate: (candidate) => currentService.gate(candidate),
  fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path !== "/exec") throw new Error(`Unexpected ${path}`);
    const { command } = JSON.parse(String(init?.body)) as { command: string };
    commands.push(command);
    machineEntered?.();
    if (holdMachine) await holdMachine;
    return Response.json({
      command,
      exitCode: 0,
      stdout: "removed C:\\xiongbao-test",
      stderr: "",
      truncated: false,
      timedOut: false,
      elapsedMs: 1,
    });
  },
});

let currentService = createApprovalService(realStore, undefined, undefined, {
  settlement: "database",
});
/** The same composition over a store whose methods a test may wrap. */
const serviceOver = (store: ApprovalStore) =>
  createApprovalService(store, undefined, undefined, { settlement: "database" });

const runTool = (snapshot: ApprovalContinuation, actorId: string, bot: string) => {
  const tool = createHeadlessComputerTools({
    gateway,
    botId: bot,
    actor: { id: actorId, userId: actorId, initiator: { kind: "person" } },
  }).find((candidate) => candidate.definition.name === snapshot.toolName);
  if (!tool) throw new Error("no tool");
  return withApprovalContext(snapshot, () =>
    tool.execute(snapshot.args, {
      toolCallId: snapshot.toolCallId,
      signal: new AbortController().signal,
    }),
  );
};
const execute = (action: ApprovalAction) =>
  runTool(
    parseApprovalContinuation(action.continuation),
    action.actorId,
    action.botId,
  );

function snapshot(command = DANGEROUS): ApprovalContinuation {
  const toolCallId = randomUUID();
  const args = { command };
  return {
    runId: randomUUID(),
    threadId: `${prefix}-thread-${randomUUID()}`,
    toolCallId,
    toolName: "computer_run_command",
    args,
    messages: [
      { id: "u1", role: "user", content: "Delete the xiongbao-test folder" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: toolCallId,
            type: "function",
            function: {
              name: "computer_run_command",
              arguments: JSON.stringify(args),
            },
          },
        ],
      },
    ],
    state: {},
    context: [],
    forwardedProps: {},
  };
}

/** The Bot's call is held for the person by the dangerous-command floor; returns the request id. */
async function ask(call = snapshot()): Promise<string> {
  let waiting: unknown;
  try {
    await asOwner(() => runTool(call, owner, botId));
  } catch (error) {
    waiting = error;
  }
  if (!(waiting instanceof HeadlessToolSuspension))
    throw new Error(`expected the command to wait, got ${String(waiting)}`);
  const id = waiting.waiting.requestId;
  if (typeof id !== "string") throw new Error("no request id");
  return id;
}

type Continued = Parameters<ApprovalResumeDependencies["continue"]>[0];
function worker(
  continued: Continued[],
  extra: Partial<ApprovalResumeDependencies> = {},
): ApprovalResumeDependencies {
  return {
    validate: (action) =>
      currentService.validateReentry(action, () => execute(action)),
    execute,
    continue: async (input) => {
      continued.push(structuredClone(input));
    },
    ...extra,
  };
}
const row = (id: string) => asOwner(() => realStore.get(owner, id));

beforeAll(async () => {
  await runAsTenant("platform", () =>
    database.insert(users).values([
      { id: owner, email: `${owner}@example.test` },
      { id: stranger, email: `${stranger}@example.test` },
    ]),
  );
});
afterAll(async () => {
  const ids = (await asOwner(() => realStore.list(owner))).map((r) => r.id);
  if (ids.length)
    await asOwner(() =>
      database
        .delete(workItems)
        .where(
          and(eq(workItems.kind, "approval.resume"), inArray(workItems.key, ids)),
        ),
    );
  await runAsTenant("platform", () =>
    database.delete(users).where(inArray(users.id, [owner, stranger])),
  );
  await database.$client.close();
});

test("approve runs the held command exactly once, through the gateway, and the conversation continues with its result", async () => {
  commands.length = 0;
  const call = snapshot();
  const id = await ask(call);
  expect(commands).toEqual([]);
  expect((await row(id)).action.policy?.source).toBe("dangerous_command");

  await asOwner(() => currentService.decide(owner, id, "allow_once"));
  const continued: Continued[] = [];
  await asOwner(() => currentService.resume(owner, id, worker(continued)));

  expect(commands).toEqual([DANGEROUS]);
  expect(continued).toHaveLength(1);
  const [first] = continued;
  expect(first?.approvalId).toBe(id);
  expect(first?.messageId).toBe(`approval:${id}`);
  expect(first?.continuation.toolCallId).toBe(call.toolCallId);
  expect(first?.continuation.threadId).toBe(call.threadId);
  expect(first?.result.error).toBeUndefined();
  expect(first?.result.content).toContain("removed C:\\\\xiongbao-test");
  const settled = await row(id);
  expect(settled.status).toBe("completed");
  expect(settled.result).toEqual(first?.result ?? null);

  // The queue handing the item out again, and the Bot repeating the same call, change nothing.
  await asOwner(() => currentService.resume(owner, id, worker(continued)));
  await asOwner(() => runTool(call, owner, botId));
  expect(commands).toEqual([DANGEROUS]);
  expect(continued).toHaveLength(1);
});

test("reject never runs the command and tells the conversation it was the person's decision", async () => {
  commands.length = 0;
  const id = await ask();
  await asOwner(() => currentService.decide(owner, id, "deny"));
  const continued: Continued[] = [];
  await asOwner(() => currentService.resume(owner, id, worker(continued)));
  await asOwner(() => currentService.resume(owner, id, worker(continued)));
  expect(commands).toEqual([]);
  expect(continued.map((input) => input.result)).toEqual([
    { content: DECLINED_BY_PERSON, error: DECLINED_BY_PERSON },
  ]);
  expect((await row(id)).status).toBe("completed");
});

test("two workers resuming at once claim the run in the database once: one command, one continuation", async () => {
  commands.length = 0;
  const id = await ask();
  await asOwner(() => currentService.decide(owner, id, "allow_once"));
  // Both workers reach the claim before either takes it, so the row lock decides between them.
  let arrived = 0;
  let open: () => void = () => undefined;
  const bothThere = new Promise<void>((resolve) => {
    open = resolve;
  });
  const claims: boolean[] = [];
  const racing: ApprovalStore = {
    ...realStore,
    consume: async (...args) => {
      arrived += 1;
      if (arrived === 2) open();
      await bothThere;
      const won = await realStore.consume(...args);
      claims.push(won);
      return won;
    },
  };
  const previous = currentService;
  currentService = serviceOver(racing);
  try {
    const continued: Continued[] = [];
    await Promise.all([
      asOwner(() => currentService.resume(owner, id, worker(continued))),
      asOwner(() => currentService.resume(owner, id, worker(continued))),
    ]);
    expect(claims.sort()).toEqual([false, true]);
    expect(commands).toEqual([DANGEROUS]);
    expect(continued).toHaveLength(1);
    expect(continued[0]?.result.error).toBeUndefined();
    expect((await row(id)).status).toBe("completed");
  } finally {
    currentService = previous;
  }
});

test("a run that was claimed but never saved (the worker crashed) is not run again and ends as outcome unknown", async () => {
  commands.length = 0;
  const id = await ask();
  await asOwner(() => currentService.decide(owner, id, "allow_once"));
  // The crashed worker's claim: approved → consumed, and nothing saved after it.
  const request = await row(id);
  expect(
    await asOwner(() =>
      realStore.consume(owner, id, request.action.actionDigest),
    ),
  ).toBe(true);
  const continued: Continued[] = [];
  await asOwner(() => currentService.resume(owner, id, worker(continued)));
  expect(commands).toEqual([]);
  expect(continued.map((input) => input.result)).toEqual([
    { content: APPROVAL_OUTCOME_UNKNOWN, error: APPROVAL_OUTCOME_UNKNOWN },
  ]);
  const settled = await row(id);
  expect(settled.status).toBe("completed");
  expect(settled.result?.error).toBe(APPROVAL_OUTCOME_UNKNOWN);
});

test("a worker that finds the run still in flight never starts it again, and the late result is not published", async () => {
  commands.length = 0;
  const id = await ask();
  await asOwner(() => currentService.decide(owner, id, "allow_once"));
  let release: () => void = () => undefined;
  holdMachine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    machineEntered = resolve;
  });
  const continued: Continued[] = [];
  try {
    const first = asOwner(() =>
      currentService.resume(owner, id, worker(continued)),
    );
    await entered;
    // The first worker's lease is gone; another takes the item while the command is running.
    await asOwner(() => currentService.resume(owner, id, worker(continued)));
    release();
    await first;
  } finally {
    holdMachine = undefined;
    machineEntered = undefined;
    release();
  }
  expect(commands).toEqual([DANGEROUS]);
  expect(continued.map((input) => input.result)).toEqual([
    { content: APPROVAL_OUTCOME_UNKNOWN, error: APPROVAL_OUTCOME_UNKNOWN },
  ]);
  expect((await row(id)).status).toBe("completed");
});

test("the result is saved before it is published: a failed continuation is retried with that result and the command is not repeated", async () => {
  commands.length = 0;
  const id = await ask();
  await asOwner(() => currentService.decide(owner, id, "allow_once"));
  const continued: Continued[] = [];
  await expect(
    asOwner(() =>
      currentService.resume(
        owner,
        id,
        worker(continued, {
          continue: async () => {
            throw new Error("the model provider is unreachable");
          },
        }),
      ),
    ),
  ).rejects.toThrow("the model provider is unreachable");
  const saved = await row(id);
  expect(saved.status).toBe("consumed");
  expect(saved.result?.content).toContain("removed");
  expect(commands).toEqual([DANGEROUS]);

  await asOwner(() => currentService.resume(owner, id, worker(continued)));
  expect(commands).toEqual([DANGEROUS]);
  expect(continued.map((input) => input.result)).toEqual([saved.result]);
  expect((await row(id)).status).toBe("completed");
});

test("the queue's last try abandons without running: the Bot is told it could not be carried out", async () => {
  commands.length = 0;
  const id = await ask();
  await asOwner(() => currentService.decide(owner, id, "allow_once"));
  const continued: Continued[] = [];
  await asOwner(() =>
    currentService.abandon(owner, id, "network down", worker(continued)),
  );
  expect(commands).toEqual([]);
  expect(continued).toHaveLength(1);
  expect(continued[0]?.result.error).toContain("could not be carried out");
  expect(continued[0]?.result.error).toContain("network down");
  expect((await row(id)).status).toBe("completed");
});

test("a refusal (the Bot may no longer run) ends the request without running or continuing", async () => {
  commands.length = 0;
  const id = await ask();
  await asOwner(() => currentService.decide(owner, id, "allow_once"));
  const continued: Continued[] = [];
  const refusal = "Use Bots is switched off for you.";
  await asOwner(() =>
    currentService.resume(
      owner,
      id,
      worker(continued, { refusal: async () => refusal }),
    ),
  );
  expect(commands).toEqual([]);
  expect(continued).toEqual([]);
  const settled = await row(id);
  expect(settled.status).toBe("completed");
  expect(settled.result).toEqual({ content: refusal, error: refusal });
});

test("only the owner's own frame can resume it, and a row whose binding was altered is never run", async () => {
  commands.length = 0;
  const id = await ask();
  await asOwner(() => currentService.decide(owner, id, "allow_once"));
  const continued: Continued[] = [];
  // Another person's frame does not see the row at all (G01), whoever the call names.
  await expect(
    runAsTenant(stranger, () =>
      currentService.resume(owner, id, worker(continued)),
    ),
  ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  await expect(
    runAsTenant(stranger, () =>
      currentService.resume(stranger, id, worker(continued)),
    ),
  ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  // The saved action no longer names the run its row was opened for.
  await asOwner(() =>
    database
      .update(approvalRequests)
      .set({
        action: sql`jsonb_set(${approvalRequests.action}, '{runId}', '"another-run"')`,
      })
      .where(eq(approvalRequests.id, id)),
  );
  await expect(
    asOwner(() => currentService.resume(owner, id, worker(continued))),
  ).rejects.toBeInstanceOf(ApprovalRecoveryBlockedError);
  await expect(
    asOwner(() =>
      currentService.abandon(owner, id, "gave up", worker(continued)),
    ),
  ).rejects.toBeInstanceOf(ApprovalRecoveryBlockedError);
  expect(commands).toEqual([]);
  expect(continued).toEqual([]);
  const untouched = await row(id);
  expect(untouched.status).toBe("approved");
  expect(untouched.result).toBeNull();
});
