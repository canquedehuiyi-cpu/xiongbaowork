import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { EditablePortrait } from "@/components/portraits/portrait-picker";
import { type Portrait, portraitKeys } from "@/lib/portraits/queries";

/*
 * Motion on a face: a detail face plays its uploaded video, a list face stays still, a failed
 * video retries when a replacement is uploaded, and reduced-motion users always get the poster.
 */

let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register({ url: "http://localhost:3010" });
    registeredHere = true;
  }
});
afterEach(() => {
  cleanup();
});
afterAll(() => {
  if (registeredHere) GlobalRegistrator.unregister();
});

function withClient(portraits: Portrait[], children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(portraitKeys.all, portraits);
  return {
    queryClient,
    ui: (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

const filmed: Portrait = {
  kind: "coworker",
  id: "bot-1",
  preset: null,
  imageUrl: "/api/portraits/coworker/bot-1/image?v=1",
  videoUrl: "/api/portraits/coworker/bot-1/video?v=1",
  outfit: null,
  updatedAt: "2026-11-08T00:00:00.000Z",
};

function videoOf(view: { container: HTMLElement }) {
  return view.container.querySelector("video[data-portrait-video]");
}

function posterOf(view: { container: HTMLElement }) {
  return view.container.querySelector("img[data-portrait]");
}

function face(motion: "idle" | undefined) {
  return (
    <AbstractAvatar
      motion={motion}
      name="客服小熊"
      portrait={{ kind: "coworker", id: "bot-1" }}
      seed="seed-1"
    />
  );
}

test("a detail face plays its video; the same face without motion stays still", () => {
  const detail = withClient(
    [filmed],
    <EditablePortrait
      id="bot-1"
      kind="coworker"
      motion="idle"
      name="客服小熊"
      seed="seed-1"
      size={44}
    />,
  );
  const detailView = render(detail.ui);
  expect(videoOf(detailView)).not.toBeNull();
  cleanup();

  const list = withClient(
    [filmed],
    <EditablePortrait
      id="bot-1"
      kind="coworker"
      name="客服小熊"
      seed="seed-1"
      size={44}
    />,
  );
  const listView = render(list.ui);
  expect(videoOf(listView)).toBeNull();
  expect(posterOf(listView)).not.toBeNull();
});

test("a failed video retries when a replacement is uploaded", async () => {
  const { queryClient, ui } = withClient([filmed], face("idle"));
  const view = render(ui);
  const first = videoOf(view);
  expect(first).not.toBeNull();
  fireEvent.error(first as Element);
  expect(videoOf(view)).toBeNull();
  expect(posterOf(view)).not.toBeNull();

  queryClient.setQueryData(portraitKeys.all, [
    { ...filmed, videoUrl: "/api/portraits/coworker/bot-1/video?v=2" },
  ]);
  await waitFor(() => expect(videoOf(view)).not.toBeNull());
  expect(posterOf(view)).toBeNull();
});

function mockMatchMedia(matches: boolean) {
  const original = window.matchMedia;
  const query = {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
  window.matchMedia = () =>
    query as unknown as MediaQueryList;
  return () => {
    window.matchMedia = original;
  };
}

test("reduced motion shows the poster, never the video", () => {
  const restore = mockMatchMedia(true);
  try {
    const { ui } = withClient([filmed], face("idle"));
    const view = render(ui);
    expect(videoOf(view)).toBeNull();
    expect(posterOf(view)).not.toBeNull();
  } finally {
    restore();
  }
});

test("without reduced motion the video plays", () => {
  const restore = mockMatchMedia(false);
  try {
    const { ui } = withClient([filmed], face("idle"));
    const view = render(ui);
    expect(videoOf(view)).not.toBeNull();
  } finally {
    restore();
  }
});
