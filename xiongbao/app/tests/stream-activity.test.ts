import { expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import {
  createStreamActivity,
  opensScreen,
} from "@/lib/computers/stream-activity";

/**
 * 实时画面按流里的工具事件自动弹出（期九·四）：服务器执行电脑工具，页面不再转发，也就没有「转发前报一声」，
 * 改听 `computer_*` 工具开始的事件。回放不报，被拒绝的收回，不上屏的（文件、命令）不报。
 */

function recorder() {
  const told: string[] = [];
  let announcement = 0;
  return {
    told,
    announcer: {
      announce: (botId: string) => {
        told.push(`announce ${botId}`);
        return ++announcement;
      },
      withdraw: (botId: string, which: number) => {
        told.push(`withdraw ${botId} ${which}`);
      },
    },
  };
}

const start = (id: string, name: string) => ({
  type: EventType.TOOL_CALL_START,
  toolCallId: id,
  toolCallName: name,
});
const result = (id: string, content: unknown) => ({
  type: EventType.TOOL_CALL_RESULT,
  toolCallId: id,
  content: JSON.stringify(content),
});

test("a computer tool that works the screen opens it, and a file or a command does not", () => {
  for (const name of [
    "computer_navigate",
    "computer_click",
    "computer_type",
    "computer_key",
    "computer_scroll",
    "computer_snapshot",
    "computer_read",
    "computer_request_help",
    "computer_request_secret",
  ])
    expect(opensScreen(name)).toBe(true);
  for (const name of [
    "computer_list_files",
    "computer_read_file",
    "computer_write_file",
    "computer_edit_file",
    "computer_grep",
    "computer_glob",
    "computer_run_command",
  ])
    expect(opensScreen(name)).toBe(false);
  // Not the computer's at all.
  expect(opensScreen("update_plan")).toBe(false);
  expect(opensScreen("report_refusal")).toBe(false);
  expect(opensScreen(undefined)).toBe(false);
});

test("a screen tool starting in the live stream announces the Bot's computer, once per call", () => {
  const { told, announcer } = recorder();
  const activity = createStreamActivity("bot-1", announcer, true);
  activity.feed(start("c1", "computer_navigate"));
  activity.feed(start("c2", "computer_click"));
  expect(told).toEqual(["announce bot-1", "announce bot-1"]);
});

test("what happens on the computer and not on its screen announces nothing", () => {
  const { told, announcer } = recorder();
  const activity = createStreamActivity("bot-1", announcer, true);
  activity.feed(start("c1", "computer_run_command"));
  activity.feed(start("c2", "computer_write_file"));
  activity.feed(start("c3", "message_bot"));
  expect(told).toEqual([]);
});

test("a call the server refused is taken back, since it never touched the screen", () => {
  const { told, announcer } = recorder();
  const activity = createStreamActivity("bot-1", announcer, true);
  activity.feed(start("c1", "computer_click"));
  activity.feed(result("c1", { ok: false, refused: true, reason: "no" }));
  expect(told).toEqual(["announce bot-1", "withdraw bot-1 1"]);
  // One that failed for another reason did reach the computer, and keeps the screen it opened.
  activity.feed(start("c2", "computer_click"));
  activity.feed(result("c2", { ok: false, reason: "stale refs" }));
  expect(told).toEqual([
    "announce bot-1",
    "withdraw bot-1 1",
    "announce bot-1",
  ]);
});

test("a replayed history announces nothing, however many screen calls it holds", () => {
  const { told, announcer } = recorder();
  const activity = createStreamActivity("bot-1", announcer);
  for (const id of ["c1", "c2", "c3"]) {
    activity.feed(start(id, "computer_navigate"));
    activity.feed(result(id, { ok: true }));
  }
  // Nor does a replayed refusal take anything back: nothing was announced for it.
  activity.feed(start("c4", "computer_click"));
  activity.feed(result("c4", { ok: false, refused: true }));
  activity.live();
  expect(told).toEqual([]);
  // After the replay a call is a call: announced when it starts.
  activity.feed(start("c5", "computer_click"));
  expect(told).toEqual(["announce bot-1"]);
});

test("a call still open when the replay ends is the turn going on now, so the screen opens once", () => {
  const { told, announcer } = recorder();
  const activity = createStreamActivity("bot-1", announcer);
  activity.feed(start("c1", "computer_navigate"));
  activity.feed(result("c1", { ok: true }));
  activity.feed(start("c2", "computer_click"));
  activity.feed(start("c3", "computer_type"));
  activity.live();
  expect(told).toEqual(["announce bot-1"]);
  // Said once: going live again changes nothing.
  activity.live();
  expect(told).toEqual(["announce bot-1"]);
});

test("a malformed event is ignored", () => {
  const { told, announcer } = recorder();
  const activity = createStreamActivity("bot-1", announcer, true);
  activity.feed({ type: EventType.TOOL_CALL_START });
  activity.feed({
    type: EventType.TOOL_CALL_RESULT,
    toolCallId: "never-started",
    content: "not json",
  });
  expect(told).toEqual([]);
});
