import { expect, test } from "bun:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import {
  deliveryProtocol,
  deliveryProtocolGuidance,
} from "../src/tasks/delivery-tools";
import {
  AUTO_DELIVERY_FILE_LIMIT,
  workspaceFilesWritten,
} from "../src/tasks/evidence-gate";

/**
 * 员工做完活没交付时，卡自动进等验收，带上这一轮写过的工作区文件当证据。这里只验「从一轮的事件里读出写过哪些
 * 文件」：成功的 `computer_write_file` / `computer_edit_file` 调用，路径要是工作区内的相对路径。
 */

let counter = 0;

/** One tool call as a run streams it: its start, its arguments, its end and (when it got one) its result. */
function call(
  name: string,
  args: unknown,
  result?: unknown,
  options: { raw?: boolean } = {},
): BaseEvent[] {
  counter += 1;
  const toolCallId = `call-${counter}`;
  const events: Record<string, unknown>[] = [
    { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: name },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: typeof args === "string" ? args : JSON.stringify(args),
    },
    { type: EventType.TOOL_CALL_END, toolCallId },
  ];
  if (result !== undefined)
    events.push({
      type: EventType.TOOL_CALL_RESULT,
      messageId: `result-${counter}`,
      toolCallId,
      role: "tool",
      content: options.raw ? String(result) : JSON.stringify(result),
    });
  return events as unknown as BaseEvent[];
}

const wrote = (path: unknown) =>
  call("computer_write_file", { path, contents: "x" }, { ok: true, path });
const edited = (path: unknown) =>
  call(
    "computer_edit_file",
    { path, old_string: "a", new_string: "b" },
    { ok: true, path, edited: true },
  );

test("a successful write and a successful edit are both written files, in the order they first happened", () => {
  const events = [
    ...wrote("actions.csv"),
    ...edited("drafts/李明.md"),
    ...wrote("drafts/王芳.md"),
  ];
  expect(workspaceFilesWritten(events)).toEqual([
    "actions.csv",
    "drafts/李明.md",
    "drafts/王芳.md",
  ]);
});

test("a call that failed, was refused or never got an answer wrote nothing", () => {
  const events = [
    ...call(
      "computer_write_file",
      { path: "failed.md", contents: "x" },
      { ok: false, error: "disk full" },
    ),
    ...call(
      "computer_edit_file",
      { path: "missing.md", old_string: "a", new_string: "b" },
      { ok: false, path: "missing.md", error: "not found" },
    ),
    ...call(
      "computer_write_file",
      { path: "refused.md", contents: "x" },
      "Refused. a rule of this deployment",
      { raw: true },
    ),
    // Waiting on the person's approval: no result yet.
    ...call("computer_write_file", { path: "waiting.md", contents: "x" }),
    ...wrote("ok.md"),
  ];
  expect(workspaceFilesWritten(events)).toEqual(["ok.md"]);
});

test("reading, listing and running a command are not writing", () => {
  const events = [
    ...call("computer_read_file", { path: "input.md" }, { ok: true }),
    ...call("computer_list_files", { path: "." }, { ok: true }),
    ...call("computer_run_command", { command: "cat a > b.md" }, { ok: true }),
    ...call("deliver_task", { items: [] }, { delivered: true }),
  ];
  expect(workspaceFilesWritten(events)).toEqual([]);
});

test("only paths inside the workspace count: absolute, home, drive and parent paths are left out", () => {
  const events = [
    ...wrote("/etc/passwd"),
    ...wrote("~/notes.md"),
    ...wrote("C:\\Users\\a\\b.md"),
    ...wrote("../outside.md"),
    ...wrote("sub/../../escape.md"),
    ...wrote(""),
    ...wrote("   "),
    ...wrote(42),
    ...wrote("inside/ok.md"),
  ];
  expect(workspaceFilesWritten(events)).toEqual(["inside/ok.md"]);
});

test("a path is read the way the evidence gate reads it, and written once", () => {
  const events = [
    ...wrote("./reports//a.md"),
    ...edited("reports/a.md"),
    ...wrote("reports\\a.md"),
    ...wrote("..notes.md"),
  ];
  expect(workspaceFilesWritten(events)).toEqual(["reports/a.md", "..notes.md"]);
});

test("arguments that are not a JSON object name no file", () => {
  const events = [
    ...call("computer_write_file", "{not json", { ok: true }),
    ...call("computer_write_file", "[]", { ok: true }),
    ...call("computer_write_file", {}, { ok: true }),
    ...wrote("ok.md"),
  ];
  expect(workspaceFilesWritten(events)).toEqual(["ok.md"]);
});

test("a call streamed as one chunk is read too", () => {
  const events = [
    {
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: "chunked",
      toolCallName: "computer_write_file",
      delta: JSON.stringify({ path: "chunked.md", contents: "x" }),
    },
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "r",
      toolCallId: "chunked",
      role: "tool",
      content: JSON.stringify({ ok: true }),
    },
  ] as unknown as BaseEvent[];
  expect(workspaceFilesWritten(events)).toEqual(["chunked.md"]);
});

test("more than the limit are cut, keeping the first ones written", () => {
  const events = Array.from({ length: AUTO_DELIVERY_FILE_LIMIT + 5 }, (_, i) =>
    wrote(`out/${i}.md`),
  ).flat();
  const files = workspaceFilesWritten(events);
  expect(AUTO_DELIVERY_FILE_LIMIT).toBe(20);
  expect(files).toHaveLength(AUTO_DELIVERY_FILE_LIMIT);
  expect(files[0]).toBe("out/0.md");
  expect(files.at(-1)).toBe(`out/${AUTO_DELIVERY_FILE_LIMIT - 1}.md`);
});

test("a file written twice takes one place under the limit", () => {
  const events = [
    ...Array.from({ length: AUTO_DELIVERY_FILE_LIMIT }, (_, i) =>
      wrote(`out/${i}.md`),
    ).flat(),
    ...wrote("out/0.md"),
  ];
  expect(workspaceFilesWritten(events)).toHaveLength(AUTO_DELIVERY_FILE_LIMIT);
});

test("the coworker is told to hand in with deliver_task and to list what it wrote as workspace_file, after the shared rules", () => {
  const text = deliveryProtocolGuidance(["accept_task", "deliver_task"]) ?? "";
  // The shared paragraph and the plain-questions line stay as they are; one sentence is added after them.
  expect(
    text.startsWith(
      `${deliveryProtocol()}\n问一句答一句的普通对话不要用这三个工具`,
    ),
  ).toBe(true);
  expect(text).toContain("deliver_task");
  expect(text).toContain("workspace_file");
  expect(deliveryProtocolGuidance(["deliver_task"])).toBeUndefined();
});
