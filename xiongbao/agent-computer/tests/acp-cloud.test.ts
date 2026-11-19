import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AcpSpawnSpec,
  createAcpClient,
} from "../../runner/src/acp/client";
import { ACP_CLOUD_WORKDIR_REF } from "../../shared/acp";
import {
  ACP_FRAME_BODY_LIMIT,
  type CloudAcp,
  createCloudAcp,
  isAcpPath,
} from "../src/acp-cloud";

/*
 * The employee's cloud computer's ACP channel: the host the runner uses on an owner's machine, started
 * on this computer from the image's own adapters, driven over HTTP. The adapter process is stood in for
 * by the runner tests' scriptable fake agent (`spawn` is injected), so every test sees a real child
 * process and the real client, and what the host asked to start is what is checked.
 */

type Frame = Record<string, unknown>;

const fixture = join(
  import.meta.dir,
  "..",
  "..",
  "runner",
  "tests",
  "fixtures",
  "fake-acp-agent.ts",
);
const scratch = mkdtempSync(join(tmpdir(), "xiongbao-cloud-acp-"));
const work = join(scratch, "workspace", "computers", "agent_1");
const BIN = join(scratch, "adapters", "node_modules", ".bin");
const MODEL = {
  baseUrl: "https://xiongbao.test/api/agent-model",
  token: "tok_secret_value",
  model: "deepseek-chat",
};

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Setup = {
  cloud: CloudAcp;
  spawns: AcpSpawnSpec[];
  call: (path: string, init?: RequestInit, seat?: string) => Promise<Response>;
  post: (frame: Frame, seat?: string) => Promise<Response>;
  /** Frames read off the streams so far. */
  frames: Frame[];
  /** Which streams (in the order opened) have ended. */
  ended: boolean[];
  streamOpen: () => Promise<Response>;
  waitFor: (check: () => boolean) => Promise<void>;
};

function setup(
  options: {
    workdirFor?: (seat: string) => Promise<string | null>;
    script?: Record<string, unknown>;
    idleMs?: number;
    parentEnv?: Record<string, string | undefined>;
  } = {},
): Setup {
  mkdirSync(work, { recursive: true });
  const spawns: AcpSpawnSpec[] = [];
  const tempRoot = join(scratch, `tmp-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempRoot, { recursive: true });
  let started = 0;
  const cloud = createCloudAcp({
    workdirFor: options.workdirFor ?? (async () => work),
    binDir: BIN,
    adapterDir: join(scratch, "state", "adapters"),
    homeRoot: join(scratch, "state", "homes"),
    env: (_seat, _workdir, home) => ({
      PATH: "/usr/bin:/bin",
      HOME: home,
      HTTPS_PROXY: "http://127.0.0.1:3128",
    }),
    parentEnv: options.parentEnv ?? {
      PATH: "/usr/bin",
      COMPUTER_TOKEN: "computer-secret",
      EGRESS_PROXY_DEFAULT: "http://user:pass@egress.internal:8080",
    },
    beatMs: 40,
    tempRoot,
    ...(options.idleMs ? { idleMs: options.idleMs } : {}),
    spawn: (spec, handlers, clientOptions) => {
      spawns.push(spec);
      started += 1;
      const scriptFile = join(scratch, `script-${started}-${Date.now()}.json`);
      writeFileSync(
        scriptFile,
        JSON.stringify({
          modes: {
            currentModeId: "x",
            availableModes: [
              { id: spec.sessionMode ?? "x", name: "ask" },
              { id: "x", name: "x" },
            ],
          },
          turns: [{ steps: [{ update: chunk("hi") }] }],
          ...options.script,
        }),
      );
      return createAcpClient(
        {
          ...spec,
          command: process.execPath,
          args: [fixture],
          env: { FAKE_ACP_SCRIPT_FILE: scriptFile },
          cwd: work,
        },
        handlers,
        clientOptions,
      );
    },
  });
  closers.push(() => cloud.closeAll());
  const call = (path: string, init?: RequestInit, seat = "agent_1") => {
    const request = new Request(`http://computer.test${path}`, init);
    return cloud.handle(request, new URL(request.url), seat);
  };
  const post = (frame: Frame, seat = "agent_1") =>
    call(
      "/acp/frame",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(frame),
      },
      seat,
    );
  const frames: Frame[] = [];
  const ended: boolean[] = [];
  const streamOpen = async () => {
    const index = ended.push(false) - 1;
    const controller = new AbortController();
    closers.push(() => controller.abort());
    const response = await call("/acp/events", {
      method: "GET",
      signal: controller.signal,
    });
    void (async () => {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({
          done: true,
          value: undefined,
        }));
        if (done) {
          ended[index] = true;
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf("\n");
        while (at >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          if (line) frames.push(JSON.parse(line));
          at = buffer.indexOf("\n");
        }
      }
    })();
    return response;
  };
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 8000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return {
    cloud,
    spawns,
    call,
    post,
    frames,
    ended,
    streamOpen,
    waitFor,
  };
}

