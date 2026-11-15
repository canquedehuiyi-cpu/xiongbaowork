import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AcpClient,
  type AcpHandlers,
  createAcpClient,
} from "../src/acp/client";
import type { FakeAcpScript } from "./fixtures/fake-acp-agent";

/*
 * The runner's ACP client against the scriptable fake agent: JSON-RPC 2.0 over a child's pipes.
 * Every test closes what it opened so no child process outlives the run.
 */

const fixture = join(import.meta.dir, "fixtures", "fake-acp-agent.ts");
const scratch = mkdtempSync(join(tmpdir(), "openbot-runner-acp-"));
const open: AcpClient[] = [];
let logs = 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
});

const ALLOW_ONCE = { optionId: "opt-allow", name: "Allow", kind: "allow_once" };
const ALLOW_ALWAYS = {
  optionId: "opt-always",
  name: "Always allow",
  kind: "allow_always",
};
const REJECT_ONCE = {
  optionId: "opt-reject",
  name: "Reject",
  kind: "reject_once",
};
const EDIT_CALL = {
  toolCallId: "call_1",
  title: "Edit notes.md",
  kind: "edit",
  status: "pending",
};

type Seen = { updates: Array<{ sessionId: string; update: unknown }> };

function start(
  script: FakeAcpScript,
  handlers: Partial<AcpHandlers> = {},
  extra: { sessionMode?: string } = {},
): { client: AcpClient; seen: Seen; log: string } {
  const log = join(scratch, `log-${++logs}.jsonl`);
  const seen: Seen = { updates: [] };
  const client = createAcpClient(
    {
      command: process.execPath,
      args: [fixture],
      env: { FAKE_ACP_SCRIPT: JSON.stringify({ ...script, log }) },
      cwd: scratch,
      ...extra,
    },
    {
      onUpdate: (sessionId, update) => seen.updates.push({ sessionId, update }),
      onPermission: async () => ({ outcome: "cancelled" }),
      ...handlers,
    },
  );
  open.push(client);
  return { client, seen, log };
}

