import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

/*
 * A long conversation mounts only its newest page of rows, so the full intro (above the earliest
 * page) is not in the DOM. The compact bar must still be shown then: it is the only place the
 * employee is named at the top.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function conversation(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
  })) as Message[];
}

test("with earlier pages unmounted, the compact bar is shown and the full intro is not drawn", () => {
  const calls: boolean[] = [];
  const view = render(
    <ChatTranscript
      intro={<div data-testid="full-intro">full intro</div>}
      introBar={(away) => {
        calls.push(away);
        return <div data-testid="intro-bar" data-visible={away} />;
      }}
      messages={conversation(40)}
      restoring={false}
    />,
  );
  expect(calls[0]).toBe(true);
  expect(calls).not.toContain(false);
  expect(view.getByTestId("intro-bar").getAttribute("data-visible")).toBe(
    "true",
  );
  expect(view.queryByTestId("full-intro")).toBeNull();
});

test("a short conversation draws the full intro and keeps the bar hidden until it scrolls away", () => {
  const view = render(
    <ChatTranscript
      intro={<div data-testid="full-intro">full intro</div>}
      introBar={(away) => <div data-testid="intro-bar" data-visible={away} />}
      messages={conversation(4)}
      restoring={false}
    />,
  );
  expect(view.getByTestId("full-intro")).toBeTruthy();
});
