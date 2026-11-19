import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { type ReactNode, useRef } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  ConversationIntro,
  ConversationIntroBar,
  useIntroScrolledAway,
} from "@/components/channels/conversation-intro";
import { deploymentKeys } from "@/lib/deployment/queries";
import { type Portrait, portraitKeys } from "@/lib/portraits/queries";
import { settleReactWork } from "./settle-react-work";

/*
 * The intro card stays at the top of a conversation: full while it is on screen, folded to one line
 * over the pane once it has scrolled away. And the face on it, on the title and on a speaking
 * member plays its video, in the state the employee is in.
 */

let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register({ url: "http://localhost:3010" });
    registeredHere = true;
  }
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  if (registeredHere) GlobalRegistrator.unregister();
});

const filmed: Portrait = {
  kind: "coworker",
  id: "bot-1",
  preset: null,
  imageUrl: "/api/portraits/coworker/bot-1/image?v=1",
  videoUrl: "/api/portraits/coworker/bot-1/video?v=1",
  outfit: null,
  updatedAt: "2026-11-08T00:00:00.000Z",
};
const agent = {
  id: "bot-1",
  name: "客服小熊",
  title: "客服",
  roleDescription: "回答售后问题",
  avatarSeed: "seed-1",
  visibility: "private" as const,
};

function withClient(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(portraitKeys.all, [filmed]);
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    edition: "team",
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function mockMatchMedia(matches: boolean) {
  const original = window.matchMedia;
  window.matchMedia = () =>
    ({
      matches,
      media: "",
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  return () => {
    window.matchMedia = original;
  };
}

const videos = (view: { container: HTMLElement }) =>
  view.container.querySelectorAll("video[data-portrait-video]");

test("the intro card draws the chosen portrait's video, and its motion follows the state", () => {
  const restore = mockMatchMedia(false);
  try {
    const view = render(
      withClient(<ConversationIntro agent={agent} motion="idle" />),
    );
    expect(videos(view).length).toBe(1);
    const idle = videos(view)[0].parentElement?.className;
    view.rerender(
      withClient(<ConversationIntro agent={agent} motion="working" />),
    );
    expect(videos(view).length).toBe(1);
    const working = videos(view)[0].parentElement?.className;
    expect(working).not.toBe(idle);
  } finally {
    restore();
  }
});

test("reduced motion draws the still picture, not the video", () => {
  const restore = mockMatchMedia(true);
  try {
    const view = render(
      withClient(<ConversationIntro agent={agent} motion="idle" />),
    );
    expect(videos(view).length).toBe(0);
    expect(view.container.querySelector("img[data-portrait]")).not.toBeNull();
  } finally {
    restore();
  }
});

test("without motion, or without a query client, the face is still and nothing throws", () => {
  const restore = mockMatchMedia(false);
  try {
    const still = render(withClient(<ConversationIntro agent={agent} />));
    expect(videos(still).length).toBe(0);
    cleanup();
    const bare = render(
      <ChannelAvatar motion="idle" participantIds={["bot-1"]} />,
    );
    expect(videos(bare).length).toBe(0);
  } finally {
    restore();
  }
});

test("the folded line plays the video only while it is shown", () => {
  const restore = mockMatchMedia(false);
  try {
    const shown = render(
      withClient(<ConversationIntroBar agent={agent} motion="idle" visible />),
    );
    expect(videos(shown).length).toBe(1);
    cleanup();
    const hidden = render(
      withClient(
        <ConversationIntroBar agent={agent} motion="idle" visible={false} />,
      ),
    );
    expect(videos(hidden).length).toBe(0);
    expect(
      hidden.container
        .querySelector("[data-slot=conversation-intro-bar]")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
  } finally {
    restore();
  }
});

test("a group animates only the members in motionIds", () => {
  const restore = mockMatchMedia(false);
  try {
    const view = render(
      withClient(
        <ChannelAvatar
          motion="working"
          motionIds={["bot-1"]}
          participantIds={["bot-1", "bot-2"]}
          size={32}
        />,
      ),
    );
    expect(videos(view).length).toBe(1);
  } finally {
    restore();
  }
});

function Harness() {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const { introRef, away, update } = useIntroScrolledAway(viewportRef);
  return (
    <div data-testid="pane" style={{ position: "relative" }}>
      <div data-testid="viewport" onScroll={update} ref={viewportRef}>
        <div data-testid="intro" ref={introRef}>
          intro
        </div>
      </div>
      <ConversationIntroBar agent={agent} visible={away} />
    </div>
  );
}

function rect(top: number, bottom: number) {
  return () => ({ top, bottom }) as DOMRect;
}

test("the folded line is laid over the pane, outside the scroller, and appears once the intro has scrolled out", () => {
  const view = render(withClient(<Harness />));
  const viewport = view.getByTestId("viewport");
  const intro = view.getByTestId("intro");
  const bar = () =>
    view.container.querySelector("[data-slot=conversation-intro-bar]");
  viewport.getBoundingClientRect = rect(100, 600);
  // At the top: the intro is on screen, so the full card shows and the line is hidden.
  intro.getBoundingClientRect = rect(110, 230);
  fireEvent.scroll(viewport);
  expect(bar()?.getAttribute("data-visible")).toBe("false");
  // Scrolled: the intro's bottom has passed the viewport's top.
  intro.getBoundingClientRect = rect(-60, 60);
  act(() => {
    fireEvent.scroll(viewport);
  });
  expect(bar()?.getAttribute("data-visible")).toBe("true");
  // Not inside the scroll content, and opaque so messages do not show through it.
  expect(viewport.contains(bar())).toBe(false);
  expect(bar()?.className).toContain("absolute");
  expect(bar()?.className).toContain("bg-background");
  // Back to the top: expands again.
  intro.getBoundingClientRect = rect(100, 220);
  act(() => {
    fireEvent.scroll(viewport);
  });
  expect(bar()?.getAttribute("data-visible")).toBe("false");
});
