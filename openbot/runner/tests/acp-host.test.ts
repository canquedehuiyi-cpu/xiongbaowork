import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AcpClient,
  type AcpSpawnSpec,
  createAcpClient,
} from "../src/acp/client";
import { type AcpHost, createAcpHost } from "../src/acp/host";
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
    apps?: (ref: string) => AppEntry | null;
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
    spawn: (spec, handlers, clientOpts) => {
      spawns.push(spec);
      const log = join(scratch, `log-${++logs}.jsonl`);
      logFiles.push(log);
      const base =
        typeof script === "function" ? script(spawns.length) : script;
      const client = createAcpClient(
        {
          ...spec,
          command: process.execPath,
          args: [fixture],
          env: { FAKE_ACP_SCRIPT: JSON.stringify({ ...base, log }) },
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
const prompt = (threadId: string, turnId: string): Frame => ({
  type: "acp.prompt",
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
      threadId: "th_1",
      turnId: "turn_1",
      seq: 1,
      update: chunk("a"),
    },
    {
      type: "acp.update",
      threadId: "th_1",
      turnId: "turn_1",
      seq: 2,
      update: chunk("b"),
    },
    {
      type: "acp.update",
      threadId: "th_1",
      turnId: "turn_1",
      seq: 3,
      update: chunk("c"),
    },
  ]);
  expect(turn[4]).toEqual({
    type: "acp.turn.end",
    threadId: "th_1",
    turnId: "turn_1",
    stopReason: "end_turn",
    interrupted: false,
  });
  expect(ofType(t.frames, "acp.session")).toEqual([
    {
      type: "acp.session",
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
  const replayed = t.frames.slice(before);
  expect(replayed.map((frame) => [frame.type, frame.seq])).toEqual([
    ["acp.update", 2],
    ["acp.update", 3],
    ["acp.turn.end", undefined],
  ]);
  const seqs = ofType(t.frames, "acp.update").map((frame) => frame.seq);
  expect(seqs).toEqual([1, 2, 3]);
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
    requestId: "perm_unknown",
    optionId: "opt-allow",
  });
  expect(
    await t.host.handle({
      type: "acp.permission.answer",
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
    args: ["-y", "@agentclientprotocol/codex-acp@2"],
    cwd: work,
    sessionMode: "read-only",
  });
  expect(t.spawns[0]?.env.INITIAL_AGENT_MODE).toBe("read-only");
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
