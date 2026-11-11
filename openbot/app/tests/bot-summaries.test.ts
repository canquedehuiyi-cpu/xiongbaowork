import { expect, test } from "bun:test";
import {
  accessSummary,
  countLabel,
  memorySummary,
  reachSummary,
  setupSummary,
  sharingSummary,
} from "@/lib/agents/bot-summaries";

test("counts read as words", () => {
  expect(countLabel(0, "个定时任务", "个定时任务", "没有定时任务")).toBe(
    "没有定时任务",
  );
  expect(countLabel(1, "个定时任务", "个定时任务", "没有定时任务")).toBe(
    "1 个定时任务",
  );
  expect(countLabel(3, "个定时任务", "个定时任务", "没有定时任务")).toBe(
    "3 个定时任务",
  );
});

test("access names skills and apps, or says there is nothing", () => {
  expect(accessSummary(0, 0)).toBe("还没有授予任何技能或应用");
  expect(accessSummary(2, 0)).toBe("2 个技能");
  expect(accessSummary(0, 1)).toBe("1 个应用");
  expect(accessSummary(1, 3)).toBe("1 个技能、3 个应用");
});

test("sharing names the audience", () => {
  expect(sharingSummary(undefined, "private")).toBe("未共享");
  expect(sharingSummary({ audience: "team" }, "private")).toBe("整个团队");
  expect(sharingSummary({ audience: "people" }, "private")).toBe(
    "指定的人和分组",
  );
});

test("setup names where it runs", () => {
  expect(
    setupSummary({ builtIn: true, endpoint: "http://localhost:4201/ag-ui" }),
  ).toBe("内置");
  expect(
    setupSummary({
      builtIn: false,
      endpoint: "https://bots.example.com/ag-ui",
    }),
  ).toBe("bots.example.com");
  expect(setupSummary({ builtIn: false, endpoint: "not a url" })).toBe(
    "not a url",
  );
  expect(setupSummary({ builtIn: false, endpoint: null })).toBe("内置");
});

/*
 * The personal edition's starter runs on the harness its one person picked at setup, at the address
 * of the container OpenBot started for it ("agent-harness:4206" on Windows). That address means
 * nothing to them; the framework does. A team deployment still shows the address.
 */
test("the personal edition names what runs a Bot instead of its address", () => {
  const harness = {
    builtIn: false,
    endpoint: "http://agent-harness:4206/ag-ui",
    framework: "LangChain",
  };
  expect(setupSummary(harness, "personal")).toBe("运行在 LangChain 上");
  expect(setupSummary(harness, "team")).toBe("agent-harness:4206");
  expect(setupSummary(harness)).toBe("agent-harness:4206");
  // An agent connected by address with no framework named: the address is all there is.
  expect(
    setupSummary(
      { builtIn: false, endpoint: "http://127.0.0.1:8000/ag-ui" },
      "personal",
    ),
  ).toBe("127.0.0.1:8000");
  expect(
    setupSummary(
      { builtIn: true, endpoint: null, framework: "OpenBot" },
      "personal",
    ),
  ).toBe("内置");
});

test("a public Bot nobody published is still open to everyone, not 'Not shared'", () => {
  expect(sharingSummary(undefined, "public")).toBe("所有人（公开）");
});

test("reach names the places a Bot continues the conversation", () => {
  expect(reachSummary([])).toBe("只在熊宝里");
  expect(reachSummary(["slack"])).toBe("Slack");
  expect(reachSummary(["sms", "slack", "slack"])).toBe("Slack、短信");
  expect(reachSummary(["teams"])).toBe("Microsoft Teams");
});

test("memory names the sources and whether check-ins are on", () => {
  expect(memorySummary(0, false)).toBe("还没接入信息源");
  expect(memorySummary(2, false)).toBe("2 个信息源");
  expect(memorySummary(0, true)).toBe("巡检已开");
  expect(memorySummary(1, true)).toBe("1 个信息源、巡检已开");
});
