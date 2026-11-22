import { expect, test } from "bun:test";
import {
  backgroundOf,
  callTrace,
  concludesRetro,
  fastPathBounceLine,
  type LearnedState,
  learningDiff,
  logTypeCounts,
  logTypeCountsLine,
  RETRO_WAIT_AFTER_SECOND_MS,
  RETRO_WAIT_MS,
  retroLinesOf,
  retroLogLines,
  retroWaitFor,
  turnEnded,
  turnStateLine,
  waitForRetro,
} from "./learning";
import type { Capabilities } from "./metrics";
import { combineRepeat, type EvalRecord, type EvalResults } from "./records";
import { backgroundRows, learningRows, renderReport } from "./report";

const state = (
  skills: Record<string, [string, number]>,
  memories = 0,
): LearnedState => ({
  skills: new Map(
    Object.entries(skills).map(([slug, [title, useCount]]) => [
      slug,
      { title, useCount },
    ]),
  ),
  memories,
});

test("what a run learned is the difference before and after: new skills, new memories, skills whose use count rose", () => {
  const before = state({ "auto-a": ["旧技能", 1], "auto-b": ["没用的", 0] }, 2);
  const after = state(
    {
      "auto-a": ["旧技能", 2],
      "auto-b": ["没用的", 0],
      "auto-c": ["新技能", 0],
    },
    5,
  );
  expect(learningDiff(before, after)).toEqual({
    newSkills: ["新技能"],
    newMemories: 3,
    usedSkills: ["旧技能"],
  });
  expect(learningDiff(before, before)).toEqual({
    newSkills: [],
    newMemories: 0,
    usedSkills: [],
  });
});

const line = (extra: Record<string, unknown>) =>
  JSON.stringify({ type: "retrospect", ...extra });

test("the log lines of a run's retrospective are read out of a noisy server log", () => {
  const log = [
    "listening on :3000",
    line({ runId: "r1", outcome: "skipped", trigger: "steps", steps: 9 }),
    `2026-11-20T10:00:00Z ${line({ runId: "r2", outcome: "saved", trigger: "card_delivered", steps: 12 })}`,
    '{"type":"retrospect","runId":"r3","outcome":',
    JSON.stringify({ type: "retrospect-error", runId: "r2" }),
  ].join("\n");
  expect(retroLinesOf(log, ["r2"])).toEqual([
    { runId: "r2", outcome: "saved", trigger: "card_delivered", steps: 12 },
  ]);
  expect(retroLinesOf(log, ["r3", "r9"])).toEqual([]);
});

test("a retrospective line that rewrote a destructive draft is read, shown, and the report says whether it worked", () => {
  const log = [
    line({
      runId: "r1",
      outcome: "saved",
      trigger: "steps",
      steps: 12,
      rewroteUnsafe: true,
      rewriteCleared: true,
    }),
    line({
      runId: "r2",
      outcome: "held",
      trigger: "steps",
      steps: 12,
      rewroteUnsafe: true,
    }),
  ].join("\n");
  expect(retroLinesOf(log, ["r1"])[0]).toMatchObject({
    rewroteUnsafe: true,
    rewriteCleared: true,
  });
  expect(retroLinesOf(log, ["r2"])[0]?.rewriteCleared).toBeUndefined();
  expect(retroLogLines(log, ["r1"])[0]).toContain(
    "rewroteUnsafe=true rewriteCleared=true",
  );
  const cellOf = (retro: Record<string, unknown>) =>
    learningRows([
      [
        "熊宝",
        side([
          combineRepeat(
            record({
              learning: {
                newSkills: [],
                newMemories: 0,
                usedSkills: [],
                retro: { waitedMs: 1000, ended: "logged", ...retro },
              },
            }),
            record({
              learning: { newSkills: [], newMemories: 0, usedSkills: [] },
            }),
          ),
        ]),
      ],
    ])[0]?.[1];
  expect(
    cellOf({ outcome: "saved", rewroteUnsafe: true, rewriteCleared: true }),
  ).toContain("，改写去掉破坏性命令（成了）");
  expect(cellOf({ outcome: "held", rewroteUnsafe: true })).toContain(
    "，改写去掉破坏性命令（没成）",
  );
  expect(cellOf({ outcome: "saved" })).not.toContain("改写去掉");
});

