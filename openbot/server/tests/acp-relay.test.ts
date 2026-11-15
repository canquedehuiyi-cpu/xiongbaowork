import { describe, expect, test } from "bun:test";
import { type AcpRelayDeps, createAcpRelay } from "../src/agents/acp/relay";
import type { AcpTurnRow } from "../src/agents/acp/turns";
import { createDeviceChannel } from "../src/devices/channel";
import { runnerClose, runnerMessage, runnerOpen } from "../src/devices/socket";
import type { DeviceStore } from "../src/devices/store";
import { createMemoryAcpTurnStore } from "./support/acp-turns-memory";

/*
 * 外部员工的上行帧路由（relay.ts）。轮次存储用内存版（与数据库版同规则，见
 * acp-turns.integration.test.ts）；设备通道是假的，只记下发给设备的帧。
 */

type Frame = Record<string, unknown>;
const target = { tenantId: "tenant-a", deviceId: "laptop" };

function setup(
  options: {
    startFails?: boolean;
    deps?: (
      turns: ReturnType<typeof createMemoryAcpTurnStore>,
    ) => Partial<AcpRelayDeps>;
  } = {},
) {
  const turns = createMemoryAcpTurnStore();
  const down: Frame[] = [];
  const logs: string[] = [];
  const state = { reachable: true, connection: "conn-1" };
  const started: AcpTurnRow[] = [];
  const relay = createAcpRelay({
    channel: {
      notify: (_target, frame) => {
        if (!state.reachable) return false;
        down.push(frame);
        return true;
      },
      isReachable: () => state.reachable,
      connectionOf: () => (state.reachable ? state.connection : null),
    },
    turns,
    startQueuedTurn: async (row) => {
      if (options.startFails) throw new Error("no transport");
      started.push(row);
    },
    log: (message) => logs.push(message),
    ...(options.deps?.(turns) ?? {}),
  });
  const heard = (turnId: string) => {
    const frames: Frame[] = [];
    relay.subscribe(turnId, (frame) => frames.push(frame));
    return frames;
  };
  const turn = async (
    turnId: string,
    lane: { agentId?: string; threadId?: string; deviceId?: string } = {},
    status?: AcpTurnRow["status"],
  ) => {
    await turns.enqueue({
      tenantId: target.tenantId,
      agentId: lane.agentId ?? "agent-1",
      threadId: lane.threadId ?? "thread-1",
      deviceId: lane.deviceId ?? target.deviceId,
      turnId,
      prompt: [{ type: "text", text: turnId }],
    });
    if (status) await turns.setStatus(target.tenantId, turnId, status);
  };
  const statusOf = (turnId: string) =>
    turns.rows.find((row) => row.turnId === turnId)?.status;
  const from = (connectionId = state.connection) => ({
    ...target,
    connectionId,
  });
  return {
    turns,
    relay,
    down,
    logs,
    state,
    started,
    heard,
    turn,
    statusOf,
    from,
    settle: () => relay.drain({ ...target, connectionId: state.connection }),
  };
}

const update = (turnId: string, seq: number, extra: Frame = {}): Frame => ({
  type: "acp.update",
  agentId: "agent-1",
  threadId: "thread-1",
  turnId,
  seq,
  update: { sessionUpdate: "agent_message_chunk", seq },
  ...extra,
});
const end = (turnId: string, extra: Frame = {}): Frame => ({
  type: "acp.turn.end",
  agentId: "agent-1",
  threadId: "thread-1",
  turnId,
  stopReason: "end_turn",
  interrupted: false,
  ...extra,
});
const inventory = (
  turns: {
    turnId: string;
    state: string;
    agentId?: string;
    threadId?: string;
  }[],
  extra: Frame = {},
): Frame => ({
  type: "acp.inventory",
  instanceId: "instance-1",
  turns: turns.map((turn) => ({
    agentId: "agent-1",
    threadId: "thread-1",
    ...turn,
  })),
  requestIds: [],
  ...extra,
});
const seqs = (frames: Frame[]) =>
  frames.filter((frame) => frame.type === "acp.update").map((f) => f.seq);

