import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ServerToolLine } from "@/components/channels/chat-transcript";
import { ToolLine } from "@/components/channels/tool-line";
import {
  DECLINED_BY_PERSON,
  UNOFFERED_TOOL_SENTENCE,
} from "@/lib/plugins/tool-result";

/*
 * 一行工具步骤怎么读：成功、失败、被拦截、被主人拒绝、调用了没有的工具，各说各的。
 * 对应上游 #729、#1153、#1230 的判定，文案是本仓库的中文。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

function line(name: string, result?: string, args = "{}") {
  const view = render(
    <ServerToolLine args={args} name={name} result={result} />,
  );
  return view.container.textContent ?? "";
}

test("a refused line keeps what was refused beside the word", () => {
  const text = render(<ToolLine label="执行了命令" refused />).container
    .textContent;
  expect(text).toContain("已拦截：执行了命令");
});

test("a declined line says the person declined it, not that it was blocked", () => {
  const text = render(<ToolLine declined label="写入文件" refused />).container
    .textContent;
  expect(text).toContain("已拒绝：写入文件");
  expect(text).not.toContain("已拦截");
});

test("a vendor error reads as not having worked, not as a result", () => {
  const text = line(
    "mcp__notes__search_notes",
    JSON.stringify("The vendor reported an error:\npermission denied"),
  );
  expect(text).toContain("Search notes，没有成功");
});

test("a call that could not be made reads as not having worked", () => {
  expect(
    line("mcp__notes__search_notes", "That tool could not be called."),
  ).toContain("没有成功");
});

test("an ordinary result reads as done", () => {
  const text = line("mcp__notes__search_notes", "Found 12 results.");
  expect(text).toContain("Search notes");
  expect(text).not.toContain("没有成功");
  expect(text).not.toContain("已拦截");
});

test("a tool the Bot doesn't have reads as one sentence, not the runtime's list", () => {
  const text = line(
    "web_search",
    "Error: Model tried to call unavailable tool 'web_search'. Available tools: computer_navigate, computer_read.",
  );
  expect(text).toContain("web_search，没有成功");
  expect(text).toContain(UNOFFERED_TOOL_SENTENCE);
  expect(text).not.toContain("computer_navigate");
});

test("a folder change the person declined reads as declined, naming the file and not the grant", () => {
  const args = JSON.stringify({
    grantId: "host-grant-15407-1794112361547002000",
    path: "notes.txt",
    content: "FOLDER-EDITED-43",
  });
  const text = line("host_write_file", DECLINED_BY_PERSON, args);
  expect(text).toContain("已拒绝");
  expect(text).toContain("notes.txt · 你拒绝了这一步。");
  expect(text).not.toContain("host-grant-");
  // The sentence written for the Bot is not what the person reads.
  expect(text).not.toContain("Do not try this action");
});

test("a folder command the person declined names the command", () => {
  const args = JSON.stringify({ grantId: "g", command: "wc -c notes.txt" });
  const text = line("host_run_command", DECLINED_BY_PERSON, args);
  expect(text).toContain("已拒绝");
  expect(text).toContain("wc -c notes.txt · 你拒绝了这一步。");
});

test("a connector step declined at once by the plugin door reads as declined too", () => {
  const text = line(
    "mcp__notes__create_note",
    `Refused. ${DECLINED_BY_PERSON}`,
  );
  expect(text).toContain("已拒绝：Create note");
  expect(text).not.toContain("Do not try this action");
});

test("a boundary's refusal still reads as blocked", () => {
  const text = line("mcp__notes__create_note", "Refused. The rule says no.");
  expect(text).toContain("已拦截：Create note");
  expect(text).not.toContain("已拒绝");
});