test("a retrospective line of a failed turn that still handed in is read, and the report says so", () => {
  const log = line({
    runId: "r1",
    outcome: "saved",
    trigger: "card_delivered",
    steps: 8,
    failedButDelivered: true,
  });
  expect(retroLinesOf(log, ["r1"])[0]?.failedButDelivered).toBe(true);
  const cell = learningRows([
    [
      "熊宝",
      side([
        combineRepeat(
          record({
            learning: {
              newSkills: [],
              newMemories: 0,
              usedSkills: [],
              runErrors: [
                "RUN_ERROR：boom（在第 9 个事件，之前最后一个工具调用是 deliver_task）",
              ],
              retro: {
                waitedMs: 1000,
                ended: "logged",
                outcome: "saved",
                failedButDelivered: true,
              },
            },
          }),
          record({
            learning: { newSkills: [], newMemories: 0, usedSkills: [] },
          }),
        ),
      ]),
    ],
  ])[0]?.[1];
  expect(cell).toContain("，这一轮带运行错误但已交付");
  expect(cell).toContain("运行错误：RUN_ERROR：boom（在第 9 个事件");
});

test("the fast-path follow-up on a retrospective line is read, and the report says whether it paid off", () => {
  const log = [
    line({
      runId: "r1",
      outcome: "saved",
      askedFastPath: true,
      gotFastPath: true,
    }),
    line({ runId: "r2", outcome: "saved", askedFastPath: true }),
    line({ runId: "r3", outcome: "saved" }),
  ].join("\n");
  expect(retroLinesOf(log, ["r1"])[0]).toMatchObject({
    askedFastPath: true,
    gotFastPath: true,
  });
  expect(retroLinesOf(log, ["r2"])[0]?.gotFastPath).toBeUndefined();
  expect(retroLinesOf(log, ["r3"])[0]?.askedFastPath).toBeUndefined();
  const cell = (retro: Record<string, unknown>) =>
    learningRows([
      [
        "熊宝",
        side([
          combineRepeat(
            record({
              learning: {
                newSkills: [],
                newMemories: 0,
                usedSkills: [],
                retro: {
                  waitedMs: 1000,
                  ended: "logged",
                  outcome: "saved",
                  ...retro,
                },
              },
            }),
            record({
              learning: { newSkills: [], newMemories: 0, usedSkills: [] },
            }),
          ),
        ]),
      ],
    ])[0]?.[1];
  expect(cell({ askedFastPath: true, gotFastPath: true })).toContain(
    "，追问快路径（补上了）",
  );
  expect(cell({ askedFastPath: true })).toContain("，追问快路径（没补上）");
  expect(cell({})).not.toContain("追问快路径");
});

test("a retrospective that replaced the employee's own skills carries how many", () => {
  const log = line({
    runId: "r1",
    outcome: "saved",
    trigger: "steps",
    steps: 20,
    replaced: ["auto-aaaaaaaaaa", "auto-bbbbbbbbbb"],
  });
  expect(retroLinesOf(log, ["r1"])).toEqual([
    {
      runId: "r1",
      outcome: "saved",
      trigger: "steps",
      steps: 20,
      replaced: 2,
    },
  ]);
  expect(
    retroLinesOf(line({ runId: "r1", outcome: "saved", replaced: [] }), ["r1"]),
  ).toEqual([{ runId: "r1", outcome: "saved" }]);
});

test("a held retrospective carries the reason from its retrospect-held line", () => {
  const log = [
    JSON.stringify({
      type: "retrospect-held",
      runId: "r2",
      reason: "要求访问或外发到网址或域名（rates.fx）",
    }),
    line({
      runId: "r2",
      outcome: "held",
      trigger: "card_delivered",
      steps: 20,
    }),
    JSON.stringify({ type: "retrospect-held", runId: "r9", reason: "别的轮" }),
  ].join("\n");
  expect(retroLinesOf(log, ["r2"])).toEqual([
    {
      runId: "r2",
      outcome: "held",
      trigger: "card_delivered",
      steps: 20,
      heldReason: "要求访问或外发到网址或域名（rates.fx）",
    },
  ]);
});

test("the call trace prints one line per call with sizes and the arguments cut short", () => {
  expect(
    callTrace(
      [
        {
          name: "computer_run_command",
          args: '{"command":"ls\n -la"}',
          result: "a\nb",
        },
        { name: "deliver_task", args: "x".repeat(10) },
      ],
      8,
    ),
  ).toEqual([
    ' 1. computer_run_command [参数 21 字 / 结果 3 字] {"comman…',
    " 2. deliver_task [参数 10 字] xxxxxxxx…",
  ]);
});

test("a refused or bounced call also prints the first 120 characters of its result on one line", () => {
  const bounced = JSON.stringify({
    bounced: true,
    reason: "缺必需项：A".repeat(40),
  });
  const lines = callTrace(
    [
      {
        name: "deliver_task",
        args: "{}",
        result: "[refused] 这件活\n还没接下",
      },
      { name: "deliver_task", args: "{}", result: bounced },
      { name: "deliver_task", args: "{}", result: '{"delivered":true}' },
    ],
    8,
  );
  expect(lines[0]).toBe(
    " 1. deliver_task [参数 2 字 / 结果 18 字] {} → [refused] 这件活 还没接下",
  );
  expect(lines[1]?.endsWith(` → ${bounced.slice(0, 120)}`)).toBe(true);
  expect(lines[2]).toBe(" 3. deliver_task [参数 2 字 / 结果 18 字] {}");
});

