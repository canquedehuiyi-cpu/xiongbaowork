import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { createCloudAcp } from "../../agent-computer/src/acp-cloud";
import type { AcpClient } from "../../runner/src/acp/client";
import {
  ACP_CLOUD_WORKDIR_REF,
  acpCloudAgentOf,
  acpCloudDeviceId,
  acpRuntimeFrom,
} from "../../shared/acp";
import { HEADER } from "../../shared/wire-headers";
import {
  createAcpSessionHints,
  DeviceAcpAgent,
  type DeviceAcpAgentConfig,
  type DeviceAcpEmployee,
  deviceAcpAgentFor,
  useDeviceAcp,
} from "../src/agents/acp/agent";
import {
  type CloudComputers,
  createCloudLink,
} from "../src/agents/acp/cloud-link";
import { createAcpRelay } from "../src/agents/acp/relay";
import {
  createAcpModelAccess,
  readAgentModelComputerUrl,
} from "../src/agents/model-proxy/access";
import { createAgentModelTokens } from "../src/agents/model-proxy/token";
import {
  externalConfiguration,
  externalField,
} from "../src/agents/profile-store";
import { registeredAgentFromRow } from "../src/copilot";
import type { DeviceChannel } from "../src/devices/channel";
import { createMemoryAcpTurnStore } from "./support/acp-turns-memory";

/*
 * 期八·二: an employee whose runtime is `cloud` has its frames carried to its own computer through the
 * computer gateway, and what the computer says comes back as the relay's own up frames. The computer
 * here is the real channel module of the agent computer (agent-computer/src/acp-cloud.ts) behind a
 * `fetch` that answers as its HTTP port would, with the adapter process stood in for by a scripted
 * client; the relay, turn store, agent and link are the real ones.
 */

type Frame = Record<string, unknown>;

const TENANT = "tenant-a";
const AGENT = "agent-1";
const CLOUD = acpCloudDeviceId(AGENT);
const TOKEN = "computer-token-of-this-seat";
const COMPUTER = "http://computer.internal:4100";

const scratch = mkdtempSync(join(tmpdir(), "xiongbao-cloud-link-"));
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(5);
  }
}

/** A stand-in for the adapter process: opens a session, answers a prompt with one chunk. */
function fakeAdapter(
  handlers: { onUpdate: (sessionId: string, update: unknown) => void },
  script: { reply?: string } = {},
): AcpClient {
  let alive = true;
  return {
    initialize: async () => ({ loadSession: false }),
    newSession: async () => "sess-1",
    loadSession: async () => false,
    prompt: async (sessionId) => {
      handlers.onUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: script.reply ?? "做好了" },
      });
      return { stopReason: "end_turn" };
    },
    cancel: () => undefined,
    close: async () => {
      alive = false;
    },
    get alive() {
      return alive;
    },
  };
}

type World = {
  link: ReturnType<typeof createCloudLink>;
  channel: DeviceChannel;
  base: { notified: Frame[] };
  relay: ReturnType<typeof createAcpRelay>;
  turns: ReturnType<typeof createMemoryAcpTurnStore>;
  gateway: { located: string[]; sought: [string, string][] };
  /** What the computer was asked, in order. */
  requests: { method: string; path: string; headers: Headers; body?: Frame }[];
  /** Makes the computer unreachable (or reachable again). */
  down: { value: boolean };
  spawned: { env: Record<string, string> }[];
};

