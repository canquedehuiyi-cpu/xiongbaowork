import { expect, test } from "bun:test";
import type { StoredMessage, Streamed } from "../chat-client";
import {
  afterRound,
  artifactDirName,
  conversationWith,
  finishedCheck,
  limitStops,
  logFileName,
  noticeCheck,
  officeCardCheck,
  parseEvalPath,
  RUNNER_LABEL,
  replayChecks,
  resultFileName,
  roundState,
  runnerLabel,
  transcriptChecks,
} from "./chat-path";

const names = (checks: { name: string; ok: boolean }[]) =>
  checks.filter((item) => !item.ok).map((item) => item.name);

test("the execution path defaults to board and refuses a name it does not know", () => {
  expect(parseEvalPath(undefined)).toBe("board");
  expect(parseEvalPath("")).toBe("board");
  expect(parseEvalPath(" chat ")).toBe("chat");
  expect(parseEvalPath("board")).toBe("board");
  expect(() => parseEvalPath("dispatch")).toThrow("dispatch");
});

test("each path writes its own result file, artifact folder and logs; the board names are unchanged", () => {
  expect(resultFileName("tasks", "board")).toBe("xiongbao.json");
  expect(resultFileName("smoke", "board")).toBe("smoke.json");
  expect(resultFileName("tasks", "chat")).toBe("xiongbao-chat.json");
  expect(resultFileName("smoke", "chat")).toBe("smoke-chat.json");
  expect(artifactDirName("tasks", "board")).toBe("xiongbao");
  expect(artifactDirName("smoke", "board")).toBe("smoke");
  expect(artifactDirName("tasks", "chat")).toBe("xiongbao-chat");
  expect(artifactDirName("smoke", "chat")).toBe("smoke-chat");
  expect(logFileName("server", "board")).toBe("server.log");
  expect(logFileName("computer", "chat")).toBe("computer-chat.log");
  expect(runnerLabel("board", ["board"])).toBe(RUNNER_LABEL.board);
  expect(runnerLabel("chat", ["chat"])).toBe(RUNNER_LABEL.chat);
  // A board smoke run that carries the chat-only background scenarios says so.
  expect(runnerLabel("board", [undefined, "chat"])).toContain(
    RUNNER_LABEL.chat,
  );
});

test("a round's end is read from the stream: finished, failed, at a limit, waiting, cut off by a restart", () => {
  const finished = [{ type: "RUN_STARTED" }, { type: "RUN_FINISHED" }];
  expect(roundState(finished)).toEqual({
    ended: true,
    failed: false,
    limited: false,
    waiting: false,
    interrupted: false,
  });
  expect(roundState([{ type: "RUN_STARTED" }]).ended).toBe(false);
  expect(roundState([{ type: "RUN_ERROR" }])).toMatchObject({
    ended: true,
    failed: true,
  });
  const limited = [
    { type: "CUSTOM", name: "turn-limit", value: { reason: "time" } },
    { type: "RUN_FINISHED" },
  ];
  expect(roundState(limited).limited).toBe(true);
  expect(
    roundState([
      { type: "CUSTOM", name: "step-limit" },
      { type: "RUN_FINISHED" },
    ]).limited,
  ).toBe(true);
  expect(
    roundState([
      { type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [] } },
    ]).waiting,
  ).toBe(true);
  expect(
    roundState([
      { type: "CUSTOM", name: "turn-interrupted" },
      { type: "RUN_FINISHED" },
    ]).interrupted,
  ).toBe(true);
  expect(limitStops(finished)).toBe(0);
  expect(limitStops([...limited, ...limited])).toBe(2);
});

test("after a round the chat path nudges by the board path's rules: done, stop near the clock, otherwise nudge", () => {
  const clear = { failed: false, limited: false };
  expect(
    afterRound({ state: clear, outputsReady: true, msLeft: 600_000 }),
  ).toEqual({ action: "done", timedOut: false });
  expect(
    afterRound({ state: clear, outputsReady: false, msLeft: 600_000 }),
  ).toEqual({ action: "nudge", timedOut: false });
  // The outputs are there but the round failed or stopped at a limit: ask again.
  expect(
    afterRound({
      state: { failed: true, limited: false },
      outputsReady: true,
      msLeft: 600_000,
    }).action,
  ).toBe("nudge");
  expect(
    afterRound({
      state: { failed: false, limited: true },
      outputsReady: true,
      msLeft: 600_000,
    }).action,
  ).toBe("nudge");
  // Under 30 s of clock left: stop; a missing output then counts as a timeout.
  expect(
    afterRound({ state: clear, outputsReady: false, msLeft: 29_000 }),
  ).toEqual({ action: "stop", timedOut: true });
  expect(
    afterRound({
      state: { failed: true, limited: false },
      outputsReady: true,
      msLeft: 29_000,
    }),
  ).toEqual({ action: "stop", timedOut: false });
});