test("the server's own refusal marker and an escaped bounced answer are printed too", () => {
  const escaped = JSON.stringify(
    JSON.stringify({ bounced: true, reason: "缺 A" }),
  );
  const lines = callTrace(
    [
      {
        name: "deliver_task",
        args: "{}",
        result: "Refused. 这一轮没有接下的活",
      },
      { name: "deliver_task", args: "{}", result: escaped },
    ],
    8,
  );
  expect(lines[0]?.endsWith(" → Refused. 这一轮没有接下的活")).toBe(true);
  expect(lines[1]?.endsWith(` → ${escaped.slice(0, 120)}`)).toBe(true);
});

function clock() {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
    },
  };
}

test("it waits until the last round's retrospective line shows up", async () => {
  const time = clock();
  let reads = 0;
  const result = await waitForRetro({
    runIds: ["r1", "r2"],
    readLog: () => {
      reads += 1;
      return reads < 4
        ? line({ runId: "r1", outcome: "skipped" })
        : line({
            runId: "r2",
            outcome: "saved",
            trigger: "card_delivered",
            steps: 11,
          });
    },
    skillCount: async () => 0,
    skillsBefore: 0,
    ...time,
  });
  expect(result).toEqual({
    waitedMs: 3000,
    ended: "logged",
    outcome: "saved",
    trigger: "card_delivered",
    steps: 11,
  });
});

test("a new skill in the table also ends the wait", async () => {
  const time = clock();
  const counts = [0, 0, 1];
  const result = await waitForRetro({
    runIds: ["r1"],
    readLog: () => "",
    skillCount: async () => counts.shift() ?? 1,
    skillsBefore: 0,
    ...time,
  });
  expect(result).toEqual({ waitedMs: 2000, ended: "skill" });
});

test("no retrospective in time: it stops at the cap and the second run starts as usual", async () => {
  const time = clock();
  const result = await waitForRetro({
    runIds: ["r1"],
    readLog: () => {
      throw new Error("log unreadable");
    },
    skillCount: async () => {
      throw new Error("db down");
    },
    skillsBefore: 0,
    ...time,
  });
  expect(result).toEqual({ waitedMs: RETRO_WAIT_MS, ended: "timeout" });
  // 用户 2026-11-22 批准：第一次之后等到复盘出结论，最多 600 秒。
  expect(RETRO_WAIT_MS).toBe(600_000);
});

test("only the wait after the first run is 600 s; after the second (and anything else) it stays 270 s", () => {
  expect(RETRO_WAIT_AFTER_SECOND_MS).toBe(270_000);
  expect(retroWaitFor("first")).toBe(600_000);
  expect(retroWaitFor("second")).toBe(270_000);
  expect(retroWaitFor("control")).toBe(270_000);
  expect(retroWaitFor(undefined)).toBe(270_000);
});

test("a retrospective that errored after both model calls timed out is a conclusion on the last round (no waiting out the cap)", async () => {
  const log = [
    `{"type":"retrospect-retry","reason":"timeout","agentId":"a","runId":"r2"}`,
    `{"type":"retrospect-error","error":"TimeoutError","context":{"threadId":"t","runId":"r2"}}`,
    `{"type":"retrospect","outcome":"skipped","trigger":"card_turn","steps":21,"agentId":"a","runId":"r2"}`,
  ].join("\n");
  const result = await waitForRetro({
    runIds: ["r1", "r2"],
    readLog: () => log,
    skillCount: async () => 0,
    skillsBefore: 0,
    maxMs: RETRO_WAIT_MS,
    ...clock(),
  });
  expect(result).toMatchObject({
    ended: "logged",
    waitedMs: 0,
    outcome: "skipped",
    error: "TimeoutError",
  });
  // The same error on an earlier round does not end the wait: the last round's review is still to come.
  const early = await waitForRetro({
    runIds: ["r1", "r2"],
    readLog: () => log.replaceAll("r2", "r1"),
    skillCount: async () => 0,
    skillsBefore: 0,
    maxMs: 5000,
    ...clock(),
  });
  expect(early.ended).toBe("timeout");
  expect(
    concludesRetro(
      { runId: "r2", outcome: "skipped", trigger: "card_turn", error: "X" },
      true,
    ),
  ).toBe(true);
});