function world(
  options: {
    locate?: (seat: string) => Promise<string>;
    idleMs?: number;
    retryMs?: readonly number[];
  } = {},
): World {
  const work = join(scratch, `w-${Math.random().toString(36).slice(2)}`);
  mkdirSync(work, { recursive: true });
  const spawned: World["spawned"] = [];
  const cloud = createCloudAcp({
    workdirFor: async () => work,
    binDir: join(scratch, "bin"),
    adapterDir: join(scratch, "state", "adapters"),
    homeRoot: join(scratch, "state", "homes"),
    env: () => ({ PATH: "/usr/bin" }),
    parentEnv: {},
    beatMs: 25,
    tempRoot: scratch,
    spawn: (spec, handlers) => {
      spawned.push({ env: spec.env });
      return fakeAdapter(handlers);
    },
  });
  closers.push(() => cloud.closeAll());
  const requests: World["requests"] = [];
  const down = { value: false };
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (down.value) throw new TypeError("connection refused");
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const request = new Request(String(input), { ...init, headers });
    const body =
      init?.method === "POST" && typeof init.body === "string"
        ? (JSON.parse(init.body) as Frame)
        : undefined;
    requests.push({
      method: request.method,
      path: url.pathname,
      headers,
      ...(body ? { body } : {}),
    });
    // The computer's own door: the token first, then the seat the headers name.
    if (headers.get(HEADER.computerToken) !== TOKEN)
      return Response.json({ error: "Not authorised." }, { status: 401 });
    const seat = headers.get(HEADER.botId) ?? "";
    return cloud.handle(request, url, seat);
  }) as typeof fetch;

  const gateway = { located: [] as string[], sought: [] as [string, string][] };
  const computers: CloudComputers = {
    seatFor: async (botId, personId) => {
      gateway.sought.push([botId, personId]);
      return { botId, key: { kind: "person", personId } } as never;
    },
    locate: async (seat) => {
      gateway.located.push((seat as { botId: string }).botId);
      return options.locate
        ? options.locate((seat as { botId: string }).botId)
        : COMPUTER;
    },
    tokenFor: () => TOKEN,
    addressOf: (seat) => ({ botId: (seat as { botId: string }).botId }),
  };
  const turns = createMemoryAcpTurnStore();
  const base = { notified: [] as Frame[] };
  const baseChannel = {
    notify: (_target: unknown, frame: Frame) => {
      base.notified.push(frame);
      return true;
    },
    isReachable: () => true,
    connectionOf: () => "device-connection",
  } as unknown as DeviceChannel;
  // eslint-disable-next-line prefer-const
  let relay!: ReturnType<typeof createAcpRelay>;
  const link = createCloudLink({
    gateway: computers,
    relay: () => relay,
    fetchImpl,
    ...(options.idleMs ? { idleMs: options.idleMs } : {}),
    retryMs: options.retryMs ?? [5, 5, 5],
    log: () => undefined,
  });
  closers.push(() => link.close());
  const channel = link.withCloudDevices(baseChannel);
  relay = createAcpRelay({
    channel,
    turns,
    startQueuedTurn: async () => {
      throw new Error("no starter");
    },
    log: () => undefined,
  });
  return {
    link,
    channel,
    base,
    relay,
    turns,
    gateway,
    requests,
    down,
    spawned,
  };
}

const MODEL = {
  baseUrl: "http://server.internal:3001/api/agent-model",
  token: "xbm_pass",
  model: "deepseek-chat",
  wire: "responses" as const,
};

function agentConfig(w: World, overrides: Partial<DeviceAcpAgentConfig> = {}) {
  return {
    agentId: AGENT,
    ownerUserId: TENANT,
    tenantId: TENANT,
    deviceId: CLOUD,
    harness: "codex",
    workdirRef: ACP_CLOUD_WORKDIR_REF,
    runtime: "cloud",
    name: "小码",
    relay: w.relay,
    turns: w.turns,
    reachable: () =>
      w.channel.isReachable({ tenantId: TENANT, deviceId: CLOUD }),
    resume: () => w.link.ensure({ tenantId: TENANT, deviceId: CLOUD }),
    prepare: () => w.link.open({ tenantId: TENANT, deviceId: CLOUD }),
    context: async () => [],
    sessions: createAcpSessionHints(),
    model: async () => MODEL,
    newTurnId: () => "turn-1",
    log: () => undefined,
    ...overrides,
  } as DeviceAcpAgentConfig;
}

