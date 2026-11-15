import { afterAll, afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AcpClient,
  type AcpSpawnSpec,
  createAcpClient,
} from "../src/acp/client";
import { type AcpHost, capFrame, createAcpHost } from "../src/acp/host";
import type { AppEntry } from "../src/apps";
import type { FakeAcpScript } from "./fixtures/fake-acp-agent";

/*
 * The runner's ACP session host against the scriptable fake agent. `spawn` is injected: it records
 * the spec the host asked for and starts the fake agent in its place, so every test sees real child
 * processes and the real client. Every host is closed after its test, so no child outlives the run.
 */

type Frame = Record<string, unknown>;

const fixture = join(import.meta.dir, "fixtures", "fake-acp-agent.ts");
const scratch = mkdtempSync(join(tmpdir(), "openbot-runner-acp-host-"));
const work = join(scratch, "work");
mkdirSync(work, { recursive: true });

const ADAPTERS = join(scratch, "data", "acp-adapters");
const ROOT = `fld_${"a".repeat(22)}`;
const APP = `app_${"b".repeat(22)}`;
const FAKE_APP: AppEntry = {
  ref: APP,
  name: "Fake agent",
  kind: "stdio",
  command: process.execPath,
  args: [fixture],
  env: {},
  enabled: true,
};

const hosts: AcpHost[] = [];
let logs = 0;

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.closeAll();
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Setup = {
  host: AcpHost;
  frames: Frame[];
  send: (frame: Frame) => void;
  spawns: AcpSpawnSpec[];
  clients: AcpClient[];
  logs: string[];
  /** How many `prompt` calls have settled, either way. */
  settled: () => number;
};

function setup(
  script: FakeAcpScript | ((spawn: number) => FakeAcpScript),
  opts: {
    idleMs?: number;
    bufferLimit?: { count: number; bytes: number };
    endedLimit?: { turns: number; bytes: number };
    apps?: (ref: string) => AppEntry | null;
    processEnv?: () => Promise<Record<string, string | undefined>>;
    cancelGraceMs?: number;
    frameLimit?: number;
  } = {},
): Setup {
  const frames: Frame[] = [];
  const spawns: AcpSpawnSpec[] = [];
  const clients: AcpClient[] = [];
  const logFiles: string[] = [];
  let settled = 0;
  const host = createAcpHost({
    roots: (ref) => (ref === ROOT ? work : null),
    apps: opts.apps ?? ((ref) => (ref === APP ? FAKE_APP : null)),
    adapterDir: ADAPTERS,
    ...(opts.processEnv ? { processEnv: opts.processEnv } : {}),
    ...(opts.cancelGraceMs === undefined
      ? {}
      : { cancelGraceMs: opts.cancelGraceMs }),
    ...(opts.frameLimit === undefined ? {} : { frameLimit: opts.frameLimit }),
    spawn: (spec, handlers, clientOpts) => {
      spawns.push(spec);
      const log = join(scratch, `log-${++logs}.jsonl`);
      logFiles.push(log);
      const base =
        typeof script === "function" ? script(spawns.length) : script;
      const scriptFile = join(scratch, `script-${logs}.json`);
      writeFileSync(scriptFile, JSON.stringify({ ...base, log }));
      const client = createAcpClient(
        {
          ...spec,
          command: process.execPath,
          args: [fixture],
          env: { FAKE_ACP_SCRIPT_FILE: scriptFile },
          cwd: work,
        },
        handlers,
        clientOpts,
      );
      clients.push(client);
      return {
        initialize: () => client.initialize(),
        newSession: (cwd) => client.newSession(cwd),
        loadSession: (id, cwd) => client.loadSession(id, cwd),
        prompt: (id, content) =>
          client.prompt(id, content).finally(() => {
            settled += 1;
          }),
        cancel: (id) => client.cancel(id),
        close: () => client.close(),
        get alive() {
          return client.alive;
        },
      };
    },
    ...(opts.idleMs === undefined ? {} : { idleMs: opts.idleMs }),
    ...(opts.bufferLimit ? { bufferLimit: opts.bufferLimit } : {}),
    ...(opts.endedLimit ? { endedLimit: opts.endedLimit } : {}),
  });
  hosts.push(host);
  return {
    host,
    frames,
    send: (frame) => frames.push(frame),
    spawns,
    clients,
    logs: logFiles,
    settled: () => settled,
  };
}