const serverLog = [
  "2026-11-22T01:00:00Z info {" +
    `"type":"retrospect-retry","reason":"timeout","agentId":"a","runId":"abcdef0123456789","timestamp":"2026-11-22T01:00:01.000Z"}`,
  `{"type":"retrospect-error","error":"Bearer sk-abcdefghijklmnop failed\\nwith\\ttabs ${"x".repeat(200)}","context":{"threadId":"t","runId":"abcdef0123456789"},"timestamp":"2026-11-22T01:00:02.000Z"}`,
  `{"type":"retrospect","outcome":"skipped","trigger":"card_turn","steps":52,"reason":"failed","cardId":"card-0123456789","askedFastPath":true,"failedButDelivered":true,"retried":true,"skill":"secret-skill-name","instructions":"SECRET BODY","agentId":"a","runId":"abcdef0123456789","timestamp":"2026-11-22T01:00:03.000Z"}`,
  `{"type":"retrospect-held","skill":"secret-skill-name","reason":"url: example.test","runId":"abcdef0123456789"}`,
  `{"type":"retrospect","outcome":"saved","runId":"other-run"}`,
  "not json at all retrospect",
  `{"type":"run-model","agentId":"a","runId":"abcdef0123456789","model":"m"}`,
  `{"type":"run-model","agentId":"a","runId":"abcdef0123456789","model":"m"}`,
  `{"type":"agent-stream-stalled","bot":"a","run":"abcdef0123456789"}`,
  `{"type":"channel-dispatch-error","runId":"other-run"}`,
  `{"type":"task-card-turn-ended-early","runId":"abcdef0123456789","detail":"x"}`,
].join("\n");

test("retroLogLines prints the retrospective lines of the given runs without any content", () => {
  const lines = retroLogLines(serverLog, ["abcdef0123456789"]);
  expect(lines).toHaveLength(4);
  expect(lines[0]).toBe(
    "   retro-log retrospect-retry reason=timeout run=abcdef01 at=2026-11-22T01:00:01.000Z",
  );
  expect(lines[1]).toStartWith(
    "   retro-log retrospect-error run=abcdef01 error=Bearer ***",
  );
  expect(lines[1]).not.toContain("sk-abcdefghijklmnop");
  expect(lines[1]).not.toContain("\n");
  expect(lines[1]?.match(/error=(.*) at=/)?.[1]?.length).toBeLessThanOrEqual(
    120,
  );
  expect(lines[2]).toBe(
    "   retro-log retrospect outcome=skipped trigger=card_turn steps=52 reason=failed retried=true askedFastPath=true failedButDelivered=true cardId=card-012 run=abcdef01 at=2026-11-22T01:00:03.000Z",
  );
  expect(lines[3]).toBe(
    "   retro-log retrospect-held reason=url: example.test run=abcdef01",
  );
  const all = lines.join("\n");
  expect(all).not.toContain("secret-skill-name");
  expect(all).not.toContain("SECRET BODY");
  expect(all).not.toContain("other-run");
  expect(retroLogLines(serverLog, [])).toEqual([]);
});

test("retroLogLines and retroLinesOf carry the failed-turn diagnosis, without any content", () => {
  const log = line({
    runId: "abcdef0123456789",
    outcome: "skipped",
    trigger: "steps",
    steps: 16,
    reason: "failed",
    runError: "stream_stalled",
    deliverSeen: false,
    deliveredRow: false,
    eventCount: 143,
  });
  expect(retroLogLines(log, ["abcdef0123456789"])[0]).toContain(
    "reason=failed runError=stream_stalled deliverSeen=false deliveredRow=false eventCount=143",
  );
  expect(retroLinesOf(log, ["abcdef0123456789"])[0]).toMatchObject({
    runError: "stream_stalled",
    deliverSeen: false,
    deliveredRow: false,
    eventCount: 143,
  });
  // 运行错误的类别和「在交付之后」：只认三个类别值，原文打不出来。
  const kind = line({
    runId: "abcdef0123456789",
    outcome: "saved",
    steps: 9,
    failedButDelivered: true,
    runError: "OPENBOT_HEADLESS_TOOL_ERROR",
    runErrorKind: "ended_early",
    runErrorAfterDelivery: true,
  });
  expect(retroLogLines(kind, ["abcdef0123456789"])[0]).toContain(
    "runError=OPENBOT_HEADLESS_TOOL_ERROR runErrorKind=ended_early runErrorAfterDelivery=true",
  );
  expect(retroLinesOf(kind, ["abcdef0123456789"])[0]).toMatchObject({
    runErrorKind: "ended_early",
    runErrorAfterDelivery: true,
  });
  const odd = line({
    runId: "r2",
    outcome: "saved",
    steps: 9,
    runErrorKind: "provider 529 overloaded secret",
  });
  expect(retroLogLines(odd, ["r2"])[0]).not.toContain("runErrorKind");
  expect(retroLinesOf(odd, ["r2"])[0]).not.toHaveProperty("runErrorKind");
  // 没有这些项的行照旧。
  const plain = line({ runId: "r1", outcome: "saved", steps: 8 });
  expect(retroLogLines(plain, ["r1"])[0]).not.toContain("deliverSeen");
});

