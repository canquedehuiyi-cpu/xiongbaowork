import { describe, expect, test } from "bun:test";
import { createAcpRelay } from "../src/agents/acp/relay";
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

function setup(options: { startFails?: boolean } = {}) {
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
    if (status) await turns.setStatus(turnId, status);
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
    settle: () => relay.drain(target),
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

  test("drain says false when a frame could not be taken in", async () => {
    const { relay, turn, from, turns } = setup();
    await turn("turn-1", {}, "running");
    turns.get = async () => {
      throw new Error("database away");
    };
    relay.fromRunner(from(), update("turn-1", 1));
    expect(await relay.drain(target)).toBeFalse();
    // Said once: the next drain starts clean.
    expect(await relay.drain(target)).toBeTrue();
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
