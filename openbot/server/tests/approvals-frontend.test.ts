import { expect, test } from "bun:test";
import { EventType, HttpAgent } from "@ag-ui/client";
import {
  frontendApprovalSnapshot,
  observeApprovalAgent,
} from "../../app/src/lib/copilot/approval-context";
import { DECLINED_BY_PERSON as DRAWN_AS_DECLINED } from "../../app/src/lib/plugins/tool-result";
import { DECLINED_BY_PERSON } from "../src/approvals/service";
import { parseApprovalContinuation } from "../src/approvals/types";

test("the real frontend AG-UI agent supplies canonical call identity, original context and live state for a pending change", async () => {
  const agent = new HttpAgent({
    agentId: "bot",
    threadId: "thread",
    initialState: { orderId: 42 },
    fetch: async (_url, init) => {
      const input = JSON.parse(String(init.body));
      const events = [
        {
          type: EventType.RUN_STARTED,
          runId: input.runId,
          threadId: input.threadId,
        },
        {
          type: EventType.STATE_SNAPSHOT,
          snapshot: { orderId: 42, readyToSave: true },
        },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "save-call",
          toolCallName: "computer_write_file",
          parentMessageId: "save-message",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "save-call",
          delta: '{"path":"report.txt","contents":"private"}',
        },
        { type: EventType.TOOL_CALL_END, toolCallId: "save-call" },
        {
          type: EventType.RUN_FINISHED,
          runId: input.runId,
          threadId: input.threadId,
        },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    url: "https://agent.example/ag-ui",
  });
  const cleanup = observeApprovalAgent(agent);
  await agent.runAgent({
    runId: "canonical-run",
    tools: [],
    context: [{ description: "Current project", value: "42" }],
    forwardedProps: { selectedProject: 42 },
  });
  const message = agent.messages.find(
    (message) => message.role === "assistant" && message.toolCalls?.length,
  );
  if (message?.role !== "assistant" || !message.toolCalls?.[0])
    throw new Error("missing tool call");
  const snapshot = parseApprovalContinuation(
    frontendApprovalSnapshot({ agent, toolCall: message.toolCalls[0] }),
  );
  expect(snapshot).toMatchObject({
    runId: "canonical-run",
    threadId: "thread",
    toolCallId: "save-call",
    toolName: "computer_write_file",
    args: { path: "report.txt", contents: "private" },
    state: { orderId: 42, readyToSave: true },
    context: [{ description: "Current project", value: "42" }],
    forwardedProps: { selectedProject: 42 },
  });
  expect(snapshot.messages).toEqual(agent.messages);
  cleanup();
  expect(() =>
    frontendApprovalSnapshot({ agent, toolCall: message.toolCalls[0] }),
  ).toThrow("active conversation");
});

/*
 * 主人拒绝一步时审批服务答给 Bot 的那句话，前端照原文认出来画成「已拒绝」。两端各声明一份，
 * 和 REFUSAL_MARKER 一样；这里保证两份一字不差，改了一边另一边就会失败。
 */
test("the transcript recognises exactly the sentence the approval service answers a declined step with", () => {
  expect(DRAWN_AS_DECLINED).toBe(DECLINED_BY_PERSON);
});