const chunk = (text: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

const open = (harness: string, extra: Frame = {}): Frame => ({
  type: "acp.open",
  agentId: "agent_1",
  threadId: "th_1",
  harness,
  workdirRef: ACP_CLOUD_WORKDIR_REF,
  model: {
    ...MODEL,
    wire: "messages",
  },
  ...extra,
});

const prompt = (turnId = "turn_1"): Frame => ({
  type: "acp.prompt",
  agentId: "agent_1",
  threadId: "th_1",
  turnId,
  content: [{ type: "text", text: "hello" }],
});

const ofType = (frames: Frame[], type: string) =>
  frames.filter((frame) => frame.type === type);

describe("the channel's paths", () => {
  test("only the three paths are its own", () => {
    expect(isAcpPath("/acp/frame")).toBe(true);
    expect(isAcpPath("/acp/events")).toBe(true);
    expect(isAcpPath("/acp/ack")).toBe(true);
    expect(isAcpPath("/acp")).toBe(false);
    expect(isAcpPath("/files/read")).toBe(false);
  });

  test("an unknown method or path under it is a 404", async () => {
    const t = setup();
    expect((await t.call("/acp/frame", { method: "GET" })).status).toBe(404);
    expect((await t.call("/acp/other", { method: "POST" })).status).toBe(404);
  });
});

describe("a frame from the server", () => {
  test("it must be a JSON object naming this seat's employee", async () => {
    const t = setup();
    const garbage = await t.call("/acp/frame", {
      method: "POST",
      body: "not json",
    });
    expect(garbage.status).toBe(400);
    const list = await t.call("/acp/frame", {
      method: "POST",
      body: "[]",
    });
    expect(list.status).toBe(400);
    // The seat is the employee: another employee's frame on this seat's route is refused.
    const other = await t.post({ ...open("claude-code"), agentId: "agent_2" });
    expect(other.status).toBe(400);
    expect(t.cloud.hosts()).toBe(0);
    expect(t.spawns).toHaveLength(0);
  });

  test("a frame over the size limit is refused before it is read", async () => {
    const t = setup();
    const response = await t.call("/acp/frame", {
      method: "POST",
      headers: { "content-length": String(ACP_FRAME_BODY_LIMIT + 1) },
      body: "{}",
    });
    expect(response.status).toBe(413);
  });

  test("a seat that cannot run an employee here is told why, and no process starts", async () => {
    const t = setup({ workdirFor: async () => null });
    const response = await t.post(open("claude-code"));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain(
      "独立的 Linux 用户",
    );
    expect((await t.call("/acp/events")).status).toBe(409);
    expect(t.spawns).toHaveLength(0);
  });

  test("a frame that is not an acp frame is not handled", async () => {
    const t = setup();
    const response = await t.post({ type: "files.read", agentId: "agent_1" });
    expect(await response.json()).toEqual({ handled: false });
  });
});

describe("the computer carries Claude Code only", () => {
  test("a Codex open is refused with start_failed, with or without a model, and nothing starts", async () => {
    const t = setup();
    await t.streamOpen();
    await t.post(open("codex"));
    const { model: _model, ...bare } = open("codex");
    await t.post({ ...bare, threadId: "th_2" });
    await t.waitFor(() => ofType(t.frames, "acp.error").length === 2);
    expect(ofType(t.frames, "acp.error").map((frame) => frame.code)).toEqual([
      "start_failed",
      "start_failed",
    ]);
    expect(t.spawns).toHaveLength(0);
  });

  test("the computer's own secrets are unset for the adapter, not inherited", async () => {
    const t = setup();
    await t.streamOpen();
    await t.post(open("claude-code"));
    await t.waitFor(() => t.spawns.length === 1);
    const spec = t.spawns[0] as AcpSpawnSpec;
    expect(spec.unsetEnv).toContain("COMPUTER_TOKEN");
    expect(spec.unsetEnv).toContain("EGRESS_PROXY_DEFAULT");
    // What it is given instead is the allow list, and nothing of the computer's.
    expect(Object.keys(spec.env)).not.toContain("COMPUTER_TOKEN");
    expect(JSON.stringify(spec.env)).not.toContain("computer-secret");
    expect(JSON.stringify(spec.env)).not.toContain("user:pass");
    // The pass travels in the environment, never in a file; the home is the seat's own.
    expect(spec.env.HOME).toBe(join(scratch, "state", "homes", "agent_1"));
    expect(spec.env.HTTPS_PROXY).toBe("http://127.0.0.1:3128");
    // Never the working folder, never `npx`.
    expect(spec.command).toBe("node");
    expect(spec.cwd).toBe(join(scratch, "state", "adapters"));
  });

  test("without a model it does not start: a cloud employee has no login of its own", async () => {
    const t = setup();
    await t.streamOpen();
    const { model: _model, ...bare } = open("claude-code");
    await t.post(bare);
    await t.waitFor(() => ofType(t.frames, "acp.error").length === 1);
    expect(t.spawns).toHaveLength(0);
    expect(ofType(t.frames, "acp.error")[0]).toMatchObject({
      agentId: "agent_1",
      threadId: "th_1",
      code: "start_failed",
    });
  });

  test("another harness, or a folder it does not know, is not started", async () => {
    const t = setup();
    await t.streamOpen();
    await t.post(open("hermes", { model: undefined }));
    await t.post(open("claude-code", { workdirRef: "fld_elsewhere" }));
    await t.waitFor(() => ofType(t.frames, "acp.error").length === 2);
    expect(ofType(t.frames, "acp.error").map((frame) => frame.code)).toEqual([
      "start_failed",
      "unknown_workdir",
    ]);
    expect(t.spawns).toHaveLength(0);
  });
});

describe("starting Claude Code", () => {
  test("the model goes in the environment and the session is the ask mode", async () => {
    const t = setup();
    await t.streamOpen();
    await t.post(open("claude-code"));
    await t.waitFor(() => ofType(t.frames, "acp.session").length === 1);
    const spec = t.spawns[0] as AcpSpawnSpec;
    expect(spec.args).toEqual([join(BIN, "claude-agent-acp")]);
    expect(spec.sessionMode).toBe("default");
    expect(spec.env.ANTHROPIC_BASE_URL).toBe(MODEL.baseUrl);
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe(MODEL.token);
    expect(spec.env.ANTHROPIC_MODEL).toBe(MODEL.model);
    expect(spec.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(spec.env.INITIAL_AGENT_MODE).toBeUndefined();
    expect(spec.unsetEnv).toContain("ANTHROPIC_API_KEY");
    expect(spec.unsetEnv).toContain("COMPUTER_TOKEN");
  });
});

describe("the stream and the turns", () => {
  test("a turn's frames come up the stream, in order, after the stream's own first line", async () => {
    const t = setup();
    await t.streamOpen();
    await t.post(open("claude-code"));
    await t.post(prompt());
    await t.waitFor(() =>
      t.frames.some((frame) => frame.type === "acp.turn.end"),
    );
    expect(t.frames[0]?.type).toBe("acp.stream");
    expect(typeof t.frames[0]?.connectionId).toBe("string");
    // The host's inventory comes before anything else of its own.
    expect(t.frames[1]?.type).toBe("acp.inventory");
    const turn = t.frames.filter((frame) => frame.turnId === "turn_1");
    expect(turn.map((frame) => frame.type)).toEqual([
      "acp.turn.ack",
      "acp.update",
      "acp.turn.end",
    ]);
    expect(turn[2]).toMatchObject({ stopReason: "end_turn" });
  });

  test("a heartbeat is a line the server answers once, with the stream's id", async () => {
    const t = setup();
    await t.streamOpen();
    await t.waitFor(() => ofType(t.frames, "acp.beat").length >= 2);
    const id = t.frames[0]?.connectionId as string;
    const ack = (connectionId: unknown) =>
      t.call("/acp/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
    expect((await ack(id)).status).toBe(200);
    // Not the id of this stream: proves nothing about it.
    expect((await ack("another")).status).toBe(409);
    expect((await ack(undefined)).status).toBe(409);
  });

  test("a frame the server did not acknowledge is sent again on the next stream, and a newer stream replaces the older one", async () => {
    const t = setup();
    await t.streamOpen();
    await t.post(open("claude-code"));
    await t.post(prompt());
    await t.waitFor(() =>
      t.frames.some((frame) => frame.type === "acp.turn.end"),
    );
    const before = t.frames.length;
    const firstId = t.frames[0]?.connectionId;
    // Never acknowledged. A second stream: the host replays everything it kept.
    await t.streamOpen();
    await t.waitFor(() =>
      t.frames
        .slice(before)
        .some(
          (frame) => frame.type === "acp.turn.end" && frame.turnId === "turn_1",
        ),
    );
    const secondId = t.frames.find(
      (frame, index) => index >= before && frame.type === "acp.stream",
    )?.connectionId;
    expect(secondId).not.toBe(firstId);
    // The older response is ended, the newer one is not.
    await t.waitFor(() => t.ended[0] === true);
    expect(t.ended[1]).toBe(false);
    // An ack naming the old stream is stale.
    const stale = await t.call("/acp/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: firstId }),
    });
    expect(stale.status).toBe(409);
  });

  test("two employees on one computer are two hosts, each with its own stream and folder", async () => {
    const t = setup();
    await t.call("/acp/events", { method: "GET" }, "agent_1");
    await t.call("/acp/events", { method: "GET" }, "agent_2");
    expect(t.cloud.hosts()).toBe(2);
  });
});