describe("acp relay", () => {
  test("duplicate and stale seq are dropped, gaps are passed in order", async () => {
    const { relay, turn, heard, from, settle, turns } = setup();
    await turn("turn-1", {}, "running");
    const frames = heard("turn-1");
    for (const seq of [1, 2, 2, 1, 5, 3, 4, 5, 6])
      relay.fromRunner(from(), update("turn-1", seq));
    expect(await settle()).toBeTrue();
    expect(seqs(frames)).toEqual([1, 2, 5, 6]);
    // The last seq is kept, so a server that restarts does not take the replay in again.
    await Bun.sleep(5);
    expect(turns.rows[0]?.lastSeq).toBe(6);
  });

  test("seq already taken in before a restart is not taken in again", async () => {
    const { relay, turn, heard, from, settle, turns } = setup();
    await turn("turn-1", {}, "running");
    await turns.recordSeq(target.tenantId, "turn-1", 3);
    const frames = heard("turn-1");
    for (const seq of [1, 2, 3, 4])
      relay.fromRunner(from(), update("turn-1", seq));
    await settle();
    expect(seqs(frames)).toEqual([4]);
  });

  test("a frame for another device's or another employee's turn is dropped", async () => {
    const { relay, turn, heard, from, settle, logs } = setup();
    await turn("theirs", { deviceId: "desktop" }, "running");
    await turn("mine", {}, "running");
    const theirs = heard("theirs");
    const mine = heard("mine");
    relay.fromRunner(from(), update("theirs", 1));
    // Right turn, wrong employee: every frame names its employee, and it must be the turn's.
    relay.fromRunner(from(), update("mine", 1, { agentId: "agent-2" }));
    relay.fromRunner(from(), update("mine", 1, { threadId: "thread-2" }));
    relay.fromRunner(from(), update("nobody", 1));
    await settle();
    expect(theirs).toEqual([]);
    expect(mine).toEqual([]);
    expect(logs.length).toBe(4);
  });

  test("a replayed acp.turn.end is not a second end, and replays after it are dropped", async () => {
    const { relay, turn, heard, from, settle, statusOf } = setup();
    await turn("turn-1", {}, "running");
    const frames = heard("turn-1");
    relay.fromRunner(from(), update("turn-1", 1));
    relay.fromRunner(from(), end("turn-1"));
    // The reconnect replays everything kept for the ended turn.
    relay.fromRunner(
      from("conn-2"),
      inventory([{ turnId: "turn-1", state: "ended" }]),
    );
    relay.fromRunner(from("conn-2"), update("turn-1", 1));
    relay.fromRunner(from("conn-2"), end("turn-1"));
    relay.fromRunner(
      from("conn-2"),
      end("turn-1", { stopReason: "cancelled" }),
    );
    await settle();
    expect(frames.map((frame) => frame.type)).toEqual([
      "acp.update",
      "acp.turn.end",
    ]);
    expect(statusOf("turn-1")).toBe("done");
  });

  test("the end's stop reason decides the final status", async () => {
    const { relay, turn, from, settle, statusOf } = setup();
    await turn("t-done", { threadId: "a" }, "running");
    await turn("t-cancel", { threadId: "b" }, "running");
    await turn("t-gone", { threadId: "c" }, "running");
    await turn("t-error", { threadId: "d" }, "running");
    relay.fromRunner(from(), end("t-done", { threadId: "a" }));
    relay.fromRunner(
      from(),
      end("t-cancel", { threadId: "b", stopReason: "cancelled" }),
    );
    relay.fromRunner(
      from(),
      end("t-gone", {
        threadId: "c",
        stopReason: "interrupted",
        interrupted: true,
      }),
    );
    relay.fromRunner(
      from(),
      end("t-error", { threadId: "d", stopReason: "error" }),
    );
    await settle();
    expect(statusOf("t-done")).toBe("done");
    expect(statusOf("t-cancel")).toBe("cancelled");
    expect(statusOf("t-gone")).toBe("interrupted");
    expect(statusOf("t-error")).toBe("done");
  });

  test("ack takes a sent turn off the queue; a permission request makes it awaiting until answered", async () => {
    const { relay, turn, heard, from, settle, statusOf, turns } = setup();
    await turn("turn-1", {}, "sent");
    const frames = heard("turn-1");
    const ack = {
      type: "acp.turn.ack",
      agentId: "agent-1",
      threadId: "thread-1",
      turnId: "turn-1",
    };
    relay.fromRunner(from(), ack);
    relay.fromRunner(from(), ack);
    await settle();
    expect(statusOf("turn-1")).toBe("running");
    expect(await turns.countQueued(target.tenantId, "agent-1")).toBe(0);
    const request = {
      type: "acp.permission.request",
      agentId: "agent-1",
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "perm-1",
      toolCall: { kind: "execute" },
      options: [],
      facts: { insideWorkdir: true, paths: [] },
    };
    relay.fromRunner(from(), request);
    await settle();
    expect(statusOf("turn-1")).toBe("awaiting");
    expect(
      relay.send(target, {
        type: "acp.permission.answer",
        agentId: "agent-1",
        requestId: "perm-1",
        optionId: "allow_once",
      }),
    ).toBeTrue();
    await settle();
    expect(statusOf("turn-1")).toBe("running");
    // One ack: a replayed ack is no news.
    expect(frames.map((frame) => frame.type)).toEqual([
      "acp.turn.ack",
      "acp.permission.request",
    ]);
  });

  test("a turn missing from the inventory is interrupted; one the runner still has is kept", async () => {
    const { relay, turn, heard, from, settle, statusOf } = setup();
    await turn("gone", { threadId: "a" }, "running");
    await turn("waiting", { threadId: "b" }, "awaiting");
    await turn("lost", { threadId: "c" }, "sent");
    await turn("kept", { threadId: "d" }, "running");
    await turn("later", { threadId: "e" });
    const gone = heard("gone");
    relay.fromRunner(
      from("conn-2"),
      inventory([{ turnId: "kept", threadId: "d", state: "awaiting" }]),
    );
    await settle();
    expect(statusOf("gone")).toBe("interrupted");
    expect(statusOf("waiting")).toBe("interrupted");
    expect(statusOf("lost")).toBe("interrupted");
    expect(statusOf("kept")).toBe("awaiting");
    // Not the inventory's business: a queued turn was never on the device.
    expect(statusOf("later")).not.toBe("interrupted");
    expect(gone).toEqual([
      {
        type: "acp.turn.end",
        agentId: "agent-1",
        threadId: "a",
        turnId: "gone",
        stopReason: "interrupted",
        interrupted: true,
        reconciled: true,
      },
    ]);
  });

  test("a truncated inventory interrupts nothing", async () => {
    const { relay, turn, from, settle, statusOf } = setup();
    await turn("turn-1", {}, "running");
    relay.fromRunner(from("conn-2"), inventory([], { truncated: true }));
    await settle();
    expect(statusOf("turn-1")).toBe("running");
  });

  test("a turn prompted on the new connection before its inventory arrived is not interrupted", async () => {
    const { relay, turn, from, settle, statusOf, state } = setup();
    await turn("old", { threadId: "a" }, "sent");
    await turn("new", { threadId: "b" }, "sent");
    // The prompt for `new` went out on conn-2 after the runner had already written its inventory.
    state.connection = "conn-2";
    relay.send(target, {
      type: "acp.prompt",
      agentId: "agent-1",
      threadId: "b",
      turnId: "new",
      content: [],
    });
    relay.fromRunner(from("conn-2"), inventory([]));
    await settle();
    expect(statusOf("old")).toBe("interrupted");
    expect(statusOf("new")).toBe("sent");
  });

  test("a turn the inventory reports ended whose end never arrives is interrupted after the replay", async () => {
    const { relay, turn, from, settle, statusOf } = setup();
    await turn("turn-1", {}, "running");
    relay.fromRunner(
      from("conn-2"),
      inventory([{ turnId: "turn-1", state: "ended" }]),
    );
    await settle();
    expect(statusOf("turn-1")).toBe("running");
    // The beat that went up before the inventory, then the first one after the replay.
    await relay.resumeQueued(target);
    expect(statusOf("turn-1")).toBe("running");
    await relay.resumeQueued(target);
    expect(statusOf("turn-1")).toBe("interrupted");
  });

  test("several turns of one employee ending interrupted at once each end once, and their threads go on", async () => {
    const { relay, turn, heard, from, settle, statusOf, started } = setup();
    await turn("a1", { threadId: "a" }, "running");
    await turn("b1", { threadId: "b" }, "awaiting");
    await turn("a2", { threadId: "a" });
    await turn("b2", { threadId: "b" });
    const a1 = heard("a1");
    const b1 = heard("b1");
    const gone = { stopReason: "interrupted", interrupted: true };
    relay.fromRunner(from(), end("a1", { threadId: "a", ...gone }));
    relay.fromRunner(from(), end("b1", { threadId: "b", ...gone }));
    relay.fromRunner(from(), end("a1", { threadId: "a", ...gone }));
    await settle();
    await Bun.sleep(5);
    await settle();
    expect(a1.length).toBe(1);
    expect(b1.length).toBe(1);
    expect(statusOf("a1")).toBe("interrupted");
    expect(statusOf("b1")).toBe("interrupted");
    expect(started.map((row) => row.turnId).sort()).toEqual(["a2", "b2"]);
  });

  test("turn-less frames reach the open turns of their lane; another lane's are dropped; replays wait for a new open", async () => {
    const { relay, turn, heard, from, settle, logs } = setup();
    await turn("turn-1", {}, "sent");
    await turn("other", { agentId: "agent-2" }, "running");
    const frames = heard("turn-1");
    const other = heard("other");
    const session = {
      type: "acp.session",
      agentId: "agent-1",
      threadId: "thread-1",
      sessionId: "sess-1",
      loaded: false,
    };
    const error = {
      type: "acp.error",
      agentId: "agent-1",
      threadId: "thread-1",
      code: "unknown_workdir",
      message: "工作文件夹不在了",
    };
    relay.fromRunner(from(), session);
    relay.fromRunner(from(), error);
    // Replayed on a reconnect: the same frames again.
    relay.fromRunner(from(), session);
    relay.fromRunner(from(), error);
    // No turn of agent-1 in thread-9 on this device: dropped.
    relay.fromRunner(from(), { ...error, threadId: "thread-9" });
    await settle();
    expect(frames).toEqual([session, error]);
    expect(other).toEqual([]);
    expect(logs.length).toBe(1);
    // A new open may legitimately fail the same way again.
    relay.send(target, {
      type: "acp.open",
      agentId: "agent-1",
      threadId: "thread-1",
      harness: "codex",
      workdirRef: "fld_1",
    });
    relay.fromRunner(from(), error);
    await settle();
    expect(frames).toEqual([session, error, error]);
  });

  test("bad_option and ask_mode_lost errors reach the turn, once each however often replayed", async () => {
    const { relay, turn, heard, from, settle } = setup();
    await turn("turn-1", {}, "running");
    const frames = heard("turn-1");
    for (const code of ["bad_option", "ask_mode_lost", "bad_option"])
      relay.fromRunner(from(), {
        type: "acp.error",
        agentId: "agent-1",
        threadId: "thread-1",
        turnId: "turn-1",
        code,
        message: "…",
      });
    await settle();
    expect(frames.map((frame) => frame.code)).toEqual([
      "bad_option",
      "ask_mode_lost",
    ]);
  });

  test("an unsubscribed listener hears nothing more, and a throwing one does not stop the others", async () => {
    const { relay, turn, from, settle } = setup();
    await turn("turn-1", {}, "running");
    const heard: unknown[] = [];
    const stop = relay.subscribe("turn-1", (frame) => heard.push(frame.seq));
    relay.subscribe("turn-1", () => {
      throw new Error("listener broke");
    });
    relay.fromRunner(from(), update("turn-1", 1));
    await settle();
    stop();
    relay.fromRunner(from(), update("turn-1", 2));
    expect(await settle()).toBeTrue();
    expect(heard).toEqual([1]);
  });

  test("send writes to the device, and says false when it is away", () => {
    const { relay, down, state } = setup();
    const frame = {
      type: "acp.cancel",
      agentId: "agent-1",
      threadId: "thread-1",
      turnId: "turn-1",
    };
    expect(relay.send(target, frame)).toBeTrue();
    state.reachable = false;
    expect(relay.send(target, frame)).toBeFalse();
    expect(down).toEqual([frame]);
  });

  test("resumeQueued puts a turn back in the queue when it could not be started", async () => {
    const { relay, turn, statusOf } = setup({ startFails: true });
    await turn("turn-1");
    expect(await relay.resumeQueued(target)).toBe(0);
    expect(statusOf("turn-1")).toBe("queued");
  });

  test("resumeQueued starts nothing while the device is away", async () => {
    const { relay, turn, state, started } = setup();
    await turn("turn-1");
    state.reachable = false;
    expect(await relay.resumeQueued(target)).toBe(0);
    expect(started).toEqual([]);
  });

  test("an update whose status write failed is taken in when it is replayed", async () => {
    const { relay, turn, heard, from, settle, turns, statusOf } = setup();
    await turn("turn-1", {}, "sent");
    const frames = heard("turn-1");
    const write = turns.setStatus;
    let blips = 1;
    turns.setStatus = async (...args) => {
      if (blips-- > 0) throw new Error("database blip");
      return write(...args);
    };
    // The ack's write fails, then the update's too: the socket is closed and all is sent again.
    relay.fromRunner(from(), update("turn-1", 1));
    expect(await settle()).toBeFalse();
    expect(frames).toEqual([]);
    relay.fromRunner(from("conn-2"), update("turn-1", 1));
    relay.fromRunner(from("conn-2"), update("turn-1", 2));
    expect(await relay.drain({ ...target, connectionId: "conn-2" })).toBeTrue();
    expect(seqs(frames)).toEqual([1, 2]);
    expect(statusOf("turn-1")).toBe("running");
  });

  test("a failure on a connection that is gone does not fail the drain of the new one", async () => {
    const { relay, turn, from, turns } = setup();
    await turn("turn-1", {}, "running");
    const read = turns.get;
    let blips = 1;
    turns.get = async (...args) => {
      if (blips-- > 0) throw new Error("database away");
      return read(...args);
    };
    relay.fromRunner(from("conn-1"), update("turn-1", 1));
    relay.fromRunner(from("conn-2"), update("turn-1", 1));
    expect(await relay.drain({ ...target, connectionId: "conn-2" })).toBeTrue();
  });

  test("draining one connection keeps another connection's failure for that one's drain", async () => {
    const { relay, turn, from, turns } = setup();
    await turn("turn-1", {}, "running");
    const read = turns.get;
    let blips = 1;
    turns.get = async (...args) => {
      if (blips-- > 0) throw new Error("database away");
      return read(...args);
    };
    relay.fromRunner(from("conn-1"), update("turn-1", 1));
    // The new connection drains first: clean, and conn-1's failure is still conn-1's.
    expect(await relay.drain({ ...target, connectionId: "conn-2" })).toBeTrue();
    expect(
      await relay.drain({ ...target, connectionId: "conn-1" }),
    ).toBeFalse();
    // Reported once: the mark goes with the drain that reported it.
    expect(await relay.drain({ ...target, connectionId: "conn-1" })).toBeTrue();
  });

  test("a runner of another tenant can neither answer nor take over a request id", async () => {
    const { relay, turn, from, settle, statusOf, turns } = setup();
    await turn("turn-a", {}, "running");
    const other = { tenantId: "tenant-b", deviceId: "laptop" };
    await turns.enqueue({
      ...other,
      agentId: "agent-1",
      threadId: "thread-1",
      turnId: "turn-b",
      prompt: [],
    });
    await turns.setStatus(other.tenantId, "turn-b", "running");
    const request = (turnId: string): Frame => ({
      type: "acp.permission.request",
      agentId: "agent-1",
      threadId: "thread-1",
      turnId,
      requestId: "perm-1",
      toolCall: {},
      options: [],
      facts: { insideWorkdir: true, paths: [] },
    });
    const answer = {
      type: "acp.permission.answer",
      agentId: "agent-1",
      requestId: "perm-1",
      optionId: "allow_once",
    };
    relay.fromRunner(from(), request("turn-a"));
    await settle();
    expect(statusOf("turn-a")).toBe("awaiting");
    // Tenant B's runner reports the same request id for its own turn, and B's side answers it.
    relay.fromRunner({ ...other, connectionId: "conn-b" }, request("turn-b"));
    await relay.drain(other);
    relay.send(other, answer);
    await relay.drain(other);
    await settle();
    expect(statusOf("turn-a")).toBe("awaiting");
    expect(statusOf("turn-b")).toBe("running");
    // A's own answer still finds A's turn.
    relay.send(target, answer);
    await settle();
    expect(statusOf("turn-a")).toBe("running");
  });

  test("drain says false when a frame could not be taken in", async () => {
    const { relay, turn, from, turns, settle } = setup();
    await turn("turn-1", {}, "running");
    turns.get = async () => {
      throw new Error("database away");
    };
    relay.fromRunner(from(), update("turn-1", 1));
    expect(await settle()).toBeFalse();
    // Said once: the next drain starts clean.
    expect(await settle()).toBeTrue();
  });
});