test("the next request carries the whole stored conversation, its tool calls in the shape the run endpoint takes", () => {
  const stored: StoredMessage[] = [
    { id: "u1", role: "user", content: "做题" },
    {
      id: "a1",
      role: "assistant",
      toolCalls: [{ id: "c1", name: "computer_run_command", args: '{"x":1}' }],
    },
    { id: "t1", role: "tool", content: "ok", toolCallId: "c1" },
    {
      id: "a2",
      role: "assistant",
      toolCalls: [
        { id: "c2", function: { name: "update_plan", arguments: "{}" } },
      ],
    },
    { id: "a3", role: "assistant", content: "做完了" },
  ];
  const next = conversationWith(stored, "继续", "u2");
  expect(next).toHaveLength(6);
  expect(next.at(-1)).toEqual({ id: "u2", role: "user", content: "继续" });
  expect(next[1]).toMatchObject({
    toolCalls: [
      {
        id: "c1",
        type: "function",
        function: { name: "computer_run_command", arguments: '{"x":1}' },
      },
    ],
  });
  expect(next[3]).toMatchObject({
    toolCalls: [
      {
        id: "c2",
        type: "function",
        function: { name: "update_plan", arguments: "{}" },
      },
    ],
  });
  expect(next[2]).toEqual(stored[2]);
  // The first round has no history.
  expect(conversationWith([], "做题", "u1")).toEqual([
    { id: "u1", role: "user", content: "做题" },
  ]);
});

test("the office task's board card is checked on the board path and not applicable on the chat path", () => {
  const missing = { delivered: false, detail: "没有这位员工的卡" };
  const board = officeCardCheck("board", missing);
  expect(board.ok).toBe(false);
  expect(board.name).toContain("看板路径");
  expect(officeCardCheck("board", { delivered: true, detail: "x" }).ok).toBe(
    true,
  );
  // On the chat path there is no card: it is marked not applicable and is never a failure.
  const chat = officeCardCheck("chat", missing);
  expect(chat.ok).toBe(true);
  expect(chat.name).toContain("不适用");
  expect(chat.detail).toContain("不适用");
});

const call = (id: string, name = "computer_run_command") => ({
  id,
  name,
  args: "{}",
});

test("the thread must hold every call with its result, none that was not run, and more calls than the client saw", () => {
  const whole: StoredMessage[] = [
    { role: "user", content: "做题" },
    { role: "assistant", toolCalls: [call("c1"), call("c2")] },
    { role: "tool", toolCallId: "c1", content: "ok" },
    { role: "tool", toolCallId: "c2", content: "ok" },
    { role: "assistant", toolCalls: [call("c3")] },
    { role: "tool", toolCallId: "c3", content: "ok" },
    { role: "assistant", content: "做完了" },
  ];
  expect(names(transcriptChecks(whole, 1))).toEqual([]);

  const missingResult = whole.filter((message) => message.toolCallId !== "c3");
  expect(names(transcriptChecks(missingResult, 1))).toEqual([
    "线程里每个工具调用都有结果",
  ]);

  const notRun = whole.map((message) =>
    message.toolCallId === "c2"
      ? { ...message, content: "本轮时间已到，这一步没有执行。" }
      : message,
  );
  expect(names(transcriptChecks(notRun, 1))).toEqual([
    "没有哪条结果写着「没有执行」",
  ]);

  // The client saw all three calls before it left: nothing happened after it went away.
  expect(names(transcriptChecks(whole, 3))).toEqual([
    "断开之后这一轮又调用了工具",
  ]);
  // An empty thread has no calls at all.
  expect(
    names(transcriptChecks([{ role: "user", content: "x" }], 0)),
  ).toContain("线程里每个工具调用都有结果");
});

test("a turn ended as finished only if liveness, the finish event and the absence of flaws all say so", () => {
  const done = [{ type: "RUN_STARTED" }, { type: "RUN_FINISHED" }];
  expect(finishedCheck("finished", done).ok).toBe(true);
  expect(finishedCheck("running", done)).toMatchObject({ ok: false });
  expect(finishedCheck("interrupted", done).ok).toBe(false);
  expect(finishedCheck(undefined, done).detail).toContain("无");
  expect(finishedCheck("finished", [{ type: "RUN_STARTED" }]).ok).toBe(false);
  expect(
    finishedCheck("finished", [{ type: "RUN_ERROR" }, { type: "RUN_FINISHED" }])
      .detail,
  ).toContain("出错");
  expect(
    finishedCheck("finished", [
      { type: "CUSTOM", name: "turn-limit" },
      { type: "RUN_FINISHED" },
    ]).detail,
  ).toContain("停在上限");
  expect(
    finishedCheck("finished", [
      { type: "RUN_FINISHED", outcome: { type: "interrupt" } },
    ]).detail,
  ).toContain("在等人");
});