function received(log: string): Array<Record<string, unknown>> {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const chunk = (text: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

test("initialize → newSession → prompt streams updates then resolves stopReason", async () => {
  const { client, seen, log } = start({
    turns: [
      {
        steps: [
          { update: chunk("one") },
          { update: { sessionUpdate: "plan", entries: [] } },
          { update: chunk("three") },
        ],
      },
    ],
  });
  expect(await client.initialize()).toEqual({ loadSession: false });
  const sessionId = await client.newSession(scratch);
  expect(sessionId).toBe("sess_1");
  const result = await client.prompt(sessionId, [{ type: "text", text: "hi" }]);
  expect(result).toEqual({ stopReason: "end_turn" });
  expect(seen.updates).toEqual([
    { sessionId, update: chunk("one") },
    { sessionId, update: { sessionUpdate: "plan", entries: [] } },
    { sessionId, update: chunk("three") },
  ]);
  const messages = received(log);
  const prompt = messages.find((m) => m.method === "session/prompt");
  expect(prompt?.params).toEqual({
    sessionId,
    prompt: [{ type: "text", text: "hi" }],
  });
  const created = messages.find((m) => m.method === "session/new");
  expect(created?.params).toEqual({ cwd: scratch, mcpServers: [] });
  expect(client.alive).toBe(true);
});

test("the client declares no fs or terminal capability and refuses those requests", async () => {
  const { client, seen, log } = start({
    turns: [
      {
        steps: [
          {
            request: {
              method: "fs/read_text_file",
              params: { sessionId: "sess_1", path: "/etc/hosts" },
            },
          },
          {
            request: {
              method: "terminal/create",
              params: { sessionId: "sess_1", command: "ls" },
            },
          },
        ],
      },
    ],
  });
  await client.initialize();
  const init = received(log).find((m) => m.method === "initialize");
  const params = init?.params as {
    protocolVersion: number;
    clientCapabilities: {
      fs?: { readTextFile?: boolean; writeTextFile?: boolean };
      terminal?: boolean;
    };
  };
  expect(params.protocolVersion).toBe(1);
  expect(params.clientCapabilities.fs?.readTextFile ?? false).toBe(false);
  expect(params.clientCapabilities.fs?.writeTextFile ?? false).toBe(false);
  expect(params.clientCapabilities.terminal ?? false).toBe(false);
  const sessionId = await client.newSession(scratch);
  await client.prompt(sessionId, [{ type: "text", text: "read" }]);
  const answers = seen.updates.map(
    (u) => (u.update as { response: { error?: { code: number } } }).response,
  );
  expect(answers.map((a) => a.error?.code)).toEqual([-32601, -32601]);
});

test("permission request is answered with the option the handler picks", async () => {
  const asked: Array<{ sessionId: string; request: unknown }> = [];
  const { client, seen } = start(
    {
      turns: [
        {
          steps: [
            {
              permission: {
                toolCall: EDIT_CALL,
                options: [ALLOW_ONCE, ALLOW_ALWAYS, REJECT_ONCE],
              },
            },
          ],
        },
      ],
    },
    {
      onPermission: async (sessionId, request) => {
        asked.push({ sessionId, request });
        const pick = request.options.find((o) => o.kind === "allow_once");
        return { outcome: "selected", optionId: pick?.optionId ?? "" };
      },
    },
  );
  await client.initialize();
  const sessionId = await client.newSession(scratch);
  expect(await client.prompt(sessionId, [])).toEqual({
    stopReason: "end_turn",
  });
  expect(asked).toEqual([
    {
      sessionId,
      request: {
        toolCall: EDIT_CALL,
        options: [ALLOW_ONCE, ALLOW_ALWAYS, REJECT_ONCE],
      },
    },
  ]);
  expect(seen.updates.map((u) => u.update)).toEqual([
    {
      sessionUpdate: "fake_permission_outcome",
      outcome: { outcome: "selected", optionId: "opt-allow" },
    },
  ]);
});

test("an option the agent did not offer is answered as cancelled", async () => {
  const { client, seen } = start(
    {
      turns: [
        {
          steps: [
            { permission: { toolCall: EDIT_CALL, options: [ALLOW_ONCE] } },
          ],
        },
      ],
    },
    {
      onPermission: async () => ({ outcome: "selected", optionId: "made-up" }),
    },
  );
  await client.initialize();
  const sessionId = await client.newSession(scratch);
  await client.prompt(sessionId, []);
  expect(seen.updates.map((u) => u.update)).toEqual([
    {
      sessionUpdate: "fake_permission_outcome",
      outcome: { outcome: "cancelled" },
    },
  ]);
});

test("cancel sends session/cancel and pending permission resolves cancelled", async () => {
  let asked: () => void = () => {};
  const permissionAsked = new Promise<void>((resolve) => {
    asked = resolve;
  });
  let answerLate: (value: { outcome: "selected"; optionId: string }) => void =
    () => {};
  const { client, seen, log } = start(
    {
      turns: [
        {
          steps: [
            {
              permission: {
                toolCall: EDIT_CALL,
                options: [ALLOW_ONCE, REJECT_ONCE],
              },
            },
          ],
        },
      ],
    },
    {
      // Nobody answers in time: the handler's promise is still open when the turn is cancelled.
      onPermission: () => {
        asked();
        return new Promise((resolve) => {
          answerLate = resolve;
        });
      },
    },
  );
  await client.initialize();
  const sessionId = await client.newSession(scratch);
  const turn = client.prompt(sessionId, []);
  await permissionAsked;
  client.cancel(sessionId);
  expect(await turn).toEqual({ stopReason: "cancelled" });
  // The person's answer arriving afterwards changes nothing and is not sent.
  answerLate({ outcome: "selected", optionId: "opt-allow" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(seen.updates.map((u) => u.update)).toEqual([
    {
      sessionUpdate: "fake_permission_outcome",
      outcome: { outcome: "cancelled" },
    },
    { sessionUpdate: "fake_cancel_seen" },
  ]);
  const messages = received(log);
  expect(
    messages.filter((m) => m.method === "session/cancel").map((m) => m.params),
  ).toEqual([{ sessionId }]);
  // Exactly one answer went back to the permission request.
  expect(messages.filter((m) => m.method === undefined)).toHaveLength(1);
});

test("child exit rejects in-flight calls and alive becomes false", async () => {
  const { client } = start({
    turns: [{ steps: [{ update: chunk("working") }, { exit: 3 }] }],
  });
  await client.initialize();
  const sessionId = await client.newSession(scratch);
  expect(client.alive).toBe(true);
  await expect(client.prompt(sessionId, [])).rejects.toThrow(/exited/);
  expect(client.alive).toBe(false);
  // A dead client refuses at once instead of waiting forever.
  await expect(client.newSession(scratch)).rejects.toThrow();
});

test("loadSession is false without the capability and true with it; the replay is not forwarded", async () => {
  const without = start({});
  expect(await without.client.initialize()).toEqual({ loadSession: false });
  expect(await without.client.loadSession("sess_old", scratch)).toBe(false);
  expect(received(without.log).some((m) => m.method === "session/load")).toBe(
    false,
  );

  const withLoad = start({
    loadSession: true,
    loadReplay: [chunk("old reply"), chunk("older reply")],
    turns: [{ steps: [{ update: chunk("new") }] }],
  });
  expect(await withLoad.client.initialize()).toEqual({ loadSession: true });
  expect(await withLoad.client.loadSession("sess_old", scratch)).toBe(true);
  // The history the agent replays is already on the server: only the new turn's updates come.
  expect(withLoad.seen.updates).toEqual([]);
  await withLoad.client.prompt("sess_old", []);
  expect(withLoad.seen.updates).toEqual([
    { sessionId: "sess_old", update: chunk("new") },
  ]);
  const load = received(withLoad.log).find((m) => m.method === "session/load");
  expect(load?.params).toEqual({
    sessionId: "sess_old",
    cwd: scratch,
    mcpServers: [],
  });

  const unknown = start({ loadSession: true, loadFails: true });
  await unknown.client.initialize();
  expect(await unknown.client.loadSession("sess_gone", scratch)).toBe(false);
  expect(unknown.client.alive).toBe(true);
});

test("a sessionMode is set on every new or loaded session, and a refusal fails it", async () => {
  const modes = {
    currentModeId: "auto",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "auto", name: "Auto" },
    ],
  };
  const ok = start(
    { modes, loadSession: true },
    {},
    { sessionMode: "default" },
  );
  await ok.client.initialize();
  const sessionId = await ok.client.newSession(scratch);
  expect(await ok.client.loadSession(sessionId, scratch)).toBe(true);
  expect(
    received(ok.log)
      .filter((m) => m.method === "session/set_mode")
      .map((m) => m.params),
  ).toEqual([
    { sessionId, modeId: "default" },
    { sessionId, modeId: "default" },
  ]);

  // An agent with config options instead of modes is switched through the "mode" option.
  const viaOption = start(
    { setConfigOption: "ok" },
    {},
    { sessionMode: "read-only" },
  );
  await viaOption.client.initialize();
  const optionSession = await viaOption.client.newSession(scratch);
  expect(
    received(viaOption.log)
      .filter((m) => m.method === "session/set_config_option")
      .map((m) => m.params),
  ).toEqual([
    { sessionId: optionSession, configId: "mode", value: "read-only" },
  ]);

  // Already in the mode: nothing to set.
  const already = start(
    { modes: { ...modes, currentModeId: "default" } },
    {},
    { sessionMode: "default" },
  );
  await already.client.initialize();
  await already.client.newSession(scratch);
  expect(
    received(already.log).some((m) => m.method === "session/set_mode"),
  ).toBe(false);

  // The agent will not ask before acting: the session must not be used.
  const refused = start(
    { modes, setMode: "error" },
    {},
    { sessionMode: "default" },
  );
  await refused.client.initialize();
  await expect(refused.client.newSession(scratch)).rejects.toThrow(/mode/);
});

test("close stops the child and alive becomes false", async () => {
  const { client } = start({});
  await client.initialize();
  await client.close();
  expect(client.alive).toBe(false);
  await expect(client.newSession(scratch)).rejects.toThrow();
});