describe("runner socket and acp frames", () => {
  const owner = { tenantId: "tenant-a", deviceId: "laptop", id: "dev-1" };
  const store = {
    isCurrent: async () => true,
    heartbeat: async () => undefined,
  } as unknown as DeviceStore;

  function socket() {
    const channel = createDeviceChannel();
    const sent: string[] = [];
    const closed: number[] = [];
    const ws = {
      data: { runner: owner, connection: undefined as string | undefined },
      send: (value: string) => sent.push(value),
      close: (code?: number) => closed.push(code ?? 0),
    };
    ws.data.connection = channel.attach(
      { tenantId: owner.tenantId, deviceId: owner.deviceId },
      ws,
    );
    return { channel, sent, closed, ws };
  }

  test("an unknown acp.* type does not reach the 'Nothing handles' error path", async () => {
    const { channel, sent, ws } = socket();
    const seen: Frame[] = [];
    const acp = {
      fromRunner: (_from: unknown, frame: Frame) => seen.push(frame),
      drain: async () => true,
      resumeQueued: async () => 0,
    };
    await runnerMessage(
      ws,
      store,
      channel,
      JSON.stringify({ type: "acp.someday" }),
      undefined,
      {
        acp,
      },
    );
    // Without a relay too: an acp frame is never "nothing handles".
    await runnerMessage(
      ws,
      store,
      channel,
      JSON.stringify({ type: "acp.update" }),
    );
    expect(sent).toEqual([]);
    expect(seen).toEqual([{ type: "acp.someday" }]);
  });

  test("acp frames go to the relay with this socket's tenant, device and connection, and only while attached", async () => {
    const { channel, ws } = socket();
    const seen: unknown[] = [];
    const acp = {
      fromRunner: (from: unknown, frame: Frame) =>
        seen.push([from, frame.type]),
      drain: async () => true,
      resumeQueued: async () => 0,
    };
    await runnerMessage(
      ws,
      store,
      channel,
      JSON.stringify({ type: "acp.update", tenantId: "tenant-b" }),
      undefined,
      { acp },
    );
    expect(seen).toEqual([
      [
        {
          tenantId: "tenant-a",
          deviceId: "laptop",
          connectionId: ws.data.connection,
        },
        "acp.update",
      ],
    ]);
    channel.detach(ws.data.connection as string);
    await runnerMessage(
      ws,
      store,
      channel,
      JSON.stringify({ type: "acp.update" }),
      undefined,
      {
        acp,
      },
    );
    expect(seen.length).toBe(1);
  });

  test("acp frames that arrive while the socket is still opening are taken in, in order, once it is registered", async () => {
    const channel = createDeviceChannel();
    let admit = (_value: boolean) => {};
    const slowStore = {
      isCurrent: () =>
        new Promise<boolean>((resolve) => {
          admit = resolve;
        }),
      heartbeat: async () => undefined,
    } as unknown as DeviceStore;
    const ws = {
      data: { runner: owner } as {
        runner: typeof owner;
        connection?: string;
        held?: Frame[];
      },
      send: () => undefined,
      close: () => undefined,
    };
    const seen: unknown[] = [];
    const acp = {
      fromRunner: (from: { connectionId?: string }, frame: Frame) =>
        seen.push([from.connectionId, frame.type]),
      drain: async () => true,
      resumeQueued: async () => 0,
    };
    const opening = runnerOpen(ws, slowStore, channel, undefined, acp);
    // The runner's inventory and replay, sent the moment its socket opened.
    for (const type of ["acp.inventory", "acp.update", "acp.turn.end"])
      await runnerMessage(
        ws,
        slowStore,
        channel,
        JSON.stringify({ type }),
        undefined,
        {
          acp,
        },
      );
    expect(seen).toEqual([]);
    admit(true);
    await opening;
    await runnerMessage(
      ws,
      slowStore,
      channel,
      JSON.stringify({ type: "acp.session" }),
      undefined,
      {
        acp,
      },
    );
    const connection = ws.data.connection;
    expect(connection).toBeString();
    expect(seen).toEqual([
      [connection, "acp.inventory"],
      [connection, "acp.update"],
      [connection, "acp.turn.end"],
      [connection, "acp.session"],
    ]);
    expect(ws.data.held).toBeUndefined();
    runnerClose(ws, channel);
  });

  test("a heartbeat that arrives while the socket opens is acked only after the held frames are taken in", async () => {
    const channel = createDeviceChannel();
    let admit = (_value: boolean) => {};
    let calls = 0;
    const store = {
      // The open's check is slow; the beat's own check is not.
      isCurrent: () =>
        ++calls === 1
          ? new Promise<boolean>((resolve) => {
              admit = resolve;
            })
          : Promise.resolve(true),
      heartbeat: async () => undefined,
    } as unknown as DeviceStore;
    const sent: string[] = [];
    const ws = {
      data: { runner: owner } as {
        runner: typeof owner;
        connection?: string;
        held?: Frame[];
      },
      send: (value: string) => sent.push(value),
      close: () => undefined,
    };
    const order: string[] = [];
    const acp = {
      fromRunner: (_from: unknown, frame: Frame) =>
        order.push(String(frame.type)),
      drain: async () => {
        order.push("drain");
        return true;
      },
      resumeQueued: async () => 0,
    };
    const opening = runnerOpen(ws, store, channel, undefined, acp);
    await runnerMessage(
      ws,
      store,
      channel,
      JSON.stringify({ type: "acp.turn.end" }),
      undefined,
      {
        acp,
      },
    );
    const beat = runnerMessage(
      ws,
      store,
      channel,
      JSON.stringify({ type: "heartbeat" }),
      undefined,
      { acp },
    );
    await Bun.sleep(5);
    expect(sent).toEqual([]);
    admit(true);
    await opening;
    await beat;
    expect(order).toEqual(["acp.turn.end", "drain"]);
    expect(sent).toEqual([
      JSON.stringify({ type: "welcome" }),
      JSON.stringify({ type: "ack" }),
    ]);
    runnerClose(ws, channel);
  });

  test("acp frames held by a socket that is refused are dropped", async () => {
    const channel = createDeviceChannel();
    const refusing = {
      isCurrent: async () => false,
      heartbeat: async () => undefined,
    } as unknown as DeviceStore;
    const closed: number[] = [];
    const ws = {
      data: { runner: owner } as { runner: typeof owner; connection?: string },
      send: () => undefined,
      close: (code?: number) => closed.push(code ?? 0),
    };
    const seen: unknown[] = [];
    const acp = {
      fromRunner: (_from: unknown, frame: Frame) => seen.push(frame),
    };
    const opening = runnerOpen(ws, refusing, channel, undefined, acp);
    await runnerMessage(
      ws,
      refusing,
      channel,
      JSON.stringify({ type: "acp.update" }),
      undefined,
      {
        acp: { ...acp, drain: async () => true, resumeQueued: async () => 0 },
      },
    );
    await opening;
    expect(seen).toEqual([]);
    expect(closed).toEqual([1008]);
  });

  test("a heartbeat is acked once the relay has taken in what came before it, then queued turns resume", async () => {
    const { channel, sent, ws } = socket();
    const order: string[] = [];
    let release = () => {};
    const acp = {
      fromRunner: () => undefined,
      drain: () =>
        new Promise<boolean>((resolve) => {
          release = () => {
            order.push("drained");
            resolve(true);
          };
        }),
      resumeQueued: async () => {
        order.push("resumed");
        return 0;
      },
    };
    const beat = runnerMessage(
      ws,
      store,
      channel,
      JSON.stringify({ type: "heartbeat" }),
      undefined,
      { acp },
    );
    await Bun.sleep(5);
    expect(sent).toEqual([]);
    release();
    await beat;
    expect(sent).toEqual([JSON.stringify({ type: "ack" })]);
    expect(order).toEqual(["drained", "resumed"]);
  });

  test("a heartbeat closes the socket instead of acking when a frame could not be taken in", async () => {
    const { channel, sent, closed, ws } = socket();
    const acp = {
      fromRunner: () => undefined,
      drain: async () => false,
      resumeQueued: async () => 0,
    };
    await runnerMessage(
      ws,
      store,
      channel,
      JSON.stringify({ type: "heartbeat" }),
      undefined,
      {
        acp,
      },
    );
    expect(sent).toEqual([]);
    expect(closed).toEqual([1011]);
    expect(channel.isAttached(ws.data.connection as string)).toBeFalse();
  });
});