test("logTypeCounts counts the other log lines of the given runs by type, whatever field carries the run id", () => {
  const counts = logTypeCounts(serverLog, ["abcdef0123456789"]);
  expect(counts).toEqual({
    "run-model": 2,
    "agent-stream-stalled": 1,
    "task-card-turn-ended-early": 1,
  });
  expect(logTypeCountsLine(counts)).toBe(
    "   server-log lines by run: agent-stream-stalled×1, run-model×2, task-card-turn-ended-early×1",
  );
  expect(logTypeCountsLine({})).toBe("");
  expect(fastPathBounceLine({ "fastpath-check-bounce": 2 })).toBe(
    "   交付前核对：挡回 2 次",
  );
  expect(fastPathBounceLine({ "run-model": 3 })).toBe("");
  expect(logTypeCounts(serverLog, [])).toEqual({});
});

// --- the report ---------------------------------------------------------------------------------

const capabilities: Capabilities = {
  plan: "yes",
  planDone: "yes",
  subagent: "no",
  subagentCount: 0,
  reasoning: "n/a",
  verified: "n/a",
  editTool: "n/a",
  grepTool: "n/a",
  stepLimit: "no",
  autoContinued: "no",
};
const record = (over: Partial<EvalRecord> = {}): EvalRecord => ({
  task: "repeat-first",
  title: "重复任务",
  passed: true,
  wallMs: 40_000,
  timedOut: false,
  steps: 13,
  toolCalls: 12,
  modelCalls: 13,
  tokens: { input: 253_068, output: 4_000, total: 257_068, cachedInput: 0 },
  silentStop: false,
  nudges: 0,
  tools: {},
  capabilities,
  checks: [],
  ...over,
});
const side = (records: EvalRecord[]): EvalResults => ({
  side: "xiongbao",
  suite: "tasks",
  provider: "deepseek",
  model: "m",
  baseUrl: null,
  runner: "x",
  mock: false,
  startedAt: "",
  finishedAt: "",
  records,
  notes: [],
});

test("the repeat report says what was learned between the two runs and what the second run used", () => {
  const repeated = combineRepeat(
    record({
      learning: {
        newSkills: ["动作清单做成汇总表"],
        newMemories: 0,
        usedSkills: [],
        retro: {
          waitedMs: 12_000,
          ended: "logged",
          outcome: "saved",
          trigger: "card_delivered",
          steps: 11,
        },
      },
    }),
    record({
      steps: 8,
      learning: {
        newSkills: [],
        newMemories: 1,
        usedSkills: ["动作清单做成汇总表"],
      },
    }),
  );
  expect(repeated.firstRun?.learning?.newSkills).toEqual([
    "动作清单做成汇总表",
  ]);
  const mine = side([repeated]);
  expect(learningRows([["熊宝", mine]])).toEqual([
    [
      "熊宝",
      "saved（card_delivered / 11 步），等了 12 s",
      "技能 1（「动作清单做成汇总表」） / 记忆 0",
      "「动作清单做成汇总表」",
      "技能 0 / 记忆 1",
    ],
  ]);
  const markdown = renderReport([mine]);
  expect(markdown).toContain("## 重复任务：学没学到");
  expect(markdown).toContain("动作清单做成汇总表");
});

test("a retrospective that never came, and a run that learned nothing, read plainly; a side with no learning has no row", () => {
  const repeated = combineRepeat(
    record({
      learning: {
        newSkills: [],
        newMemories: 0,
        usedSkills: [],
        retro: { waitedMs: 270_000, ended: "timeout" },
      },
    }),
    record({ learning: { newSkills: [], newMemories: 0, usedSkills: [] } }),
  );
  const [row] = learningRows([["熊宝", side([repeated])]]);
  expect(row?.[1]).toBe("等满 270 s，没等到复盘结果");
  expect(row?.[3]).toBe("没有");
  expect(
    learningRows([["Codex", side([combineRepeat(record(), record())])]]),
  ).toEqual([]);
  expect(learningRows([["Codex", undefined]])).toEqual([]);
});

// --- background calls -----------------------------------------------------------------------------

test("background calls are counted apart: how many, how many input tokens, a missing count reads as zero", () => {
  expect(backgroundOf([])).toEqual({ count: 0, inputTokens: 0 });
  expect(
    backgroundOf([
      { inputTokens: 1200 },
      { inputTokens: null },
      { inputTokens: 300 },
    ]),
  ).toEqual({ count: 3, inputTokens: 1500 });
});