async function waitFor(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const open = (threadId: string, extra: Frame = {}): Frame => ({
  type: "acp.open",
  agentId: "agent_1",
  threadId,
  harness: "custom",
  workdirRef: ROOT,
  appRef: APP,
  ...extra,
});
const prompt = (
  threadId: string,
  turnId: string,
  agentId = "agent_1",
): Frame => ({
  type: "acp.prompt",
  agentId,
  threadId,
  turnId,
  content: [{ type: "text", text: "hello" }],
});
const chunk = (text: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

const ofType = (frames: Frame[], type: string) =>
  frames.filter((frame) => frame.type === type);
const ofTurn = (frames: Frame[], turnId: string) =>
  frames.filter((frame) => frame.turnId === turnId);
const ended = (frames: Frame[], turnId: string) =>
  frames.some(
    (frame) => frame.type === "acp.turn.end" && frame.turnId === turnId,
  );

function received(log: string): Frame[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("acp.prompt acks, streams numbered updates and ends the turn", async () => {
  const t = setup({
    turns: [
      {
        steps: [
          { update: chunk("a") },
          { update: chunk("b") },
          { update: chunk("c") },
        ],
      },
    ],
  });
  t.host.attach(t.send);
  expect(await t.host.handle({ type: "screen.start" })).toBe(false);
  expect(await t.host.handle(open("th_1"))).toBe(true);
  expect(await t.host.handle(prompt("th_1", "turn_1"))).toBe(true);
  await waitFor(() => ended(t.frames, "turn_1"));

  const turn = ofTurn(t.frames, "turn_1");
  expect(turn.map((frame) => frame.type)).toEqual([
    "acp.turn.ack",
    "acp.update",
    "acp.update",
    "acp.update",
    "acp.turn.end",
  ]);
  expect(turn.slice(1, 4)).toEqual([
    {
      type: "acp.update",
      agentId: "agent_1",
      threadId: "th_1",
      turnId: "turn_1",
      seq: 1,
      update: chunk("a"),
    },
    {
      type: "acp.update",
      agentId: "agent_1",
      threadId: "th_1",
      turnId: "turn_1",
      seq: 2,
      update: chunk("b"),
    },
    {
      type: "acp.update",
      agentId: "agent_1",
      threadId: "th_1",
      turnId: "turn_1",
      seq: 3,
      update: chunk("c"),
    },
  ]);
  expect(turn[4]).toEqual({
    type: "acp.turn.end",
    agentId: "agent_1",
    threadId: "th_1",
    turnId: "turn_1",
    stopReason: "end_turn",
    interrupted: false,
  });
  expect(ofType(t.frames, "acp.session")).toEqual([
    {
      type: "acp.session",
      agentId: "agent_1",
      threadId: "th_1",
      sessionId: "sess_1",
      loaded: false,
    },
  ]);
  // A custom agent's spec comes from its registered app, with no session mode.
  expect(t.spawns).toHaveLength(1);
  expect(t.spawns[0]?.sessionMode).toBeNull();
  expect(t.spawns[0]?.command).toBe(process.execPath);
});

test("an ended turn keeps no prompt content, only what a replay needs", async () => {
  const t = setup({ turns: [{ steps: [{ update: chunk("done") }] }] });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"));
  expect(t.host.heldPrompt("turn_1")).toEqual([]);
  // A cancelled queued turn lets go of its words too.
  await t.host.handle(prompt("th_1", "turn_2"));
  await t.host.handle(prompt("th_1", "turn_3"));
  await t.host.handle({
    type: "acp.cancel",
    agentId: "agent_1",
    threadId: "th_1",
    turnId: "turn_3",
  });
  await waitFor(() => ended(t.frames, "turn_3"));
  expect(t.host.heldPrompt("turn_3")).toEqual([]);
  // The replay still has everything: the end goes up again on the next attach.
  t.host.detach();
  const replay: Record<string, unknown>[] = [];
  t.host.attach((frame) => replay.push(frame));
  expect(
    replay.some(
      (frame) => frame.type === "acp.turn.end" && frame.turnId === "turn_1",
    ),
  ).toBe(true);
});

test("a turnId seen before is acknowledged again and never run twice", async () => {
  const t = setup({ turns: [{ steps: [{ update: chunk("once") }] }] });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(
    () => ofType(ofTurn(t.frames, "turn_1"), "acp.turn.end").length === 2,
  );
  expect(ofType(ofTurn(t.frames, "turn_1"), "acp.update")).toHaveLength(1);
  const log = t.logs[0] ?? "";
  expect(
    received(log).filter((m) => m.method === "session/prompt"),
  ).toHaveLength(1);
});

test("updates sent while detached are replayed in order on attach", async () => {
  const t = setup({
    turns: [
      {
        steps: [
          { update: chunk("1") },
          { sleepMs: 300 },
          { update: chunk("2") },
          { update: chunk("3") },
        ],
      },
    ],
  });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ofType(t.frames, "acp.update").length === 1);
  t.host.detach();
  await waitFor(() => t.settled() === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const before = t.frames.length;
  expect(ended(t.frames, "turn_1")).toBe(false);

  t.host.attach(t.send);
  // Every frame of the turn comes again in order, the ones that went up before the detach too.
  const replayed = ofTurn(t.frames.slice(before), "turn_1");
  expect(replayed.map((frame) => [frame.type, frame.seq])).toEqual([
    ["acp.turn.ack", undefined],
    ["acp.update", 1],
    ["acp.update", 2],
    ["acp.update", 3],
    ["acp.turn.end", undefined],
  ]);
  expect(ofType(t.frames.slice(before), "acp.session")).toHaveLength(1);

  // Replayed is not delivered: the next attach replays it again, until a beat's ack proves it.
  t.host.detach();
  let mark = t.frames.length;
  t.host.attach(t.send);
  expect(ended(t.frames.slice(mark), "turn_1")).toBe(true);
  t.host.heartbeatSent();
  t.host.acked();
  t.host.detach();
  mark = t.frames.length;
  t.host.attach(t.send);
  expect(ofType(t.frames.slice(mark), "acp.inventory")).toHaveLength(1);
  expect(
    t.frames.slice(mark).filter((f) => f.type !== "acp.inventory"),
  ).toEqual([]);
});

test("a send that throws keeps the frame for the next attach", async () => {
  const t = setup({ turns: [{ steps: [{ update: chunk("x") }] }] });
  let dead = false;
  t.host.attach((frame) => {
    if (dead) throw new Error("socket closed");
    t.frames.push(frame);
  });
  await t.host.handle(open("th_1"));
  await waitFor(() => ofType(t.frames, "acp.session").length === 1);
  dead = true;
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => t.settled() === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  dead = false;
  t.host.attach(t.send);
  expect(ofTurn(t.frames, "turn_1").map((frame) => frame.type)).toEqual([
    "acp.turn.ack",
    "acp.update",
    "acp.turn.end",
  ]);
});

test("buffer over limit keeps the latest plan and each tool call's last state", async () => {
  const plan = (content: string) => ({
    sessionUpdate: "plan",
    entries: [{ content, priority: "medium", status: "pending" }],
  });
  const t = setup(
    {
      turns: [
        {
          steps: [
            { update: plan("v1") },
            {
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "call_1",
                title: "Edit a",
                kind: "edit",
                status: "pending",
              },
            },
            { update: chunk("m1") },
            {
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "call_1",
                status: "in_progress",
              },
            },
            { update: plan("v2") },
            {
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "call_2",
                title: "Run tests",
                kind: "execute",
                status: "pending",
              },
            },
            {
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "call_1",
                status: "completed",
              },
            },
            { update: chunk("m2") },
          ],
        },
      ],
    },
    { bufferLimit: { count: 3, bytes: 5_000_000 } },
  );
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => t.settled() === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  t.host.attach(t.send);

  const turn = ofTurn(t.frames, "turn_1");
  expect(turn[0]?.type).toBe("acp.turn.ack");
  expect(turn.at(-1)?.type).toBe("acp.turn.end");
  const updates = ofType(turn, "acp.update");
  expect(updates.map((frame) => frame.update)).toEqual([
    plan("v2"),
    {
      sessionUpdate: "tool_call",
      toolCallId: "call_2",
      title: "Run tests",
      kind: "execute",
      status: "pending",
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Edit a",
      kind: "edit",
      status: "completed",
    },
  ]);
  const seqs = updates.map((frame) => frame.seq as number);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(seqs.at(-1)).toBe(7);
});

