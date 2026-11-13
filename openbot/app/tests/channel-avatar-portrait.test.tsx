import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ChannelItemContent } from "@/components/app-sidebar/channel-item-content";
import { ChannelAvatar } from "@/components/channels/avatar";
import { type Portrait, portraitKeys } from "@/lib/portraits/queries";

/*
 * A coworker whose 头像 somebody chose is drawn with it in a conversation's header and in the
 * conversation list, not only in the roster; one without keeps the seed's drawing.
 */

let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register({ url: "http://localhost:3010" });
    registeredHere = true;
  }
});
afterEach(cleanup);
afterAll(() => {
  if (registeredHere) GlobalRegistrator.unregister();
});

const cute: Portrait = {
  kind: "coworker",
  id: "bot-1",
  preset: "cute",
  imageUrl: null,
  videoUrl: null,
  outfit: null,
  updatedAt: "2026-11-08T00:00:00.000Z",
};

function withPortraits(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(portraitKeys.all, [cute]);
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

test("the conversation header's avatar draws the chosen preset image, not the default ball", () => {
  const view = render(
    withPortraits(<ChannelAvatar participantIds={["bot-1"]} size={38} />),
  );
  const image = view.container.querySelector("img[data-portrait]");
  expect(image?.getAttribute("src")).toContain("xiongbao-cute");
  expect(view.container.querySelector("svg")).toBeNull();
});

test("a participant with no chosen face keeps the default drawing", () => {
  const view = render(
    withPortraits(<ChannelAvatar participantIds={["bot-2"]} size={38} />),
  );
  expect(view.container.querySelector("img[data-portrait]")).toBeNull();
  expect(view.container.querySelector("svg")).not.toBeNull();
});

test("a conversation list row draws the chosen preset image", () => {
  const view = render(
    withPortraits(
      <ChannelItemContent
        emphasis="agent"
        name="客服小熊"
        participantIds={["bot-1"]}
        title="今天的工单"
      />,
    ),
  );
  expect(
    view.container.querySelector("img[data-portrait]")?.getAttribute("src"),
  ).toContain("xiongbao-cute");
});

test("a group avatar draws the chosen face for the member who has one", () => {
  const view = render(
    withPortraits(
      <ChannelAvatar participantIds={["bot-1", "bot-2"]} size={32} />,
    ),
  );
  expect(view.container.querySelectorAll("img[data-portrait]").length).toBe(1);
  expect(view.container.querySelectorAll("svg").length).toBe(1);
});

test("without a query client the avatar still draws", () => {
  const view = render(<ChannelAvatar participantIds={["bot-1"]} size={38} />);
  expect(view.container.querySelector("svg")).not.toBeNull();
});