test("the report lists background calls and the total with them; two runs of a repeat add up", () => {
  const repeated = combineRepeat(
    record({ backgroundCalls: { count: 1, inputTokens: 2_000 } }),
    record({ backgroundCalls: { count: 1, inputTokens: 1_500 } }),
  );
  expect(repeated.backgroundCalls).toEqual({ count: 2, inputTokens: 3_500 });
  expect(repeated.firstRun?.backgroundCalls).toEqual({
    count: 1,
    inputTokens: 2_000,
  });
  const mine = side([repeated]);
  expect(backgroundRows([["熊宝", mine]])).toEqual([
    [
      "重复任务（多步办公连做两次）（熊宝）",
      "506,136",
      "2 次 / 3,500",
      "509,636",
    ],
  ]);
  expect(backgroundRows([["Codex", side([record()])]])).toEqual([]);
  const markdown = renderReport([mine]);
  expect(markdown).toContain("## 后台调用（复盘、自动抽记忆）");
  expect(markdown).toContain("2 次 / 3,500");
});

// --- waiting for the card's review, not for any line ------------------------------------------

const stepsSkip = (runId: string, extra: Record<string, unknown> = {}) =>
  line({
    runId,
    outcome: "skipped",
    trigger: "steps",
    reason: "steps",
    steps: 14,
    ...extra,
  });

test("the log lines carry the card and why a review was skipped", () => {
  const log = line({
    runId: "r1",
    outcome: "skipped",
    trigger: "card_delivered",
    reason: "steps",
    cardId: "c1",
    steps: 3,
  });
  expect(retroLinesOf(log, ["r1"])).toEqual([
    {
      runId: "r1",
      outcome: "skipped",
      trigger: "card_delivered",
      reason: "steps",
      cardId: "c1",
      steps: 3,
    },
  ]);
});

test("a plain turn skipped for too few steps does not end the wait; the card's review that follows does", async () => {
  const time = clock();
  let reads = 0;
  const result = await waitForRetro({
    runIds: ["r1"],
    readLog: () => {
      reads += 1;
      return reads < 5
        ? stepsSkip("r1")
        : [
            stepsSkip("r1"),
            line({
              runId: "r1",
              outcome: "saved",
              trigger: "card_delivered",
              cardId: "c1",
              steps: 11,
            }),
          ].join("\n");
    },
    skillCount: async () => 0,
    skillsBefore: 0,
    ...time,
  });
  expect(result).toMatchObject({
    ended: "logged",
    outcome: "saved",
    trigger: "card_delivered",
    waitedMs: 4000,
  });
});

test("only plain turns skipped for steps: it waits the whole cap, and says what it last saw", async () => {
  const time = clock();
  const result = await waitForRetro({
    runIds: ["r1", "r2"],
    readLog: () => [stepsSkip("r1"), stepsSkip("r2")].join("\n"),
    skillCount: async () => 0,
    skillsBefore: 0,
    ...time,
  });
  expect(result).toEqual({
    waitedMs: RETRO_WAIT_MS,
    ended: "timeout",
    outcome: "skipped",
    trigger: "steps",
    steps: 14,
    // 跳过的原因也记下（步数不够），报告里说得出为什么没学到。
    reason: "steps",
  });
});

test("a card's review skipped for too few steps in an earlier round does not end the wait either", async () => {
  const time = clock();
  const result = await waitForRetro({
    runIds: ["r1", "r2"],
    readLog: () =>
      [
        stepsSkip("r1", { trigger: "card_delivered", cardId: "c1", steps: 3 }),
        stepsSkip("r2"),
      ].join("\n"),
    skillCount: async () => 0,
    skillsBefore: 0,
    ...time,
  });
  expect(result.ended).toBe("timeout");
});

test("a skip that is not about steps (cooldown, card already reviewed) is a conclusion", async () => {
  for (const extra of [
    { trigger: "card_delivered", cardId: "c1" },
    { trigger: "card_delivered", cardId: "c1", reason: "card_done" },
  ]) {
    const result = await waitForRetro({
      runIds: ["r1", "r2"],
      readLog: () => line({ runId: "r1", outcome: "skipped", ...extra }),
      skillCount: async () => 0,
      skillsBefore: 0,
      ...clock(),
    });
    expect(result).toMatchObject({
      ended: "logged",
      outcome: "skipped",
      waitedMs: 0,
    });
  }
  // The last round of a plain turn skipped without the step reason (cooldown, switched off): also over.
  const last = await waitForRetro({
    runIds: ["r1"],
    readLog: () =>
      line({ runId: "r1", outcome: "skipped", trigger: "steps", steps: 20 }),
    skillCount: async () => 0,
    skillsBefore: 0,
    ...clock(),
  });
  expect(last).toMatchObject({ ended: "logged", waitedMs: 0 });
});

