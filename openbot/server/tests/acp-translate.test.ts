import { describe, expect, test } from "bun:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import {
  createAcpTranslator,
  diffCounts,
  translateUpdate,
} from "../src/agents/acp/translate";

/*
 * 外部员工的 `session/update` → 线程事件（translate.ts）。
 */

type Loose = BaseEvent & Record<string, unknown>;
const types = (events: BaseEvent[]) => events.map((event) => event.type);
const chunk = (text: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

describe("translateUpdate", () => {
  test("message chunks become one text message", () => {
    const translator = createAcpTranslator({ idPrefix: "run-1" });
    const events = [
      ...translator.update(chunk("你好，")),
      ...translator.update(chunk("我先看一下")),
      ...translator.update(chunk("代码。")),
      ...translator.close(),
    ] as Loose[];
    expect(types(events)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    const ids = new Set(events.map((event) => event.messageId));
    expect(ids.size).toBe(1);
    expect(events[0]?.role).toBe("assistant");
    expect(
      events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => event.delta)
        .join(""),
    ).toBe("你好，我先看一下代码。");

    // A single update on its own is a whole message.
    expect(types(translateUpdate(chunk("好")))).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    // Empty and non-text chunks say nothing.
    expect(translateUpdate(chunk(""))).toEqual([]);
    expect(
      translateUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "…" },
      }),
    ).toEqual([]);
  });

  test("a tool call between chunks splits the text into two messages", () => {
    const translator = createAcpTranslator({ idPrefix: "run-1" });
    const events = [
      ...translator.update(chunk("先读文件。")),
      ...translator.update({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Read login.ts",
        kind: "read",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "export {}" },
          },
        ],
      }),
      ...translator.update(chunk("找到原因了。")),
      ...translator.close(),
    ] as Loose[];
    expect(types(events)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    const starts = events.filter(
      (event) => event.type === EventType.TEXT_MESSAGE_START,
    );
    expect(starts[0]?.messageId).not.toBe(starts[1]?.messageId);
  });

  test("tool_call kinds map to acp/<kind> tool calls with results", () => {
    const translator = createAcpTranslator({ idPrefix: "run-1" });
    const started = translator.update({
      sessionUpdate: "tool_call",
      toolCallId: "call-7",
      title: "Run bun test",
      kind: "execute",
      status: "pending",
      rawInput: { command: "bun test" },
    }) as Loose[];
    expect(types(started)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ]);
    expect(started[0]?.toolCallId).toBe("run-1:call-7");
    expect(started[0]?.toolCallName).toBe("acp/execute");
    expect(JSON.parse(String(started[1]?.delta))).toMatchObject({
      title: "Run bun test",
      kind: "execute",
      rawInput: { command: "bun test" },
    });

    // In progress: nothing yet. Completed: one result, never a second.
    expect(
      translator.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-7",
        status: "in_progress",
      }),
    ).toEqual([]);
    const done = translator.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-7",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "12 pass" } },
      ],
    }) as Loose[];
    expect(types(done)).toEqual([EventType.TOOL_CALL_RESULT]);
    expect(done[0]?.toolCallId).toBe("run-1:call-7");
    expect(done[0]?.role).toBe("tool");
    expect(String(done[0]?.content)).toContain("12 pass");
    expect(
      translator.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-7",
        status: "completed",
      }),
    ).toEqual([]);

    // A failed call says so; an unknown kind is `other`; an update for a call never seen (the
    // device compacted it) starts it first.
    const failed = translator.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-8",
      title: "Fetch docs",
      kind: "Weird Kind!",
      status: "failed",
    }) as Loose[];
    expect(types(failed)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ]);
    expect(failed[0]?.toolCallName).toBe("acp/other");
    expect(String(failed[3]?.content)).toContain("失败");

    // A call still open when the turn ends gets a result, so nothing is left for a browser to run.
    translator.update({
      sessionUpdate: "tool_call",
      toolCallId: "call-9",
      title: "Search",
      kind: "search",
      status: "in_progress",
    });
    const closed = translator.close() as Loose[];
    expect(types(closed)).toEqual([EventType.TOOL_CALL_RESULT]);
    expect(closed[0]?.toolCallId).toBe("run-1:call-9");
  });

  test("edit diffs are summarised per file with added/removed counts", () => {
    const translator = createAcpTranslator({ idPrefix: "run-2" });
    const events = translator.update({
      sessionUpdate: "tool_call",
      toolCallId: "call-3",
      title: "Edit login.ts",
      kind: "edit",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "src/login.ts",
          oldText: "a\nb\nc\nd\n",
          newText: "a\nB\nc\nd\ne\n",
        },
        {
          type: "diff",
          path: "src/new.ts",
          oldText: null,
          newText: "one\ntwo\nthree",
        },
        {
          type: "diff",
          path: "src/gone.ts",
          oldText: "x\ny",
          newText: "",
        },
      ],
    }) as Loose[];
    const diff = events.find(
      (event) => event.type === EventType.CUSTOM && event.name === "acp.diff",
    );
    expect(diff?.value).toEqual({
      toolCallId: "run-2:call-3",
      files: [
        { path: "src/login.ts", added: 2, removed: 1 },
        { path: "src/new.ts", added: 3, removed: 0 },
        { path: "src/gone.ts", added: 0, removed: 2 },
      ],
    });
    // The result names the files too.
    const result = events.find(
      (event) => event.type === EventType.TOOL_CALL_RESULT,
    );
    expect(String(result?.content)).toContain("src/login.ts");

    expect(diffCounts("same\n", "same\n")).toEqual({ added: 0, removed: 0 });
    expect(diffCounts("a\nb\nc", "c\nb\na")).toEqual({ added: 2, removed: 2 });
  });

  test("a plan becomes an acp.plan custom event", () => {
    const entries = [
      { content: "读代码", priority: "high", status: "completed" },
      { content: "改登录", priority: "high", status: "in_progress" },
    ];
    const events = translateUpdate({
      sessionUpdate: "plan",
      entries,
    }) as Loose[];
    expect(events).toEqual([
      { type: EventType.CUSTOM, name: "acp.plan", value: entries } as Loose,
    ]);
    // Anything else (mode changes, commands, thoughts, garbage) says nothing.
    expect(translateUpdate({ sessionUpdate: "current_mode_update" })).toEqual(
      [],
    );
    expect(translateUpdate(null)).toEqual([]);
    expect(translateUpdate("nope")).toEqual([]);
  });
});
