import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

/**
 * 对话里用户消息下方的「来自微信」小字（计划 2026-11-16-im-channels-wechat Task 10）。
 * 服务器把微信来的那条用户消息 ID 记成 `delivery:wechat:<runId>`；网页上发的、别的渠道来的不显示。
 */
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const user = (id: string, content: string): Message => ({
  id,
  role: "user",
  content,
});

test("微信来的用户消息下方有「来自微信」，文字原样", () => {
  const { getByText, getAllByText } = render(
    <ChatTranscript
      messages={[user("delivery:wechat:run-1", "明天几点开会")]}
    />,
  );
  expect(getByText("明天几点开会")).toBeTruthy();
  expect(getAllByText("来自微信")).toHaveLength(1);
});

test("网页上发的消息不显示", () => {
  const { getByText, queryByText } = render(
    <ChatTranscript messages={[user("web-1", "你好")]} />,
  );
  expect(getByText("你好")).toBeTruthy();
  expect(queryByText("来自微信")).toBeNull();
});

test("别的渠道（Slack、短信）来的不显示「来自微信」", () => {
  const { queryByText } = render(
    <ChatTranscript
      messages={[user("delivery:run-2", "from slack"), user("sms-1", "hi")]}
    />,
  );
  expect(queryByText("来自微信")).toBeNull();
});

test("助手的回复不显示，只有微信来的那条用户消息显示", () => {
  const { getAllByText } = render(
    <ChatTranscript
      messages={[
        user("delivery:wechat:run-3", "帮我查一下"),
        { id: "delivery:wechat:reply", role: "assistant", content: "好的" },
        user("web-2", "谢谢"),
      ]}
    />,
  );
  expect(getAllByText("来自微信")).toHaveLength(1);
});