test("a failed earlier round is not the card's review, but a failed last round has nothing more coming", async () => {
  const failedLine = (runId: string) =>
    line({
      runId,
      outcome: "skipped",
      trigger: "steps",
      reason: "failed",
      steps: 4,
    });
  const early = await waitForRetro({
    runIds: ["r1", "r2"],
    readLog: () => failedLine("r1"),
    skillCount: async () => 0,
    skillsBefore: 0,
    ...clock(),
  });
  expect(early.ended).toBe("timeout");
  const last = await waitForRetro({
    runIds: ["r1", "r2"],
    readLog: () => failedLine("r2"),
    skillCount: async () => 0,
    skillsBefore: 0,
    ...clock(),
  });
  expect(last).toMatchObject({ ended: "logged", waitedMs: 0 });
});

test("a review saved in an earlier round ends the wait", async () => {
  const result = await waitForRetro({
    runIds: ["r1", "r2"],
    readLog: () =>
      line({
        runId: "r1",
        outcome: "saved",
        trigger: "card_delivered",
        steps: 8,
      }),
    skillCount: async () => 0,
    skillsBefore: 0,
    ...clock(),
  });
  expect(result).toMatchObject({
    ended: "logged",
    outcome: "saved",
    waitedMs: 0,
  });
});

test("card_turn (a card's round never handed in): too few steps keeps waiting, other skips count only on the last round", async () => {
  const skip = (runId: string, extra: Record<string, unknown>) =>
    line({ runId, outcome: "skipped", trigger: "card_turn", ...extra });
  const wait = (log: string) =>
    waitForRetro({
      runIds: ["r1", "r2"],
      readLog: () => log,
      skillCount: async () => 0,
      skillsBefore: 0,
      ...clock(),
    });
  expect((await wait(skip("r1", { reason: "steps", steps: 4 }))).ended).toBe(
    "timeout",
  );
  // An earlier round skipped for the cooldown: a later round may still hand the card in.
  expect((await wait(skip("r1", {}))).ended).toBe("timeout");
  expect((await wait(skip("r2", {}))).ended).toBe("logged");
  expect(
    concludesRetro(
      { runId: "r1", outcome: "saved", trigger: "card_turn" },
      false,
    ),
  ).toBe(true);
});

test("a review that errored is recorded with the error's type, and says so in place of an outcome only", () => {
  const log = [
    `{"type":"retrospect-error","error":"TypeError","context":{"threadId":"t","runId":"run-e"}}`,
    `{"type":"retrospect","outcome":"skipped","trigger":"steps","steps":35,"agentId":"a","runId":"run-e"}`,
  ].join("\n");
  expect(retroLinesOf(log, ["run-e"])).toEqual([
    {
      outcome: "skipped",
      trigger: "steps",
      steps: 35,
      error: "TypeError",
      runId: "run-e",
    },
  ]);
});

test("logTypeCounts shows a model call that was made again after a dropped connection, by run", () => {
  const log = [
    '{"type":"model-net-retry","runId":"abcdef0123456789","code":"ECONNRESET","step":3,"recovered":true}',
    '{"type":"model-net-retry","runId":"0000000000000000","code":"EPIPE","step":1,"recovered":false}',
  ].join("\n");
  expect(logTypeCounts(log, ["abcdef0123456789"])).toEqual({
    "model-net-retry": 1,
  });
});

const rowOf = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: "retrospect", ...fields });

test("timeout from the server counts as a conclusion on any round, and is not waited on", async () => {
  expect(concludesRetro({ runId: "r1", outcome: "timeout" }, false)).toBe(true);
  expect(concludesRetro({ runId: "r1", outcome: "timeout" }, true)).toBe(true);
  const time = clock();
  const result = await waitForRetro({
    runIds: ["r1"],
    readLog: () =>
      rowOf({
        outcome: "timeout",
        trigger: "card_delivered",
        steps: 9,
        cardId: "c1",
        runId: "r1",
        timestamp: "2026-11-22T01:00:00.000Z",
      }),
    skillCount: async () => 0,
    skillsBefore: 0,
    maxMs: 600_000,
    ...time,
  });
  expect(result).toMatchObject({ ended: "logged", outcome: "timeout" });
  expect(result.waitedMs).toBeLessThan(5000);
});