test("pending permission is re-sent after reattach with the same requestId", async () => {
  const t = setup({
    turns: [
      {
        steps: [
          {
            permission: {
              toolCall: {
                toolCallId: "call_1",
                title: "Edit notes.md",
                kind: "edit",
                status: "pending",
                locations: [{ path: join(work, "notes.md") }],
              },
              options: [
                { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
                { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
              ],
            },
          },
        ],
      },
    ],
  });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ofType(t.frames, "acp.permission.request").length === 1);
  const asked = ofType(t.frames, "acp.permission.request")[0] as Frame;
  expect(asked).toMatchObject({
    threadId: "th_1",
    turnId: "turn_1",
    toolCall: { toolCallId: "call_1", kind: "edit" },
    options: [
      { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
      { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
    ],
    facts: { insideWorkdir: true, paths: ["notes.md"] },
  });
  expect(typeof asked.requestId).toBe("string");

  t.host.detach();
  t.host.attach(t.send);
  const again = ofType(t.frames, "acp.permission.request");
  expect(again).toHaveLength(2);
  expect(again[1]).toEqual(asked);

  // An answer to a request nobody asked is ignored.
  await t.host.handle({
    type: "acp.permission.answer",
    agentId: "agent_1",
    requestId: "perm_unknown",
    optionId: "opt-allow",
  });
  expect(
    await t.host.handle({
      type: "acp.permission.answer",
      agentId: "agent_1",
      requestId: asked.requestId,
      optionId: "opt-allow",
    }),
  ).toBe(true);
  await waitFor(() => ended(t.frames, "turn_1"));
  const outcome = ofType(t.frames, "acp.update").find(
    (frame) =>
      (frame.update as Frame).sessionUpdate === "fake_permission_outcome",
  );
  expect((outcome?.update as Frame | undefined)?.outcome).toEqual({
    outcome: "selected",
    optionId: "opt-allow",
  });
  // Answered: not asked again on the next connection.
  t.host.detach();
  t.host.attach(t.send);
  expect(ofType(t.frames, "acp.permission.request")).toHaveLength(2);
});

test("child dies mid-turn → acp.turn.end interrupted: true", async () => {
  const t = setup((spawn) =>
    spawn === 1
      ? { turns: [{ steps: [{ update: chunk("working") }, { exit: 3 }] }] }
      : { turns: [{ steps: [{ update: chunk("again") }] }] },
  );
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"));
  expect(ofType(ofTurn(t.frames, "turn_1"), "acp.turn.end")[0]).toEqual({
    type: "acp.turn.end",
    agentId: "agent_1",
    threadId: "th_1",
    turnId: "turn_1",
    stopReason: "interrupted",
    interrupted: true,
  });

  // The next turn on the thread starts a new process by itself.
  await t.host.handle(prompt("th_1", "turn_2"));
  await waitFor(() => ended(t.frames, "turn_2"));
  expect(t.spawns).toHaveLength(2);
  expect(ofType(ofTurn(t.frames, "turn_2"), "acp.turn.end")[0]).toMatchObject({
    stopReason: "end_turn",
    interrupted: false,
  });
});

test("idle adapter closes after idleMs and next open loads the session when supported", async () => {
  const t = setup({ loadSession: true }, { idleMs: 150 });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"));
  await waitFor(() => t.clients[0]?.alive === false, 3000);

  await t.host.handle(open("th_1", { sessionHint: "sess_1" }));
  await waitFor(() => ofType(t.frames, "acp.session").length === 2);
  expect(ofType(t.frames, "acp.session")[1]).toEqual({
    type: "acp.session",
    agentId: "agent_1",
    threadId: "th_1",
    sessionId: "sess_1",
    loaded: true,
  });
  expect(t.spawns).toHaveLength(2);
  const loads = received(t.logs[1] ?? "").filter(
    (message) => message.method === "session/load",
  );
  expect(loads).toHaveLength(1);
  expect((loads[0]?.params as Frame | undefined)?.sessionId).toBe("sess_1");
});

test("a prompt after the idle close reopens the thread by itself", async () => {
  const t = setup({ loadSession: true }, { idleMs: 150 });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"));
  await waitFor(() => t.clients[0]?.alive === false, 3000);

  await t.host.handle(prompt("th_1", "turn_2"));
  await waitFor(() => ended(t.frames, "turn_2"));
  expect(ofType(ofTurn(t.frames, "turn_2"), "acp.turn.end")[0]).toMatchObject({
    stopReason: "end_turn",
  });
  expect(ofType(t.frames, "acp.session")[1]).toMatchObject({
    sessionId: "sess_1",
    loaded: true,
  });
});

test("unknown workdirRef or appRef answers an error and spawns nothing", async () => {
  const t = setup({});
  t.host.attach(t.send);
  await t.host.handle(open("th_1", { workdirRef: `fld_${"z".repeat(22)}` }));
  await t.host.handle(open("th_2", { appRef: `app_${"z".repeat(22)}` }));
  await t.host.handle(open("th_3", { appRef: undefined }));
  await waitFor(() => ofType(t.frames, "acp.error").length === 3);
  expect(ofType(t.frames, "acp.error")).toMatchObject([
    { threadId: "th_1", code: "unknown_workdir" },
    { threadId: "th_2", code: "unknown_app" },
    { threadId: "th_3", code: "unknown_app" },
  ]);
  for (const error of ofType(t.frames, "acp.error")) {
    expect(JSON.stringify(error)).not.toContain(scratch);
  }

  // A turn for a thread that never opened is refused, not run.
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"));
  expect(ofTurn(t.frames, "turn_1")).toMatchObject([
    { type: "acp.turn.ack" },
    { type: "acp.error", threadId: "th_1", code: "not_open" },
    { type: "acp.turn.end", stopReason: "error", interrupted: false },
  ]);
  expect(t.spawns).toHaveLength(0);
});

test("a disabled or http app is not started as an agent", async () => {
  const t = setup(
    {},
    {
      apps: (ref) =>
        ref === APP
          ? { ...FAKE_APP, enabled: false }
          : {
              ref,
              name: "Web",
              kind: "http",
              url: "http://127.0.0.1:9",
              enabled: true,
            },
    },
  );
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(open("th_2", { appRef: `app_${"h".repeat(22)}` }));
  await waitFor(() => ofType(t.frames, "acp.error").length === 2);
  expect(ofType(t.frames, "acp.error")).toMatchObject([
    { code: "unknown_app" },
    { code: "unknown_app" },
  ]);
  expect(t.spawns).toHaveLength(0);
});

test("one process per employee; turns of one thread run in order, threads in parallel", async () => {
  const t = setup({
    turns: [{ steps: [{ sleepMs: 300 }, { update: chunk("done") }] }],
  });
  t.host.attach(t.send);
  await t.host.handle(open("th_a"));
  await t.host.handle(open("th_b"));
  await t.host.handle(prompt("th_a", "a1"));
  await t.host.handle(prompt("th_a", "a2"));
  await t.host.handle(prompt("th_b", "b1"));
  await waitFor(() => ended(t.frames, "a2"));
  expect(t.spawns).toHaveLength(1);
  const index = (type: string, turnId: string) =>
    t.frames.findIndex(
      (frame) => frame.type === type && frame.turnId === turnId,
    );
  // b1 does not wait behind th_a; a2 starts only after a1 ended.
  expect(index("acp.turn.end", "b1")).toBeLessThan(index("acp.turn.end", "a2"));
  expect(index("acp.turn.end", "a1")).toBeLessThan(index("acp.update", "a2"));
  const sessions = ofType(t.frames, "acp.session").map((f) => f.sessionId);
  expect(new Set(sessions).size).toBe(2);
});

test("cancel ends a queued turn at once and cancels the running one", async () => {
  const t = setup({
    turns: [{ steps: [{ update: chunk("started") }, { waitForCancel: true }] }],
  });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await t.host.handle(prompt("th_1", "turn_2"));
  await waitFor(
    () => ofType(ofTurn(t.frames, "turn_1"), "acp.update").length === 1,
  );

  await t.host.handle({
    type: "acp.cancel",
    agentId: "agent_1",
    threadId: "th_1",
    turnId: "turn_2",
  });
  await waitFor(() => ended(t.frames, "turn_2"));
  expect(ofType(ofTurn(t.frames, "turn_2"), "acp.turn.end")[0]).toMatchObject({
    stopReason: "cancelled",
    interrupted: false,
  });

  await t.host.handle({
    type: "acp.cancel",
    agentId: "agent_1",
    threadId: "th_1",
    turnId: "turn_1",
  });
  await waitFor(() => ended(t.frames, "turn_1"));
  expect(ofType(ofTurn(t.frames, "turn_1"), "acp.turn.end")[0]).toMatchObject({
    stopReason: "cancelled",
    interrupted: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  // turn_2 was never sent to the agent.
  expect(ofType(ofTurn(t.frames, "turn_2"), "acp.update")).toHaveLength(0);
  expect(
    received(t.logs[0] ?? "").filter((m) => m.method === "session/prompt"),
  ).toHaveLength(1);
});

test("a known agent is started from adapterLaunch with its ask mode", async () => {
  const t = setup({
    modes: {
      currentModeId: "agent",
      availableModes: [
        { id: "read-only", name: "Read only" },
        { id: "agent", name: "Agent" },
      ],
    },
  });
  t.host.attach(t.send);
  await t.host.handle(open("th_1", { harness: "codex", appRef: undefined }));
  await waitFor(() => ofType(t.frames, "acp.session").length === 1, 15_000);
  expect(t.spawns[0]).toMatchObject({
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@2.6.0"],
    // Started in the runner's own folder; the working folder is only the session's.
    cwd: ADAPTERS,
    sessionMode: "read-only",
  });
  expect(t.spawns[0]?.cwd).not.toBe(work);
  expect(t.spawns[0]?.env.INITIAL_AGENT_MODE).toBe("read-only");
  expect(t.spawns[0]?.env.npm_config_registry).toBeDefined();
  const created = received(t.logs[0] ?? "").filter(
    (message) => message.method === "session/new",
  );
  expect((created[0]?.params as Frame | undefined)?.cwd).toBe(work);
  const modes = received(t.logs[0] ?? "").filter(
    (message) => message.method === "session/set_mode",
  );
  expect((modes[0]?.params as Frame | undefined)?.modeId).toBe("read-only");
}, 20_000);

test("closeAll stops every adapter and refuses later opens", async () => {
  const t = setup({});
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await waitFor(() => ofType(t.frames, "acp.session").length === 1);
  await t.host.closeAll();
  expect(t.clients[0]?.alive).toBe(false);
  await t.host.handle(open("th_2"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(t.spawns).toHaveLength(1);
});

test("frames sent on a socket that silently drops are replayed on the next attach", async () => {
  const t = setup({
    turns: [
      {
        steps: [
          { update: chunk("1") },
          { update: chunk("2") },
          { waitForCancel: true },
        ],
      },
    ],
  });
  // Half-open: the socket still says OPEN, and nothing sent on it arrives.
  const lost: Frame[] = [];
  t.host.attach((frame) => lost.push(frame));
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ofType(lost, "acp.update").length === 2);

  t.host.detach();
  t.host.attach(t.send);
  expect(ofType(t.frames, "acp.session")).toHaveLength(1);
  expect(
    ofTurn(t.frames, "turn_1").map((frame) => [frame.type, frame.seq]),
  ).toEqual([
    ["acp.turn.ack", undefined],
    ["acp.update", 1],
    ["acp.update", 2],
  ]);

  // Still not over: the next attach replays all of it again.
  t.host.detach();
  let mark = t.frames.length;
  t.host.attach(t.send);
  expect(
    ofTurn(t.frames.slice(mark), "turn_1").map((frame) => frame.seq),
  ).toEqual([undefined, 1, 2]);
  // The session frame too: nothing proved the attach before delivered it.
  expect(ofType(t.frames.slice(mark), "acp.session")).toHaveLength(1);

  // The turn ends on a socket that swallows its last update and its end.
  t.host.detach();
  const lostAgain: Frame[] = [];
  t.host.attach((frame) => lostAgain.push(frame));
  await t.host.handle({
    type: "acp.cancel",
    agentId: "agent_1",
    threadId: "th_1",
    turnId: "turn_1",
  });
  await waitFor(() => ended(lostAgain, "turn_1"));
  // The attach replayed 1 and 2 into it, then 3 and the end went the same way.
  expect(ofType(lostAgain, "acp.update").map((frame) => frame.seq)).toEqual([
    1, 2, 3,
  ]);
  t.host.detach();
  mark = t.frames.length;
  t.host.attach(t.send);
  const replayed = ofTurn(t.frames.slice(mark), "turn_1");
  expect(replayed.map((frame) => [frame.type, frame.seq])).toEqual([
    ["acp.turn.ack", undefined],
    ["acp.update", 1],
    ["acp.update", 2],
    ["acp.update", 3],
    ["acp.turn.end", undefined],
  ]);
  expect((replayed[3]?.update as Frame | undefined)?.sessionUpdate).toBe(
    "fake_cancel_seen",
  );
  expect(replayed[4]).toMatchObject({
    stopReason: "cancelled",
    interrupted: false,
  });
  // Kept until a beat sent after the replay is acked; then the next attach leaves it alone.
  t.host.heartbeatSent();
  t.host.acked();
  t.host.detach();
  mark = t.frames.length;
  t.host.attach(t.send);
  expect(ofTurn(t.frames.slice(mark), "turn_1")).toEqual([]);
});

test("a frame arriving after a turn's end is neither sent nor kept", async () => {
  const t = setup({
    turns: [
      {
        steps: [{ update: chunk("in time") }],
        after: [chunk("late"), chunk("later")],
      },
    ],
  });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(ofType(ofTurn(t.frames, "turn_1"), "acp.update")).toHaveLength(1);

  t.host.detach();
  let mark = t.frames.length;
  t.host.attach(t.send);
  const replayed = ofTurn(t.frames.slice(mark), "turn_1");
  expect(replayed.map((frame) => [frame.type, frame.seq])).toEqual([
    ["acp.turn.ack", undefined],
    ["acp.update", 1],
    ["acp.turn.end", undefined],
  ]);
  // Replayed again, still without the late updates, until a beat's ack lets the turn go.
  t.host.detach();
  mark = t.frames.length;
  t.host.attach(t.send);
  expect(ofType(ofTurn(t.frames.slice(mark), "turn_1"), "acp.update")).toEqual([
    expect.objectContaining({ seq: 1 }),
  ]);
  t.host.heartbeatSent();
  t.host.acked();
  t.host.detach();
  mark = t.frames.length;
  t.host.attach(t.send);
  expect(
    t.frames.slice(mark).filter((f) => f.type !== "acp.inventory"),
  ).toEqual([]);
});

test("past the limit, text updates are dropped without compacting again", async () => {
  let compactions = 0;
  const frames: Frame[] = [];
  const host = createAcpHost({
    roots: (ref) => (ref === ROOT ? work : null),
    apps: (ref) => (ref === APP ? FAKE_APP : null),
    adapterDir: ADAPTERS,
    spawn: (spec, handlers, opts) =>
      createAcpClient(
        {
          ...spec,
          env: {
            FAKE_ACP_SCRIPT: JSON.stringify({
              turns: [
                {
                  steps: [
                    {
                      update: {
                        sessionUpdate: "tool_call",
                        toolCallId: "call_1",
                        title: "Edit a",
                        kind: "edit",
                        status: "pending",
                      },
                    },
                    { burst: { update: chunk("x"), times: 2000 } },
                    {
                      update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "call_1",
                        status: "completed",
                      },
                    },
                  ],
                },
              ],
            }),
          },
        },
        handlers,
        opts,
      ),
    bufferLimit: { count: 3, bytes: 5_000_000 },
    onCompact: () => {
      compactions += 1;
    },
  });
  hosts.push(host);
  await host.handle(open("th_1"));
  await host.handle(prompt("th_1", "turn_1"));
  // Detached throughout; the end is kept, so attaching shows when the turn is over.
  await waitFor(() => {
    host.attach((frame) => frames.push(frame));
    host.detach();
    return ended(frames, "turn_1");
  });
  // Once, when the fourth update arrived; the other 1997 chunks were simply not kept.
  expect(compactions).toBe(1);
  const last = frames.slice(
    frames.findLastIndex((frame) => frame.type === "acp.turn.ack"),
  );
  expect(ofType(last, "acp.update").map((frame) => frame.update)).toEqual([
    {
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Edit a",
      kind: "edit",
      status: "pending",
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
    },
  ]);
});

test("an answer naming an option not offered is answered cancelled and reported", async () => {
  const t = setup({
    turns: [
      {
        steps: [
          {
            permission: {
              toolCall: { toolCallId: "call_1", kind: "edit", title: "Edit" },
              options: [
                { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
              ],
            },
          },
        ],
      },
    ],
  });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ofType(t.frames, "acp.permission.request").length === 1);
  const asked = ofType(t.frames, "acp.permission.request")[0] as Frame;
  await t.host.handle({
    type: "acp.permission.answer",
    agentId: "agent_1",
    requestId: asked.requestId,
    optionId: "opt-always",
  });
  await waitFor(() => ended(t.frames, "turn_1"));
  expect(ofType(t.frames, "acp.error")).toMatchObject([
    { threadId: "th_1", turnId: "turn_1", code: "bad_option" },
  ]);
  const outcome = ofType(t.frames, "acp.update").find(
    (frame) =>
      (frame.update as Frame).sessionUpdate === "fake_permission_outcome",
  );
  expect((outcome?.update as Frame | undefined)?.outcome).toEqual({
    outcome: "cancelled",
  });
  // Settled: not asked again on the next connection.
  t.host.detach();
  t.host.attach(t.send);
  expect(ofType(t.frames, "acp.permission.request")).toHaveLength(1);
});

test("a repeated prompt for a turn whose end is still kept adds no second end", async () => {
  const t = setup({ turns: [{ steps: [{ update: chunk("x") }] }] });
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => t.settled() === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (let i = 0; i < 5; i++) await t.host.handle(prompt("th_1", "turn_1"));
  t.host.attach(t.send);
  expect(ofType(ofTurn(t.frames, "turn_1"), "acp.turn.end")).toHaveLength(1);

  // Once the kept end is gone (a beat's ack), a repeat keeps one new end, not one per repeat.
  t.host.heartbeatSent();
  t.host.acked();
  for (let i = 0; i < 5; i++) await t.host.handle(prompt("th_1", "turn_1"));
  const mark = t.frames.length;
  t.host.detach();
  t.host.attach(t.send);
  expect(
    ofType(ofTurn(t.frames.slice(mark), "turn_1"), "acp.turn.end"),
  ).toHaveLength(1);
});

test("a turn cancelled while its session is being made ends cancelled", async () => {
  const frames: Frame[] = [];
  const host = createAcpHost({
    roots: (ref) => (ref === ROOT ? work : null),
    apps: (ref) => (ref === APP ? FAKE_APP : null),
    adapterDir: ADAPTERS,
    // An agent that takes a while to fail to start.
    spawn: () => ({
      initialize: () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("no start")), 150),
        ),
      newSession: async () => "never",
      loadSession: async () => false,
      prompt: async () => ({ stopReason: "end_turn" }),
      cancel: () => {},
      close: async () => {},
      alive: true,
    }),
  });
  hosts.push(host);
  host.attach((frame) => frames.push(frame));
  await host.handle(open("th_1"));
  await host.handle(prompt("th_1", "turn_1"));
  // The open's own start failed; the turn is now starting the agent again.
  await waitFor(() => ofType(frames, "acp.error").length === 1);
  await host.handle({
    type: "acp.cancel",
    agentId: "agent_1",
    threadId: "th_1",
    turnId: "turn_1",
  });
  await waitFor(() => ended(frames, "turn_1"));
  expect(ofType(ofTurn(frames, "turn_1"), "acp.turn.end")[0]).toMatchObject({
    stopReason: "cancelled",
    interrupted: false,
  });
  expect(ofType(ofTurn(frames, "turn_1"), "acp.error")).toHaveLength(0);
});

test("an open with an unknown workdirRef leaves the thread's session in place", async () => {
  const t = setup({ turns: [{ steps: [{ update: chunk("x") }] }] });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await waitFor(() => ofType(t.frames, "acp.session").length === 1);
  await t.host.handle(open("th_1", { workdirRef: `fld_${"z".repeat(22)}` }));
  expect(ofType(t.frames, "acp.error")).toMatchObject([
    { threadId: "th_1", code: "unknown_workdir" },
  ]);
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"));
  expect(ofType(ofTurn(t.frames, "turn_1"), "acp.turn.end")[0]).toMatchObject({
    stopReason: "end_turn",
  });
  expect(t.spawns).toHaveLength(1);
  expect(ofType(t.frames, "acp.session")).toHaveLength(1);
});

test("an ack for a heartbeat sent after a turn's end releases the turn", async () => {
  const t = setup({ turns: [{ steps: [{ update: chunk("x") }] }] });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"));
  t.host.heartbeatSent();
  t.host.acked();
  t.host.detach();
  const mark = t.frames.length;
  t.host.attach(t.send);
  // The turn and the session frame were both sent before the beat: nothing to replay.
  expect(
    t.frames.slice(mark).filter((f) => f.type !== "acp.inventory"),
  ).toEqual([]);
});

test("an ack for a heartbeat sent before a turn's end keeps the turn", async () => {
  const t = setup({ turns: [{ steps: [{ update: chunk("x") }] }] });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await waitFor(() => ofType(t.frames, "acp.session").length === 1);
  t.host.heartbeatSent();
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"));
  t.host.acked();
  // An ack with no beat waiting proves nothing either.
  t.host.acked();
  t.host.detach();
  const mark = t.frames.length;
  t.host.attach(t.send);
  const replayed = t.frames.slice(mark);
  expect(ofType(replayed, "acp.session")).toHaveLength(0);
  expect(ofTurn(replayed, "turn_1").map((f) => [f.type, f.seq])).toEqual([
    ["acp.turn.ack", undefined],
    ["acp.update", 1],
    ["acp.turn.end", undefined],
  ]);
});

test("an ack releases only frames sent before its own beat on this connection", async () => {
  const t = setup({ turns: [{ steps: [{ update: chunk("x") }] }] });
  t.host.attach((frame) => frame);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => t.settled() === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  t.host.heartbeatSent();
  t.host.detach();
  // The new connection beats first, then attaches; its first ack is for that beat.
  t.host.heartbeatSent();
  t.host.attach((frame) => frame);
  // A frame of no turn sent live on the new connection, after its first beat.
  await t.host.handle(open("th_1"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  t.host.acked();
  t.host.detach();
  t.host.attach(t.send);
  // Everything went up after that beat (the replay and the live frame): nothing was let go.
  expect(ofType(t.frames, "acp.session")).toEqual([
    {
      type: "acp.session",
      agentId: "agent_1",
      threadId: "th_1",
      sessionId: "sess_1",
      loaded: false,
    },
    {
      type: "acp.session",
      agentId: "agent_1",
      threadId: "th_1",
      sessionId: "sess_1",
      loaded: true,
    },
  ]);
  expect(ended(t.frames, "turn_1")).toBe(true);
});

test("past the cap on ended turns the oldest are dropped first", async () => {
  const t = setup(
    { turns: [{ steps: [{ update: chunk("x") }] }] },
    { endedLimit: { turns: 2, bytes: 50_000_000 } },
  );
  await t.host.handle(open("th_1"));
  for (const turnId of ["turn_1", "turn_2", "turn_3"])
    await t.host.handle(prompt("th_1", turnId));
  await waitFor(() => t.settled() === 3);
  await new Promise((resolve) => setTimeout(resolve, 30));
  t.host.attach(t.send);
  const ends = ofType(t.frames, "acp.turn.end").map((frame) => frame.turnId);
  expect(ends).toEqual(["turn_2", "turn_3"]);
  expect(ofTurn(t.frames, "turn_1")).toEqual([]);
});

test("past the byte cap on ended turns the oldest are dropped first", async () => {
  const big = "y".repeat(4000);
  const t = setup(
    { turns: [{ steps: [{ update: chunk(big) }] }] },
    { endedLimit: { turns: 100, bytes: 9000 } },
  );
  await t.host.handle(open("th_1"));
  for (const turnId of ["turn_1", "turn_2", "turn_3"])
    await t.host.handle(prompt("th_1", turnId));
  await waitFor(() => t.settled() === 3);
  await new Promise((resolve) => setTimeout(resolve, 30));
  t.host.attach(t.send);
  const ends = ofType(t.frames, "acp.turn.end").map((frame) => frame.turnId);
  expect(ends).toEqual(["turn_2", "turn_3"]);
});

test("two employees in one thread get their own sessions, and every frame names its employee", async () => {
  // Each spawn is one employee's process: its session ids and its text say which one it is.
  const t = setup((spawn) => ({
    loadSession: true,
    sessionId: `sess_p${spawn}`,
    turns: [
      {
        steps: [
          { update: chunk(`from p${spawn}`) },
          { sleepMs: 100 },
          { update: chunk(`again p${spawn}`) },
        ],
      },
    ],
  }));
  t.host.attach(t.send);
  await t.host.handle(open("th_1", { agentId: "agent_a" }));
  await waitFor(() => ofType(t.frames, "acp.session").length === 1);
  await t.host.handle(open("th_1", { agentId: "agent_b" }));
  await waitFor(() => ofType(t.frames, "acp.session").length === 2);
  await t.host.handle(prompt("th_1", "a1", "agent_a"));
  await t.host.handle(prompt("th_1", "b1", "agent_b"));
  await t.host.handle(prompt("th_1", "a2", "agent_a"));
  await t.host.handle(prompt("th_1", "b2", "agent_b"));
  await waitFor(() =>
    ["a1", "a2", "b1", "b2"].every((turnId) => ended(t.frames, turnId)),
  );
  expect(t.spawns).toHaveLength(2);
  const sessions = ofType(t.frames, "acp.session");
  expect(sessions).toEqual([
    {
      type: "acp.session",
      agentId: "agent_a",
      threadId: "th_1",
      sessionId: "sess_p1",
      loaded: false,
    },
    {
      type: "acp.session",
      agentId: "agent_b",
      threadId: "th_1",
      sessionId: "sess_p2",
      loaded: false,
    },
  ]);
  // agent_b's process never heard of agent_a's session.
  expect(
    received(t.logs[1] ?? "").filter((m) => m.method === "session/load"),
  ).toHaveLength(0);
  const process = { agent_a: "p1", agent_b: "p2" } as const;
  for (const frame of t.frames) {
    if (frame.type === "acp.inventory") continue;
    expect(frame.agentId === "agent_a" || frame.agentId === "agent_b").toBe(
      true,
    );
    const turnId = frame.turnId as string | undefined;
    if (turnId) expect(frame.agentId).toBe(`agent_${turnId[0]}`);
    if (frame.type === "acp.update") {
      const text = ((frame.update as Frame).content as Frame).text as string;
      expect(text.endsWith(process[frame.agentId as "agent_a"])).toBe(true);
    }
  }
  for (const turnId of ["a1", "a2", "b1", "b2"]) {
    expect(ofType(ofTurn(t.frames, turnId), "acp.turn.end")[0]).toMatchObject({
      stopReason: "end_turn",
      interrupted: false,
    });
  }
  // Each process got its own two prompts, in its own session.
  for (const [index, sessionId] of ["sess_p1", "sess_p2"].entries()) {
    const prompts = received(t.logs[index] ?? "").filter(
      (m) => m.method === "session/prompt",
    );
    expect(prompts.map((m) => (m.params as Frame).sessionId)).toEqual([
      sessionId,
      sessionId,
    ]);
  }
});

test("a down frame without an agentId is dropped", async () => {
  const t = setup({});
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await waitFor(() => ofType(t.frames, "acp.session").length === 1);
  const before = t.frames.length;
  expect(
    await t.host.handle({ ...prompt("th_1", "turn_x"), agentId: undefined }),
  ).toBe(true);
  expect(await t.host.handle({ ...open("th_2"), agentId: 7 })).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(t.frames.slice(before)).toEqual([]);
  expect(t.spawns).toHaveLength(1);
});

test("an ended turn replayed on a socket that silently dies is replayed again, until a beat's ack", async () => {
  const t = setup({ turns: [{ steps: [{ update: chunk("x") }] }] });
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => t.settled() === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  // Reconnected, the whole ended turn is replayed into a socket that is already gone.
  const lost: Frame[] = [];
  t.host.attach((frame) => lost.push(frame));
  expect(ended(lost, "turn_1")).toBe(true);
  t.host.detach();
  // The next connection gets it again: nothing proved the first replay arrived.
  let mark = t.frames.length;
  t.host.attach(t.send);
  const again = t.frames.slice(mark);
  expect(ofTurn(again, "turn_1").map((f) => [f.type, f.seq])).toEqual([
    ["acp.turn.ack", undefined],
    ["acp.update", 1],
    ["acp.turn.end", undefined],
  ]);
  expect(ofType(again, "acp.session")).toHaveLength(1);
  // A beat after the replay, acked: now it has arrived and is let go.
  t.host.heartbeatSent();
  t.host.acked();
  t.host.detach();
  mark = t.frames.length;
  t.host.attach(t.send);
  expect(
    t.frames.slice(mark).filter((f) => f.type !== "acp.inventory"),
  ).toEqual([]);
});

test("every attach sends the inventory first: this process, its turns and waiting requests", async () => {
  // agent_1's process ends one turn, then asks; agent_2's runs until cancelled.
  const t = setup((spawn) =>
    spawn === 1
      ? {
          turns: [
            { steps: [{ update: chunk("done") }] },
            {
              steps: [
                {
                  permission: {
                    toolCall: {
                      toolCallId: "call_1",
                      kind: "edit",
                      title: "Edit",
                    },
                    options: [
                      {
                        optionId: "opt-allow",
                        name: "Allow",
                        kind: "allow_once",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }
      : { turns: [{ steps: [{ waitForCancel: true }] }] },
  );
  t.host.attach(t.send);
  expect(t.frames[0]).toEqual({
    type: "acp.inventory",
    instanceId: expect.any(String),
    turns: [],
    requestIds: [],
  });
  const instanceId = t.frames[0]?.instanceId;
  await t.host.handle(open("th_1"));
  await t.host.handle(open("th_2", { agentId: "agent_2" }));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"));
  await t.host.handle(prompt("th_1", "turn_2"));
  await waitFor(() => ofType(t.frames, "acp.permission.request").length === 1);
  await t.host.handle(prompt("th_2", "turn_3", "agent_2"));
  await waitFor(() => ofType(t.frames, "acp.session").length === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const requestId = ofType(t.frames, "acp.permission.request")[0]?.requestId;

  t.host.detach();
  const mark = t.frames.length;
  t.host.attach(t.send);
  const after = t.frames.slice(mark);
  expect(after[0]).toEqual({
    type: "acp.inventory",
    instanceId,
    turns: [
      {
        agentId: "agent_1",
        threadId: "th_1",
        turnId: "turn_1",
        state: "ended",
      },
      {
        agentId: "agent_1",
        threadId: "th_1",
        turnId: "turn_2",
        state: "awaiting",
      },
      {
        agentId: "agent_2",
        threadId: "th_2",
        turnId: "turn_3",
        state: "running",
      },
    ],
    requestIds: [requestId],
  });
  expect(ofType(after, "acp.inventory")).toHaveLength(1);
  // A new runner process is a new instance.
  const other = setup({});
  other.host.attach(other.send);
  expect(other.frames[0]?.instanceId).not.toBe(instanceId);
});

const MB = 1024 * 1024;
const bytesOf = (frame: Frame) => Buffer.byteLength(JSON.stringify(frame));

test("an update over 1 MB has its long strings cut and says truncated", async () => {
  const t = setup({
    turns: [
      {
        steps: [
          {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call_big",
              title: "Edit big.txt",
              kind: "edit",
              status: "pending",
              content: [
                {
                  type: "diff",
                  path: "big.txt",
                  oldText: "o".repeat(MB),
                  newText: "n".repeat(2 * MB),
                },
                {
                  type: "content",
                  content: { type: "text", text: "t".repeat(MB) },
                },
              ],
              rawInput: { file: "big.txt", text: "r".repeat(MB) },
            },
          },
          { update: chunk("small") },
        ],
      },
    ],
  });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"), 15_000);
  const [big, small] = ofType(t.frames, "acp.update");
  expect(bytesOf(big as Frame)).toBeLessThanOrEqual(MB);
  expect(big).toMatchObject({
    agentId: "agent_1",
    threadId: "th_1",
    turnId: "turn_1",
    seq: 1,
    truncated: true,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call_big",
      title: "Edit big.txt",
      kind: "edit",
      content: [{ type: "diff", path: "big.txt" }, { type: "content" }],
      rawInput: { file: "big.txt" },
    },
  });
  const diff = (
    ((big as Frame).update as Frame).content as Frame[]
  )[0] as Frame;
  expect((diff.newText as string).startsWith("nnnn")).toBe(true);
  expect((diff.newText as string).length).toBeLessThan(MB);
  // A frame under the limit is untouched.
  expect(small).toEqual({
    type: "acp.update",
    agentId: "agent_1",
    threadId: "th_1",
    turnId: "turn_1",
    seq: 2,
    update: chunk("small"),
  });
  // What is kept for replay is the cut frame.
  t.host.detach();
  const mark = t.frames.length;
  t.host.attach(t.send);
  for (const frame of t.frames.slice(mark))
    expect(bytesOf(frame)).toBeLessThanOrEqual(MB);
}, 20_000);

test("an update still over 1 MB once cut becomes a stub that keeps its ids and seq", async () => {
  const t = setup({
    turns: [
      {
        steps: [
          {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "call_many",
              content: Array.from({ length: 20_000 }, () => ({
                type: "content",
                content: { type: "text", text: "z".repeat(100) },
              })),
            },
          },
        ],
      },
    ],
  });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"), 15_000);
  expect(ofType(t.frames, "acp.update")).toEqual([
    {
      type: "acp.update",
      agentId: "agent_1",
      threadId: "th_1",
      turnId: "turn_1",
      seq: 1,
      truncated: true,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_many",
        truncated: true,
      },
    },
  ]);
}, 20_000);

test("a permission request over 1 MB is cut, keeps its options and can still be answered", async () => {
  const t = setup({
    turns: [
      {
        steps: [
          {
            permission: {
              toolCall: {
                toolCallId: "call_big",
                kind: "edit",
                title: "Edit",
                rawInput: { text: "p".repeat(3 * MB) },
              },
              options: [
                { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
              ],
            },
          },
        ],
      },
    ],
  });
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(
    () => ofType(t.frames, "acp.permission.request").length === 1,
    15_000,
  );
  const asked = ofType(t.frames, "acp.permission.request")[0] as Frame;
  expect(bytesOf(asked)).toBeLessThanOrEqual(MB);
  expect(asked).toMatchObject({
    agentId: "agent_1",
    turnId: "turn_1",
    truncated: true,
    toolCall: { toolCallId: "call_big", kind: "edit" },
    options: [{ optionId: "opt-allow" }],
  });
  // Re-sent on attach as cut as it went the first time.
  t.host.detach();
  t.host.attach(t.send);
  expect(ofType(t.frames, "acp.permission.request")[1]).toEqual(asked);
  await t.host.handle({
    type: "acp.permission.answer",
    agentId: "agent_1",
    requestId: asked.requestId,
    optionId: "opt-allow",
  });
  await waitFor(() => ended(t.frames, "turn_1"));
}, 20_000);

test("an owner's own agent gets the login shell's PATH too", async () => {
  const loginPath = `/opt/login/bin:${process.env.PATH ?? ""}`;
  const t = setup(
    {},
    { processEnv: async () => ({ ...process.env, PATH: loginPath }) },
  );
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await waitFor(() => ofType(t.frames, "acp.session").length === 1);
  expect(t.spawns[0]?.env.PATH).toBe(loginPath);
  // A PATH the owner set on the app is the owner's choice.
  const own = setup(
    {},
    {
      processEnv: async () => ({ ...process.env, PATH: loginPath }),
      apps: (ref) =>
        ref === APP ? { ...FAKE_APP, env: { PATH: "/owner/bin" } } : null,
    },
  );
  own.host.attach(own.send);
  await own.host.handle(open("th_1"));
  await waitFor(() => ofType(own.frames, "acp.session").length === 1);
  expect(own.spawns[0]?.env.PATH).toBe("/owner/bin");
});

test("a session that leaves the ask mode for good ends its turn with ask_mode_lost; the next turn gets a new session", async () => {
  const t = setup({
    modes: {
      currentModeId: "agent",
      availableModes: [
        { id: "read-only", name: "Read only" },
        { id: "agent", name: "Agent" },
      ],
    },
    // Set at creation; refused after the agent left it; set again for the new session.
    setModeFailOn: [2],
    turns: [
      {
        steps: [
          {
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: "agent",
            },
          },
          { waitForCancel: true },
        ],
      },
      { steps: [{ update: chunk("asking again") }] },
    ],
  });
  t.host.attach(t.send);
  await t.host.handle(open("th_1", { harness: "codex", appRef: undefined }));
  await waitFor(() => ofType(t.frames, "acp.session").length === 1, 15_000);
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"));
  expect(ofTurn(t.frames, "turn_1").slice(-2)).toEqual([
    {
      type: "acp.error",
      agentId: "agent_1",
      threadId: "th_1",
      turnId: "turn_1",
      code: "ask_mode_lost",
      message: expect.any(String),
    },
    {
      type: "acp.turn.end",
      agentId: "agent_1",
      threadId: "th_1",
      turnId: "turn_1",
      stopReason: "error",
      interrupted: false,
    },
  ]);
  await t.host.handle(prompt("th_1", "turn_2"));
  await waitFor(() => ended(t.frames, "turn_2"));
  expect(ofType(ofTurn(t.frames, "turn_2"), "acp.turn.end")[0]).toMatchObject({
    stopReason: "end_turn",
  });
  expect(ofType(t.frames, "acp.session").map((f) => f.sessionId)).toEqual([
    "sess_1",
    "sess_1-2",
  ]);
  expect(t.spawns).toHaveLength(1);
}, 20_000);

test("an agent that ignores session/cancel is stopped after the grace and the turn ends interrupted", async () => {
  const t = setup(
    {
      ignoreCancel: true,
      turns: [{ steps: [{ update: chunk("busy") }, { waitForCancel: true }] }],
    },
    { cancelGraceMs: 200 },
  );
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ofType(t.frames, "acp.update").length === 1);
  const cancelledAt = Date.now();
  await t.host.handle({
    type: "acp.cancel",
    agentId: "agent_1",
    threadId: "th_1",
    turnId: "turn_1",
  });
  await waitFor(() => ended(t.frames, "turn_1"));
  expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(180);
  expect(ofType(ofTurn(t.frames, "turn_1"), "acp.turn.end")).toEqual([
    {
      type: "acp.turn.end",
      agentId: "agent_1",
      threadId: "th_1",
      turnId: "turn_1",
      stopReason: "interrupted",
      interrupted: true,
    },
  ]);
  expect(t.clients[0]?.alive).toBe(false);
  expect(
    received(t.logs[0] ?? "").some((m) => m.method === "session/cancel"),
  ).toBe(true);
});

test("an agent that honours session/cancel in time is left running", async () => {
  const t = setup(
    { turns: [{ steps: [{ waitForCancel: true }] }] },
    { cancelGraceMs: 200 },
  );
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => t.clients.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await t.host.handle({
    type: "acp.cancel",
    agentId: "agent_1",
    threadId: "th_1",
    turnId: "turn_1",
  });
  await waitFor(() => ended(t.frames, "turn_1"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(ofType(ofTurn(t.frames, "turn_1"), "acp.turn.end")[0]).toMatchObject({
    stopReason: "cancelled",
    interrupted: false,
  });
  expect(t.clients[0]?.alive).toBe(true);
});

test("an owner's own agent without a folder of its own starts in the adapters' folder, never the working folder", async () => {
  const t = setup({});
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  await waitFor(() => ofType(t.frames, "acp.session").length === 1);
  expect(t.spawns[0]?.cwd).toBe(ADAPTERS);
  // The working folder reaches it only through session/new.
  const created = received(t.logs[0] ?? "").filter(
    (message) => message.method === "session/new",
  );
  expect((created[0]?.params as Frame | undefined)?.cwd).toBe(work);
  // A folder the owner set on the app is the owner's choice.
  const own = setup(
    {},
    { apps: (ref) => (ref === APP ? { ...FAKE_APP, cwd: scratch } : null) },
  );
  own.host.attach(own.send);
  await own.host.handle(open("th_1"));
  await waitFor(() => ofType(own.frames, "acp.session").length === 1);
  expect(own.spawns[0]?.cwd).toBe(scratch);
});

test("a cut never splits a surrogate pair", () => {
  // The first cut keeps 65 536 code units; the emoji's high surrogate is unit 65 536.
  const text = `${"a".repeat(65_535)}${"\u{1F600}".repeat(40_000)}`;
  const cut = capFrame(
    {
      type: "acp.update",
      agentId: "agent_1",
      threadId: "th_1",
      turnId: "turn_1",
      seq: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
    200_000,
  );
  expect(cut.truncated).toBe(true);
  const kept = ((cut.update as Frame).content as Frame).text as string;
  expect(kept.length).toBeLessThan(text.length);
  expect(kept.isWellFormed()).toBeTrue();
  expect(kept.endsWith("a…")).toBeTrue();
});

test("an inventory over the frame limit drops ended turns first and says truncated", async () => {
  const limit = 400;
  const t = setup(
    (spawn) =>
      spawn === 1
        ? { turns: [{ steps: [{ update: chunk("x") }] }] }
        : { turns: [{ steps: [{ waitForCancel: true }] }] },
    { frameLimit: limit },
  );
  t.host.attach(t.send);
  await t.host.handle(open("th_1"));
  for (const turnId of ["turn_1", "turn_2", "turn_3", "turn_4", "turn_5"]) {
    await t.host.handle(prompt("th_1", turnId));
    await waitFor(() => ended(t.frames, turnId));
  }
  await t.host.handle(open("th_2", { agentId: "agent_2" }));
  await t.host.handle(prompt("th_2", "turn_live", "agent_2"));
  await waitFor(() => t.clients.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));

  t.host.detach();
  const mark = t.frames.length;
  t.host.attach(t.send);
  const inventory = t.frames[mark] as Frame;
  expect(inventory.type).toBe("acp.inventory");
  expect(inventory.truncated).toBe(true);
  expect(bytesOf(inventory)).toBeLessThanOrEqual(limit);
  const turns = inventory.turns as Frame[];
  expect(turns.length).toBeGreaterThan(0);
  expect(turns.length).toBeLessThan(6);
  expect(turns.find((turn) => turn.turnId === "turn_live")).toMatchObject({
    state: "running",
  });
  // The oldest ended turns went first: what is kept of them is the newest.
  const endedKept = turns
    .filter((turn) => turn.state === "ended")
    .map((turn) => String(turn.turnId));
  expect(
    ["turn_1", "turn_2", "turn_3", "turn_4", "turn_5"].slice(
      5 - endedKept.length,
    ),
  ).toEqual(endedKept);
});

test("a session forgotten for leaving the ask mode is never loaded again, not even from the open's sessionHint", async () => {
  const t = setup({
    loadSession: true,
    modes: {
      currentModeId: "agent",
      availableModes: [
        { id: "read-only", name: "Read only" },
        { id: "agent", name: "Agent" },
      ],
    },
    setModeFailOn: [2],
    turns: [
      {
        steps: [
          {
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: "agent",
            },
          },
          { waitForCancel: true },
        ],
      },
      { steps: [{ update: chunk("asking again") }] },
    ],
  });
  t.host.attach(t.send);
  await t.host.handle(
    open("th_1", {
      harness: "codex",
      appRef: undefined,
      sessionHint: "sess_old",
    }),
  );
  await waitFor(() => ofType(t.frames, "acp.session").length === 1, 15_000);
  await t.host.handle(prompt("th_1", "turn_1"));
  await waitFor(() => ended(t.frames, "turn_1"));
  await t.host.handle(prompt("th_1", "turn_2"));
  await waitFor(() => ended(t.frames, "turn_2"));
  expect(
    ofType(t.frames, "acp.session").map((f) => [f.sessionId, f.loaded]),
  ).toEqual([
    ["sess_old", true],
    ["sess_1", false],
  ]);
  const loads = received(t.logs[0] ?? "").filter(
    (message) => message.method === "session/load",
  );
  expect(loads).toHaveLength(1);
}, 20_000);