const permissionRequest = (turnId: string, requestId = "req-1"): Frame => ({
  type: "acp.permission.request",
  agentId: "agent-1",
  threadId: "thread-1",
  turnId,
  requestId,
  toolCall: { toolCallId: "call-1", kind: "execute", title: "git push" },
  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
});

describe("acp relay: turns nobody here follows", () => {
  /** A relay whose `adoptTurn` starts a "run" (a run listener) unless told otherwise. */
  function orphans(
    adopt: "run" | "impossible" | "throws" | "none" = "run",
    jobTimeoutMs?: number,
  ) {
    const adopted: AcpTurnRow[] = [];
    const runFrames: Frame[] = [];
    const permissions: { row: AcpTurnRow; frame: Frame }[] = [];
    const closed: {
      turnId: string;
      runRef?: string;
      followed: boolean;
      status: string;
    }[] = [];
    const mode = { adopt };
    const t = setup({
      deps: () => ({
        ...(mode.adopt === "none"
          ? {}
          : {
              adoptTurn: async (row: AcpTurnRow) => {
                adopted.push(row);
                if (mode.adopt === "throws") throw new Error("thread mid-run");
                if (mode.adopt === "impossible") return false;
                t.relay.subscribe(
                  row.turnId,
                  (frame) => runFrames.push(frame),
                  {
                    run: true,
                  },
                );
                return true;
              },
            }),
        permission: (row: AcpTurnRow, frame: Frame) =>
          permissions.push({ row, frame }),
        closed: async (turn, info) => {
          closed.push({
            turnId: turn.turnId,
            ...(turn.runRef ? { runRef: turn.runRef } : {}),
            followed: info.followed,
            status: turn.status,
          });
        },
        ...(jobTimeoutMs ? { jobTimeoutMs } : {}),
      }),
    });
    const running = async (
      turnId: string,
      status: AcpTurnRow["status"] = "running",
    ) => {
      await t.turns.enqueue({
        tenantId: target.tenantId,
        agentId: "agent-1",
        threadId: "thread-1",
        deviceId: target.deviceId,
        turnId,
        prompt: {
          content: [{ type: "text", text: turnId }],
          runRef: `card-${turnId}`,
        },
      });
      if (status !== "queued")
        await t.turns.setStatus(target.tenantId, turnId, status);
    };
    return { ...t, adopted, runFrames, permissions, closed, mode, running };
  }
  const cancels = (down: Frame[]) =>
    down.filter((frame) => frame.type === "acp.cancel");

  test("after a restart, a replayed frame of a live turn starts a run that follows it, and the answer reaches it", async () => {
    const t = orphans();
    await t.running("turn-1");
    // A fresh relay (the restarted server): nothing subscribed. The device replays.
    t.relay.fromRunner(t.from(), update("turn-1", 1));
    t.relay.fromRunner(t.from(), update("turn-1", 2));
    t.relay.fromRunner(t.from(), end("turn-1"));
    expect(await t.settle()).toBeTrue();
    // Adopted once, from the stored row; every frame went to the run, the end included.
    expect(t.adopted.map((row) => row.turnId)).toEqual(["turn-1"]);
    expect(t.runFrames.map((frame) => frame.type)).toEqual([
      "acp.update",
      "acp.update",
      "acp.turn.end",
    ]);
    expect(t.statusOf("turn-1")).toBe("done");
    // The run closes its own card: nothing else is told to.
    expect(t.closed).toEqual([]);
    expect(cancels(t.down)).toEqual([]);
  });

  test("an inventory listing a live turn nobody follows adopts it at once", async () => {
    const t = orphans();
    await t.running("turn-1", "awaiting");
    t.relay.fromRunner(
      t.from(),
      inventory([{ turnId: "turn-1", state: "awaiting" }]),
    );
    expect(await t.settle()).toBeTrue();
    expect(t.adopted.map((row) => row.turnId)).toEqual(["turn-1"]);
    // A replayed permission request then reaches the run, and the bridge only through it.
    t.relay.fromRunner(t.from(), permissionRequest("turn-1"));
    expect(await t.settle()).toBeTrue();
    expect(t.runFrames.map((frame) => frame.type)).toEqual([
      "acp.permission.request",
    ]);
    expect(t.permissions).toEqual([]);
  });

  test("a permission request with no run to carry it goes straight to the bridge", async () => {
    const t = orphans("none");
    await t.running("turn-1");
    t.relay.fromRunner(t.from(), permissionRequest("turn-1"));
    expect(await t.settle()).toBeTrue();
    expect(t.permissions).toHaveLength(1);
    expect(t.permissions[0]?.row.turnId).toBe("turn-1");
    expect(t.permissions[0]?.frame.requestId).toBe("req-1");
    expect(t.statusOf("turn-1")).toBe("awaiting");
  });

  test("a turn that cannot be adopted is cancelled on the device, ended interrupted, and its card and approvals closed", async () => {
    const t = orphans("impossible");
    await t.running("turn-1");
    t.relay.fromRunner(t.from(), permissionRequest("turn-1"));
    t.relay.fromRunner(t.from(), update("turn-1", 1));
    expect(await t.settle()).toBeTrue();
    expect(cancels(t.down)).toEqual([
      {
        type: "acp.cancel",
        agentId: "agent-1",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    ]);
    expect(t.statusOf("turn-1")).toBe("interrupted");
    expect(t.closed).toEqual([
      {
        turnId: "turn-1",
        runRef: "card-turn-1",
        followed: false,
        status: "interrupted",
      },
    ]);
    // Neither frame was taken in, the request reached no bridge, and the update asks no second
    // cancel on this connection.
    expect(t.runFrames).toEqual([]);
    expect(t.permissions).toEqual([]);
    expect(t.adopted).toHaveLength(1);
  });

  test("an adoption that throws takes nothing in: drain fails and the replay adopts it later", async () => {
    const t = orphans("throws");
    await t.running("turn-1");
    t.relay.fromRunner(t.from(), update("turn-1", 1));
    expect(await t.settle()).toBeFalse();
    expect(t.turns.rows[0]?.lastSeq).toBe(0);
    expect(t.statusOf("turn-1")).toBe("running");
    // The device reconnects and replays; this time the thread is free.
    t.mode.adopt = "run";
    t.relay.fromRunner(t.from("conn-2"), update("turn-1", 1));
    expect(
      await t.relay.drain({ ...target, connectionId: "conn-2" }),
    ).toBeTrue();
    expect(t.runFrames.map((frame) => frame.seq)).toEqual([1]);
  });

  test("an inventory turn gone from the device with nobody following it closes its card", async () => {
    const t = orphans();
    await t.running("turn-1", "sent");
    t.relay.fromRunner(t.from(), inventory([]));
    expect(await t.settle()).toBeTrue();
    expect(t.statusOf("turn-1")).toBe("interrupted");
    expect(t.closed).toEqual([
      {
        turnId: "turn-1",
        runRef: "card-turn-1",
        followed: false,
        status: "interrupted",
      },
    ]);
  });

  test("stopped while the device was away: its inventory still lists the turn, and it is cancelled there", async () => {
    const t = orphans();
    await t.running("turn-1");
    // Stop while the computer was away: the row is cancelled here only.
    await t.turns.setStatus(target.tenantId, "turn-1", "cancelled");
    t.relay.fromRunner(
      t.from(),
      inventory([{ turnId: "turn-1", state: "running" }]),
    );
    expect(await t.settle()).toBeTrue();
    expect(cancels(t.down)).toEqual([
      {
        type: "acp.cancel",
        agentId: "agent-1",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    ]);
    // Its frames are not taken in, nothing is adopted, and a replay asks no second cancel on this
    // connection; a permission request of it is never opened.
    t.relay.fromRunner(t.from(), update("turn-1", 1));
    t.relay.fromRunner(t.from(), permissionRequest("turn-1"));
    expect(await t.settle()).toBeTrue();
    expect(cancels(t.down)).toHaveLength(1);
    expect(t.adopted).toEqual([]);
    expect(t.permissions).toEqual([]);
    // On the next connection, the device is told again.
    t.state.connection = "conn-2";
    t.relay.fromRunner(t.from("conn-2"), permissionRequest("turn-1"));
    expect(
      await t.relay.drain({ ...target, connectionId: "conn-2" }),
    ).toBeTrue();
    expect(cancels(t.down)).toHaveLength(2);
  });

  test("another tenant's or another device's turn listed in an inventory is never cancelled", async () => {
    const t = orphans();
    await t.turns.enqueue({
      tenantId: "tenant-b",
      agentId: "agent-1",
      threadId: "thread-1",
      deviceId: target.deviceId,
      turnId: "turn-b",
      prompt: [],
    });
    await t.turns.setStatus("tenant-b", "turn-b", "cancelled");
    t.relay.fromRunner(
      t.from(),
      inventory([{ turnId: "turn-b", state: "running" }]),
    );
    expect(await t.settle()).toBeTrue();
    expect(cancels(t.down)).toEqual([]);
  });

  test("cancelTurn: a queued turn never runs and its card closes", async () => {
    const t = orphans();
    await t.running("turn-1", "queued");
    expect(await t.relay.cancelTurn(target.tenantId, "turn-1")).toBe(
      "cancelled",
    );
    expect(t.statusOf("turn-1")).toBe("cancelled");
    // Nothing on the device to stop.
    expect(cancels(t.down)).toEqual([]);
    expect(t.closed).toEqual([
      {
        turnId: "turn-1",
        runRef: "card-turn-1",
        followed: false,
        status: "cancelled",
      },
    ]);
    // It is not started on the next heartbeat.
    await t.relay.resumeQueued(target);
    expect(t.started).toEqual([]);
    expect(await t.relay.cancelTurn(target.tenantId, "turn-1")).toBe("over");
    expect(await t.relay.cancelTurn(target.tenantId, "no-such-turn")).toBe(
      "missing",
    );
    expect(await t.relay.cancelTurn("tenant-b", "turn-1")).toBe("missing");
  });

  test("cancelTurn: a running turn is cancelled on the device and its run told at once", async () => {
    const t = orphans();
    await t.running("turn-1");
    const run: Frame[] = [];
    t.relay.subscribe("turn-1", (frame) => run.push(frame), { run: true });
    expect(await t.relay.cancelTurn(target.tenantId, "turn-1")).toBe(
      "cancelled",
    );
    expect(cancels(t.down)).toEqual([
      {
        type: "acp.cancel",
        agentId: "agent-1",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    ]);
    expect(run).toEqual([
      {
        type: "acp.turn.end",
        agentId: "agent-1",
        threadId: "thread-1",
        turnId: "turn-1",
        stopReason: "cancelled",
      },
    ]);
    expect(t.statusOf("turn-1")).toBe("cancelled");
    // Its approvals expire; its card is its run's to close.
    expect(t.closed).toEqual([
      {
        turnId: "turn-1",
        runRef: "card-turn-1",
        followed: true,
        status: "cancelled",
      },
    ]);
    // The device's own end, when it comes, changes nothing.
    t.relay.fromRunner(t.from(), end("turn-1", { stopReason: "cancelled" }));
    expect(await t.settle()).toBeTrue();
    expect(run).toHaveLength(1);
  });

  test("a job past its deadline fails the drain and the device's chain goes on", async () => {
    const t = orphans("none", 50);
    await t.running("turn-1");
    await t.running("turn-2");
    const stuck = t.turns.get.bind(t.turns);
    let hang = true;
    t.turns.get = (tenantId, turnId) =>
      hang && turnId === "turn-1"
        ? new Promise(() => undefined)
        : stuck(tenantId, turnId);
    const two = t.heard("turn-2");
    t.relay.fromRunner(t.from(), update("turn-1", 1));
    t.relay.fromRunner(t.from(), update("turn-2", 1));
    // The stuck query does not hold the device: the drain answers, false (send it again).
    expect(await t.settle()).toBeFalse();
    expect(seqs(two)).toEqual([1]);
    expect(t.logs.some((line) => line.includes("given up on"))).toBeTrue();
    // Once the database answers again, the replay is taken in.
    hang = false;
    const one = t.heard("turn-1");
    t.relay.fromRunner(t.from(), update("turn-1", 1));
    expect(await t.settle()).toBeTrue();
    expect(seqs(one)).toEqual([1]);
  });
});