test("a row of the same card, after the run began, counts even when its run id is not one this run got", () => {
  const log = [
    rowOf({
      outcome: "saved",
      cardId: "c1",
      runId: "later-round",
      timestamp: "2026-11-22T01:10:00.000Z",
      skill: "s",
    }),
    `{"type":"retrospect-held","runId":"later-round","reason":"url: x"}`,
    // an earlier run's row of another card, and the same card before the run began: not this run's
    rowOf({
      outcome: "saved",
      cardId: "c0",
      runId: "old-round",
      timestamp: "2026-11-22T01:10:00.000Z",
    }),
    rowOf({
      outcome: "saved",
      cardId: "c1",
      runId: "older",
      timestamp: "2026-11-22T00:00:00.000Z",
    }),
    rowOf({
      outcome: "nothing",
      runId: "r1",
      timestamp: "2026-11-22T01:05:00.000Z",
    }),
  ].join("\n");
  const claim = {
    cardIds: ["c1"],
    since: Date.parse("2026-11-22T01:00:00.000Z"),
  };
  expect(retroLinesOf(log, ["r1"]).map((line) => line.runId)).toEqual(["r1"]);
  const lines = retroLinesOf(log, ["r1"], claim);
  expect(lines.map((line) => line.runId)).toEqual(["later-round", "r1"]);
  expect(lines[0]).toMatchObject({ outcome: "saved" });
  expect(retroLogLines(log, ["r1"], claim).join("\n")).toContain(
    "run=later-ro",
  );
  expect(retroLogLines(log, ["r1"], claim).join("\n")).not.toContain(
    "old-roun",
  );
  expect(retroLogLines(log, ["r1"], claim).join("\n")).not.toContain(
    "run=older",
  );
  // A later run of the same employee (other cards, later start) does not take this run's late row.
  expect(
    retroLinesOf(log, ["r2"], {
      cardIds: ["c2"],
      since: Date.parse("2026-11-22T01:20:00.000Z"),
    }),
  ).toEqual([]);
  // No timestamp, no claim.
  expect(
    retroLinesOf(
      rowOf({ outcome: "saved", cardId: "c1", runId: "x" }),
      ["r1"],
      claim,
    ),
  ).toEqual([]);
});

test("a late row of the card ends the wait as the last round's", async () => {
  const time = clock();
  const result = await waitForRetro({
    runIds: ["r1"],
    claim: { cardIds: ["c1"], since: 0 },
    // a skipped row with no reason concludes only for the last round: a round the server started later is the last
    readLog: () =>
      rowOf({
        outcome: "skipped",
        trigger: "card_turn",
        cardId: "c1",
        runId: "later",
        timestamp: "2026-11-22T01:00:00.000Z",
      }),
    skillCount: async () => 0,
    skillsBefore: 0,
    maxMs: 600_000,
    ...time,
  });
  expect(result.ended).toBe("logged");
});

test("the wait goes on while a round has not really ended, counts against the cap, and says so when it runs out", async () => {
  const time = clock();
  let asked = 0;
  const concludedLog = rowOf({ outcome: "saved", runId: "r1", cardId: "c1" });
  // The log already has a conclusion and a new skill is there, but the round is still running: not looked at.
  const ending = await waitForRetro({
    runIds: ["r1"],
    readLog: () => concludedLog,
    skillCount: async () => 5,
    skillsBefore: 0,
    turnsEnded: async () => {
      asked += 1;
      return asked > 3;
    },
    maxMs: 600_000,
    everyMs: 1000,
    ...time,
  });
  expect(ending).toMatchObject({ ended: "logged", outcome: "saved" });
  expect(ending.waitedMs).toBe(3000);

  const never = await waitForRetro({
    runIds: ["r1"],
    readLog: () => concludedLog,
    skillCount: async () => 5,
    skillsBefore: 0,
    turnsEnded: async () => false,
    maxMs: 10_000,
    everyMs: 1000,
    ...clock(),
  });
  expect(never).toEqual({
    waitedMs: 10_000,
    ended: "timeout",
    turnRunning: true,
  });

  // A read that fails is taken as ended: the wait is not held up by the evaluation's own trouble.
  const failing = await waitForRetro({
    runIds: ["r1"],
    readLog: () => concludedLog,
    skillCount: async () => 0,
    skillsBefore: 0,
    turnsEnded: async () => {
      throw new Error("db");
    },
    maxMs: 10_000,
    ...clock(),
  });
  expect(failing.ended).toBe("logged");
});

test("a round has ended by its closing event or by a status that is not running; a card leaving 'running' says nothing", () => {
  expect(turnEnded({ terminalEvent: true, status: "running" })).toBe(true);
  expect(turnEnded({ terminalEvent: false, status: "finished" })).toBe(true);
  expect(turnEnded({ terminalEvent: false, status: "interrupted" })).toBe(true);
  expect(turnEnded({ terminalEvent: false, status: "running" })).toBe(false);
  expect(turnEnded({ terminalEvent: false, status: undefined })).toBe(false);
});

test("the line for a wait that ran out says whether the round is still running, how many events, and how long since the last", () => {
  expect(
    turnStateLine({
      runId: "abcdef0123456789",
      reading: { terminalEvent: false, status: "running" },
      eventCount: 412,
      lastEventAt: 1_000_000,
      now: 1_042_400,
    }),
  ).toBe(
    "   turn state at the end of the wait: run=abcdef01 running, status running, events 412, last event 42 s ago",
  );
  expect(
    turnStateLine({
      runId: "r",
      reading: { terminalEvent: true, status: undefined },
      eventCount: 9,
      now: 5,
    }),
  ).toBe(
    "   turn state at the end of the wait: run=r ended, events 9, last event n/a",
  );
});