test("the completion notice is the outbox row filed for this run's turn end", () => {
  const row = (dedupeKey: string, kind = "reply", state = "failed") => ({
    dedupeKey,
    kind,
    state,
  });
  const found = noticeCheck(
    [row("reply:turn-end:run-1:device:phone-1")],
    ["run-1"],
  );
  expect(found.ok).toBe(true);
  expect(found.detail).toContain("1 条");
  // Another run's notice, another kind of row, or a look-alike key is not this turn's notice.
  expect(
    noticeCheck([row("reply:turn-end:run-2:device:phone-1")], ["run-1"]).ok,
  ).toBe(false);
  expect(
    noticeCheck(
      [row("approval:turn-end:run-1:device:p", "approval")],
      ["run-1"],
    ).ok,
  ).toBe(false);
  expect(
    noticeCheck([row("reply:turn-end:run-10:device:p")], ["run-1"]).ok,
  ).toBe(false);
  expect(noticeCheck([], ["run-1"]).ok).toBe(false);
  // A thread with several runs: any of them counts.
  expect(
    noticeCheck(
      [row("reply:turn-end:run-b:binding:wechat")],
      ["run-a", "run-b"],
    ).ok,
  ).toBe(true);
});

const start = (id: string): Streamed => ({
  type: "TOOL_CALL_START",
  toolCallId: id,
  toolCallName: "computer_run_command",
});
const result = (id: string, content: string): Streamed => ({
  type: "TOOL_CALL_RESULT",
  toolCallId: id,
  content,
});
const said = (delta: string): Streamed => ({
  type: "TEXT_MESSAGE_CONTENT",
  messageId: "m",
  delta,
});

test("a reconnect passes when it gets later events to the end and they match the replay", () => {
  const stream = [
    { type: "RUN_STARTED" },
    start("c1"),
    result("c1", "a"),
    start("c2"),
    result("c2", "b"),
    said("做完"),
    said("了"),
    { type: "RUN_FINISHED" },
  ] as Streamed[];
  // The replay may chunk the text differently; the words are what must agree.
  const replay = [
    { type: "RUN_STARTED" },
    start("c1"),
    result("c1", "a"),
    start("c2"),
    result("c2", "b"),
    said("做完了"),
    { type: "RUN_FINISHED" },
  ] as Streamed[];
  const base = { joined: stream, replay, seenBeforeHangUp: 1 };
  expect(names(replayChecks({ ...base, runningAtReconnect: true }))).toEqual(
    [],
  );

  expect(names(replayChecks({ ...base, runningAtReconnect: false }))).toEqual([
    "重连时这一轮还在跑",
  ]);
  // Nothing new after the hang-up.
  expect(
    names(
      replayChecks({ ...base, seenBeforeHangUp: 2, runningAtReconnect: true }),
    ),
  ).toEqual(["重连后收到后续事件"]);
  // The stream broke before the run ended.
  expect(
    names(
      replayChecks({
        ...base,
        joined: stream.slice(0, 5),
        replay: stream.slice(0, 5),
        runningAtReconnect: true,
      }),
    ),
  ).toEqual(["重连的流以运行结束收尾"]);
  // The replay disagrees on a result, on a call, on the answer.
  const changed = (event: Streamed, index: number) =>
    replay.map((item, at) => (at === index ? event : item));
  expect(
    names(
      replayChecks({
        ...base,
        replay: changed(result("c2", "different"), 4),
        runningAtReconnect: true,
      }),
    ),
  ).toEqual(["重连拿到的结果与结束后回放一致"]);
  expect(
    names(
      replayChecks({
        ...base,
        replay: changed(start("c9"), 3),
        runningAtReconnect: true,
      }),
    ),
  ).toEqual(["重连拿到的调用与结束后回放一致"]);
  expect(
    names(
      replayChecks({
        ...base,
        replay: changed(said("另一句话"), 5),
        runningAtReconnect: true,
      }),
    ),
  ).toEqual(["重连拿到的回答与结束后回放一致"]);
  // An error in the stream is not a run that ended well.
  expect(
    names(
      replayChecks({
        ...base,
        joined: [...stream.slice(0, 5), { type: "RUN_ERROR" }],
        replay: stream.slice(0, 5),
        runningAtReconnect: true,
      }),
    ),
  ).toContain("重连的流以运行结束收尾");
});
