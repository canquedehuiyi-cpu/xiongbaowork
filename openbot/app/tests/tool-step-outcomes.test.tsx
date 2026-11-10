import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

test("a refused line names what was tried, not what was done", () => {
  const text = render(
    <ToolLine attempted="执行命令" label="执行了命令" refused />,
  ).container.textContent;
  expect(text).toContain("已拦截：执行命令");
  // 「执行了命令」说的是命令已经执行了，被拦截时正好相反。
  expect(text).not.toContain("执行了命令");
});

test("a line that was not refused keeps its done label", () => {
  const text = render(<ToolLine attempted="执行命令" label="执行了命令" />)
    .container.textContent;
  expect(text).toContain("执行了命令");
  const failed = render(
    <ToolLine attempted="保存文件" failed label="保存了文件" />,
  ).container.textContent;
  expect(failed).toContain("保存了文件，没有成功");
});

test("a refused line with no blocked label falls back to its label", () => {
  const text = render(<ToolLine label="Create note" refused />).container
    .textContent;
  expect(text).toContain("已拦截：Create note");
});

/*
 * 电脑工具的每一处标签都是完成式（「读取了页面」），被拦截时要换成未完成式。逐处对照评审给出的表；
 * 新加一处标签而没给未完成式，这条测试就会失败。
 */
test("every computer step names, for a blocked line, what it tried", () => {
  const source = readFileSync(
    new URL("../src/lib/copilot/computer-tools.tsx", import.meta.url),
    "utf8",
  );
  const expected: Record<string, string> = {
    读取了页面: "读取页面",
    填写了: "填写",
    点击了: "点击",
    按下了: "按键",
    列出了文件: "列出文件",
    读取了文件: "读取文件",
    // 执行命令不在这张表里：computer_run_command 画成终端块（terminal-block.tsx），拦下时由状态徽标「已拦下」说。
    保存了文件: "保存文件",
    追加到文件: "追加到文件",
    滚动了: "滚动",
    查看了本机应用: "查看本机应用",
    调用了本机应用: "调用本机应用",
    启用了本机应用: "启用本机应用",
    查看了桌面窗口: "查看桌面窗口",
    读取了桌面窗口: "读取桌面窗口",
  };
  const done = [...source.matchAll(/"([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((text) => text in expected);
  expect(new Set(done)).toEqual(new Set(Object.keys(expected)));
  for (const [label, blocked] of Object.entries(expected)) {
    // Each done label sits beside its blocked label at the call site.
    const at = source.indexOf(`"${label}"`);
    const near = source.slice(Math.max(0, at - 200), at + 200);
    expect(near).toContain(`"${blocked}"`);
    expect(near).toContain("attempted");
  }
});

/*
 * 主人在对话卡片上拒绝员工电脑上的一步时，结果带 `declined: true`。电脑工具的每一行都要把它交给
 * ToolLine，不然主人自己的拒绝读成「已拦截」，像是策略拦下的。漏传一处，这条就会失败。
 */
test("every computer step that can be refused also says when the person declined it", () => {
  const source = readFileSync(
    new URL("../src/lib/copilot/computer-tools.tsx", import.meta.url),
    "utf8",
  );
  const refusals = [
    ...source.matchAll(
      /refused=\{(outcomeOf\(result\)|outcome)\.refused === true\}/g,
    ),
  ];
  expect(refusals.length).toBeGreaterThan(0);
  for (const refusal of refusals) {
    const at = refusal.index ?? 0;
    const near = source.slice(Math.max(0, at - 200), at);
    expect(near).toContain(`declined={${refusal[1]}.declined === true}`);
  }
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
  expect(text).toContain("Web search，没有成功");
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

/*
 * 文件夹工具门（`server/src/host-access/tools.ts`）把失败和当场被拒都包成
 * 「That host operation could not be completed: …」。失败读成没有成功；包着的是主人拒绝的那句话时，
 * 读成已拒绝，和异步审批被拒走同一条显示路径。
 */
test("a folder step that could not be completed reads as not having worked", () => {
  const text = line(
    "host_read_file",
    "That host operation could not be completed: ENOENT: no such file",
    JSON.stringify({ grantId: "g", path: "missing.txt" }),
  );
  expect(text).toContain("读取了文件，没有成功");
  expect(text).not.toContain("已拦截");
});

test("a folder step the person declined at once reads as declined, not as the sentence for the Bot", () => {
  const text = line(
    "host_write_file",
    `That host operation could not be completed: ${DECLINED_BY_PERSON}`,
    JSON.stringify({ grantId: "host-grant-1", path: "notes.txt" }),
  );
  expect(text).toContain("已拒绝");
  expect(text).toContain("notes.txt · 你拒绝了这一步。");
  expect(text).not.toContain("没有成功");
  expect(text).not.toContain("Do not try this action");
  expect(text).not.toContain("host-grant-");
});