const input = (threadId = "thread-1"): RunAgentInput => ({
  threadId,
  runId: "run-1",
  messages: [{ id: "m1", role: "user", content: "把登录页修好" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});

/** Runs the agent to its end and gives back the events it emitted. */
async function runToEnd(agent: DeviceAcpAgent, threadId = "thread-1") {
  const events: { type: string; delta?: string; message?: string }[] = [];
  let done = false;
  agent.run(input(threadId)).subscribe({
    next: (event) => events.push(event as never),
    error: () => {
      done = true;
    },
    complete: () => {
      done = true;
    },
  });
  await until(() => done);
  return events;
}

describe("a cloud employee's identity", () => {
  test("its runtime is `device` unless the configuration says `cloud`", () => {
    for (const configuration of [
      undefined,
      null,
      {},
      { harness: "codex" },
      { runtime: "device" },
      { runtime: "local" },
      { runtime: 1 },
      [],
      "cloud",
    ])
      expect(acpRuntimeFrom(configuration)).toBe("device");
    expect(acpRuntimeFrom({ runtime: "cloud" })).toBe("cloud");
  });

  test("its device id is made from its own id, and only that kind of id reads back as an employee", () => {
    expect(CLOUD).toBe("cloud:agent-1");
    expect(acpCloudAgentOf(CLOUD)).toBe(AGENT);
    expect(acpCloudAgentOf("laptop-1a2b3c4d")).toBeNull();
    expect(acpCloudAgentOf("cloud:")).toBeNull();
  });

  const row = (configuration: unknown) => ({
    id: AGENT,
    name: "小码",
    type: "device_acp" as const,
    configuration,
    title: "外部员工 · Codex",
    roleDescription: "干活的 Codex。",
    ownerUserId: TENANT,
  });

  test("a saved employee with no runtime is built as it always was, on its device", () => {
    const device = registeredAgentFromRow(
      row({
        deviceId: "laptop-1a2b3c4d",
        harness: "codex",
        workdirRef: "fld_work",
        permissions: {},
      }),
    );
    expect(device).toMatchObject({
      type: "device_acp",
      deviceId: "laptop-1a2b3c4d",
      workdirRef: "fld_work",
    });
    expect(device).not.toHaveProperty("runtime");
    // An explicit `device` is the same.
    const explicit = registeredAgentFromRow(
      row({
        deviceId: "laptop-1a2b3c4d",
        harness: "codex",
        workdirRef: "fld_work",
        runtime: "device",
      }),
    );
    expect(explicit).not.toHaveProperty("runtime");
  });

  test("a cloud employee is built on its own cloud device and the fixed folder, whatever was saved", () => {
    const cloud = registeredAgentFromRow(
      row({
        // Another employee's lane and a path: neither is believed.
        deviceId: "cloud:somebody-else",
        harness: "claude-code",
        workdirRef: "/etc",
        runtime: "cloud",
      }),
    );
    expect(cloud).toMatchObject({
      type: "device_acp",
      deviceId: CLOUD,
      workdirRef: ACP_CLOUD_WORKDIR_REF,
      runtime: "cloud",
      harness: "claude-code",
    });
  });
});

describe("how the runtime is saved", () => {
  const permissions = {
    editInside: "direct",
    touchOutside: "ask",
    runCommand: "dangerous",
    network: "ask",
    push: "ask",
  } as const;

  test("a device employee is saved exactly as before: no runtime key, its own device and folder", () => {
    expect(
      externalConfiguration(
        {
          deviceId: "laptop-1a2b3c4d",
          harness: "codex",
          workdirRef: "fld_work",
          permissions,
        },
        AGENT,
      ),
    ).toEqual({
      deviceId: "laptop-1a2b3c4d",
      harness: "codex",
      workdirRef: "fld_work",
      permissions,
    });
    // A runtime of `device` written out is the same as none.
    expect(
      externalConfiguration(
        {
          deviceId: "laptop-1a2b3c4d",
          harness: "codex",
          workdirRef: "fld_work",
          permissions,
          runtime: "device",
        },
        AGENT,
      ),
    ).not.toHaveProperty("runtime");
  });

  test("a cloud employee is saved on its own cloud device and the fixed folder, with its runtime", () => {
    expect(
      externalConfiguration(
        {
          deviceId: "",
          harness: "claude-code",
          workdirRef: "",
          permissions,
          runtime: "cloud",
        },
        AGENT,
      ),
    ).toEqual({
      deviceId: CLOUD,
      harness: "claude-code",
      workdirRef: ACP_CLOUD_WORKDIR_REF,
      runtime: "cloud",
      permissions,
    });
  });

  test("a screen reads `runtime` only off a cloud employee", () => {
    const saved = (configuration: Record<string, unknown>) =>
      externalField({ type: "device_acp", configuration }).externalRun;
    const device = saved({
      deviceId: "laptop-1a2b3c4d",
      harness: "codex",
      workdirRef: "fld_work",
    });
    expect(device).toBeDefined();
    expect(device).not.toHaveProperty("runtime");
    expect(
      saved({
        deviceId: CLOUD,
        harness: "codex",
        workdirRef: ACP_CLOUD_WORKDIR_REF,
        runtime: "cloud",
      }),
    ).toMatchObject({ runtime: "cloud", deviceId: CLOUD });
  });
});

describe("the model address a cloud computer is given", () => {
  const route = "/api/agent-model";
  test("its own setting, else the one devices use", () => {
    expect(
      readAgentModelComputerUrl(
        { XIONGBAO_AGENT_MODEL_COMPUTER_URL: "http://server:3001/" },
        "https://public.example/api/agent-model",
        route,
      ),
    ).toBe("http://server:3001/api/agent-model");
    for (const bad of [undefined, "", "  ", "ftp://x", "not a url"])
      expect(
        readAgentModelComputerUrl(
          { XIONGBAO_AGENT_MODEL_COMPUTER_URL: bad },
          "https://public.example/api/agent-model",
          route,
        ),
      ).toBe("https://public.example/api/agent-model");
    expect(readAgentModelComputerUrl({}, undefined, route)).toBeUndefined();
  });

  test("a cloud open carries it, a device open carries the device's, and the pass is the same kind", async () => {
    const tokens = createAgentModelTokens({ encryptionKey: "k".repeat(32) });
    const access = createAcpModelAccess({
      tokens,
      baseUrl: "https://public.example/api/agent-model",
      computerBaseUrl: "http://server:3001/api/agent-model",
      boundModel: async () => "deepseek-chat",
    });
    const asked = {
      tenantId: TENANT,
      agentId: AGENT,
      threadId: "t",
      harness: "codex" as const,
    };
    const cloud = await access.issue({ ...asked, runtime: "cloud" });
    const device = await access.issue(asked);
    expect(cloud?.baseUrl).toBe("http://server:3001/api/agent-model");
    expect(device?.baseUrl).toBe("https://public.example/api/agent-model");
    for (const block of [cloud, device])
      expect(tokens.verify(block?.token)).toMatchObject({
        tenantId: TENANT,
        agentId: AGENT,
        threadId: "t",
      });
    // With no address of its own a computer is given the device one.
    const plain = createAcpModelAccess({
      tokens,
      baseUrl: "https://public.example/api/agent-model",
      boundModel: async () => "deepseek-chat",
    });
    expect((await plain.issue({ ...asked, runtime: "cloud" }))?.baseUrl).toBe(
      "https://public.example/api/agent-model",
    );
  });
});

describe("a cloud employee's turn goes through the computer gateway", () => {
  test("open and prompt reach the computer, in order, with its token and seat; the answer comes back as the turn's frames", async () => {
    const w = world();
    const events = await runToEnd(new DeviceAcpAgent(agentConfig(w)));

    // The gateway was asked for this employee's seat (the hirer's tenant) and woke the computer.
    expect(w.gateway.sought[0]).toEqual([AGENT, TENANT]);
    expect(w.gateway.located.length).toBeGreaterThan(0);
    const frames = w.requests.filter((r) => r.path === "/acp/frame");
    expect(frames.map((r) => r.body?.type)).toEqual(["acp.open", "acp.prompt"]);
    for (const request of w.requests) {
      expect(request.headers.get(HEADER.computerToken)).toBe(TOKEN);
      expect(request.headers.get(HEADER.botId)).toBe(AGENT);
    }
    // The stream was open before the first frame went down (its inventory comes first).
    expect(w.requests[0]).toMatchObject({ method: "GET", path: "/acp/events" });
    const open = frames[0]?.body as Frame;
    expect(open).toMatchObject({
      agentId: AGENT,
      threadId: "thread-1",
      harness: "codex",
      workdirRef: ACP_CLOUD_WORKDIR_REF,
      model: MODEL,
    });
    // The agent really started on the computer, on the model's pass.
    expect(w.spawned).toHaveLength(1);
    expect(w.spawned[0]?.env.XIONGBAO_AGENT_MODEL_TOKEN).toBe(MODEL.token);
    // And the answer reached the run.
    expect(
      events.some(
        (event) =>
          event.type === EventType.TEXT_MESSAGE_CONTENT &&
          event.delta === "做好了",
      ),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    // Nothing of a cloud employee's went down a device's socket.
    expect(w.base.notified).toEqual([]);
    // The turn is done in the store, queued under the employee's cloud device.
    expect(w.turns.rows[0]).toMatchObject({ deviceId: CLOUD, status: "done" });
  });

  test("the stream is acknowledged beat by beat once the relay has taken in what came before", async () => {
    const w = world();
    await runToEnd(new DeviceAcpAgent(agentConfig(w)));
    await until(() => w.requests.some((r) => r.path === "/acp/ack"));
    const ack = w.requests.find((r) => r.path === "/acp/ack");
    expect(ack?.method).toBe("POST");
    expect(typeof ack?.body?.connectionId).toBe("string");
  });

  test("the relay's connection for the frames is the stream's, before and after it opens", async () => {
    const w = world();
    const target = { tenantId: TENANT, deviceId: CLOUD };
    const before = w.channel.connectionOf(target);
    expect(typeof before).toBe("string");
    expect(w.channel.connectionOf(target)).toBe(before);
    expect(
      w.channel.notify(target, {
        type: "acp.cancel",
        agentId: AGENT,
        threadId: "t",
        turnId: "x",
      }),
    ).toBe(true);
    await until(() => w.requests.some((r) => r.path === "/acp/frame"));
    expect(w.channel.connectionOf(target)).toBe(before);
  });

  test("a cloud employee is reachable without waking its computer", () => {
    const w = world();
    expect(w.channel.isReachable({ tenantId: TENANT, deviceId: CLOUD })).toBe(
      true,
    );
    expect(w.gateway.located).toEqual([]);
    expect(w.requests).toEqual([]);
  });

  test("it does not start without a model of its own: the turn is cancelled and nothing is sent", async () => {
    const w = world();
    const events = await runToEnd(
      new DeviceAcpAgent(agentConfig(w, { model: async () => null })),
    );
    const error = events.find((event) => event.type === EventType.RUN_ERROR);
    expect(error?.message).toContain("还没有可用的模型");
    // Nothing was sent to the computer: no frame, so no agent started there.
    expect(w.requests.filter((r) => r.path === "/acp/frame")).toEqual([]);
    expect(w.spawned).toEqual([]);
    expect(w.turns.rows[0]?.status).toBe("cancelled");
  });

  test("a device employee with no model still opens as it always did", async () => {
    const w = world();
    const target = { tenantId: TENANT, deviceId: "laptop" };
    let done = false;
    new DeviceAcpAgent(
      agentConfig(w, {
        deviceId: "laptop",
        runtime: undefined,
        resume: undefined,
        prepare: undefined,
        workdirRef: "fld_work",
        model: async () => null,
        reachable: () => w.channel.isReachable(target),
      }),
    )
      .run(input())
      .subscribe({ error: () => undefined, complete: () => (done = true) });
    await until(() => w.base.notified.some((f) => f.type === "acp.open"));
    expect(done).toBe(false);
    expect(w.base.notified[0]).toEqual({
      type: "acp.open",
      agentId: AGENT,
      threadId: "thread-1",
      harness: "codex",
      workdirRef: "fld_work",
    });
    // The gateway was never asked.
    expect(w.gateway.sought).toEqual([]);
    expect(w.requests).toEqual([]);
  });
});

describe("a computer that cannot be reached", () => {
  test("the run ends with a sentence and the lane goes on", async () => {
    const w = world();
    w.down.value = true;
    const events = await runToEnd(new DeviceAcpAgent(agentConfig(w)));
    const error = events.find((event) => event.type === EventType.RUN_ERROR);
    expect(error).toBeDefined();
    expect(w.turns.rows[0]?.status).not.toBe("sent");
    expect(w.turns.rows[0]?.status).not.toBe("running");
    // Nothing is left to wait for: no turn is held on the link.
    const fresh = world();
    expect(fresh.link.links()).toBe(0);
  });

  test("a computer that answers late is waited for through a few tries", async () => {
    const w = world();
    w.down.value = true;
    setTimeout(() => {
      w.down.value = false;
    }, 8);
    const events = await runToEnd(new DeviceAcpAgent(agentConfig(w)));
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  test("an address that is a paired machine is refused, not dialled", async () => {
    const w = world({ locate: async () => "runner:tenant-a/laptop" });
    const events = await runToEnd(new DeviceAcpAgent(agentConfig(w)));
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
      true,
    );
    expect(w.requests).toEqual([]);
  });

  test("the computer's own refusal is the sentence the person reads", async () => {
    // An employee with a Linux user of its own is refused by the computer (409 with its reason).
    const refusing = createCloudAcp({
      workdirFor: async () => null,
      binDir: scratch,
      adapterDir: scratch,
      homeRoot: scratch,
      env: () => ({}),
    });
    closers.push(() => refusing.closeAll());
    const heard: Frame[] = [];
    const relay = {
      fromRunner: (_from: unknown, frame: Frame) => heard.push(frame),
      drain: async () => true,
      resumeQueued: async () => 0,
    };
    const lone = createCloudLink({
      gateway: {
        seatFor: async (botId) => ({ botId }) as never,
        locate: async () => COMPUTER,
        tokenFor: () => TOKEN,
        addressOf: (seat) => ({ botId: (seat as { botId: string }).botId }),
      },
      relay: () => relay,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(String(input), init);
        return refusing.handle(request, new URL(request.url), AGENT);
      }) as typeof fetch,
      retryMs: [1],
      log: () => undefined,
    });
    closers.push(() => lone.close());
    const lonely = lone.withCloudDevices({} as never);
    lonely.notify(
      { tenantId: TENANT, deviceId: CLOUD },
      { type: "acp.open", agentId: AGENT, threadId: "th", harness: "codex" },
    );
    await until(() => heard.some((frame) => frame.type === "acp.error"));
    expect(heard[0]).toMatchObject({
      type: "acp.error",
      agentId: AGENT,
      threadId: "th",
      code: "start_failed",
    });
    expect(String(heard[0]?.message)).toContain("独立的 Linux 用户");
  });

  test("a prompt that could not go ends its turn with an error, as a device would", async () => {
    const heard: Frame[] = [];
    const down = { value: true };
    const link = createCloudLink({
      gateway: {
        seatFor: async (botId) => ({ botId }) as never,
        locate: async () => COMPUTER,
        tokenFor: () => TOKEN,
        addressOf: (seat) => ({ botId: (seat as { botId: string }).botId }),
      },
      relay: () => ({
        fromRunner: (_from, frame) => {
          heard.push(frame);
        },
        drain: async () => true,
        resumeQueued: async () => 0,
      }),
      fetchImpl: (async () => {
        if (down.value) throw new TypeError("refused");
        return Response.json({});
      }) as unknown as typeof fetch,
      retryMs: [1],
      log: () => undefined,
    });
    closers.push(() => link.close());
    const channel = link.withCloudDevices({} as never);
    channel.notify(
      { tenantId: TENANT, deviceId: CLOUD },
      {
        type: "acp.prompt",
        agentId: AGENT,
        threadId: "th",
        turnId: "tn",
        content: [],
      },
    );
    await until(() => heard.some((frame) => frame.type === "acp.turn.end"));
    expect(heard.map((frame) => frame.type)).toEqual([
      "acp.error",
      "acp.turn.end",
    ]);
    expect(heard[0]).toMatchObject({ turnId: "tn", code: "start_failed" });
    expect(heard[1]).toMatchObject({
      turnId: "tn",
      stopReason: "error",
      interrupted: false,
    });
  });
});

describe("the stream's life", () => {
  test("it is closed once nothing is on the computer and it has been quiet, and opened again by the next frame", async () => {
    const w = world({ idleMs: 60 });
    await runToEnd(new DeviceAcpAgent(agentConfig(w)));
    const target = { tenantId: TENANT, deviceId: CLOUD };
    const first = w.channel.connectionOf(target);
    // Quiet for longer than the idle time, with nothing on the computer: the next beat closes it.
    await until(() => w.link.links() === 0, 4000);
    expect(w.requests.filter((r) => r.path === "/acp/events")).toHaveLength(1);
    // The next frame opens a stream again, on a connection of its own.
    w.channel.notify(target, {
      type: "acp.cancel",
      agentId: AGENT,
      threadId: "thread-1",
      turnId: "nothing",
    });
    await until(
      () => w.requests.filter((r) => r.path === "/acp/events").length === 2,
    );
    expect(w.channel.connectionOf(target)).not.toBe(first);
  });

  test("a turn waiting behind an older one asks the computer what it has, by opening the stream", async () => {
    const w = world();
    const target = { tenantId: TENANT, deviceId: CLOUD };
    expect(w.requests).toEqual([]);
    w.link.ensure(target);
    await until(() => w.requests.some((r) => r.path === "/acp/events"));
    // A device id that is not a cloud one is none of the link's business.
    w.link.ensure({ tenantId: TENANT, deviceId: "laptop" });
    expect(w.link.links()).toBe(1);
  });

  test("closing the link ends its streams and refuses new frames", async () => {
    const w = world();
    const target = { tenantId: TENANT, deviceId: CLOUD };
    w.link.ensure(target);
    await until(() => w.requests.some((r) => r.path === "/acp/events"));
    w.link.close();
    expect(w.channel.isReachable(target)).toBe(false);
    expect(
      w.channel.notify(target, { type: "acp.cancel", agentId: AGENT }),
    ).toBe(false);
  });

  test("another device id goes to the real channel untouched", () => {
    const w = world();
    const target = { tenantId: TENANT, deviceId: "laptop-1a2b3c4d" };
    expect(w.channel.connectionOf(target)).toBe("device-connection");
    expect(w.channel.notify(target, { type: "acp.cancel" })).toBe(true);
    expect(w.base.notified).toEqual([{ type: "acp.cancel" }]);
    expect(w.link.links()).toBe(0);
  });

  test("a cloud employee is not reachable where this deployment has no computers", () => {
    const link = createCloudLink({
      gateway: {} as never,
      relay: () => undefined,
      enabled: false,
    });
    const channel = link.withCloudDevices({} as never);
    const target = { tenantId: TENANT, deviceId: CLOUD };
    expect(channel.isReachable(target)).toBe(false);
    expect(channel.notify(target, { type: "acp.cancel" })).toBe(false);
  });
});

describe("the factory for a cloud employee", () => {
  test("deviceAcpAgentFor asks the model for the computer's address and tells the access it is a cloud run", async () => {
    const w = world();
    const issued: unknown[] = [];
    useDeviceAcp({
      relay: w.relay,
      turns: w.turns,
      channel: w.channel,
      sessions: createAcpSessionHints(),
      context: async () => [],
      cloud: w.link,
      model: {
        issue: async (asked) => {
          issued.push(asked);
          return MODEL;
        },
      },
    });
    try {
      const employee: DeviceAcpEmployee = {
        id: AGENT,
        name: "小码",
        ownerUserId: TENANT,
        deviceId: CLOUD,
        harness: "codex",
        workdirRef: ACP_CLOUD_WORKDIR_REF,
        runtime: "cloud",
        persona: "后端工程师",
      };
      const agent = deviceAcpAgentFor(employee, { tenantId: TENANT });
      await runToEnd(agent as DeviceAcpAgent);
      expect(issued).toEqual([
        {
          tenantId: TENANT,
          agentId: AGENT,
          threadId: "thread-1",
          harness: "codex",
          runtime: "cloud",
        },
      ]);
    } finally {
      useDeviceAcp(null);
    }
  });
});

afterEach(() => {
  // The scratch folder is shared by every test of this file and removed with the process.
});
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
