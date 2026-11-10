import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { PortraitPicker } from "@/components/portraits/portrait-picker";
import { type Portrait, portraitKeys } from "@/lib/portraits/queries";
import { settleReactWork } from "./settle-react-work";

/*
 * 头像 in the browser: a face somebody chose is drawn wherever that coworker or group appears, and
 * the picker saves an expression or clears the face with one click each.
 */

let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register({ url: "http://localhost:3010" });
    registeredHere = true;
  }
});
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
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

const cute: Portrait = {
  kind: "coworker",
  id: "bot-1",
  preset: "cute",
  imageUrl: null,
  updatedAt: "2026-11-08T00:00:00.000Z",
};

test("a coworker with a chosen face is drawn with it; one without keeps its drawing", () => {
  const { ui } = withClient(
    [cute],
    <>
      <AbstractAvatar
        name="客服小熊"
        portrait={{ kind: "coworker", id: "bot-1" }}
        seed="seed-1"
      />
      <AbstractAvatar
        name="周报员"
        portrait={{ kind: "coworker", id: "bot-2" }}
        seed="seed-2"
      />
    </>,
  );
  const view = render(ui);
  const chosen = view.getByRole("img", { name: "客服小熊" });
  expect(
    chosen.querySelector("img[data-portrait]")?.getAttribute("src"),
  ).toContain("xiongbao-cute");
  expect(
    view
      .getByRole("img", { name: "周报员" })
      .querySelector("img[data-portrait]"),
  ).toBeNull();
});

test("an uploaded picture is drawn from its versioned URL, and a face without a query client still draws", () => {
  const { ui } = withClient(
    [
      {
        kind: "group",
        id: "g-1",
        preset: null,
        imageUrl: "/api/portraits/group/g-1/image?v=1",
        updatedAt: "2026-11-08T00:00:00.000Z",
      },
    ],
    <AbstractAvatar
      name="编程群组"
      portrait={{ kind: "group", id: "g-1" }}
      seed="g-1"
    />,
  );
  const view = render(ui);
  expect(
    view
      .getByRole("img", { name: "编程群组" })
      .querySelector("img[data-portrait]")
      ?.getAttribute("src"),
  ).toBe("/api/portraits/group/g-1/image?v=1");
  cleanup();

  const bare = render(
    <AbstractAvatar
      name="客服小熊"
      portrait={{ kind: "coworker", id: "bot-1" }}
      seed="seed-1"
    />,
  );
  expect(bare.getByRole("img", { name: "客服小熊" })).toBeTruthy();
});

test("the picker saves an expression, and 恢复默认 clears the face", async () => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let current: Portrait[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (method === "PUT") {
      current = [{ ...cute, preset: body.preset }];
      return Response.json({ portrait: current[0] });
    }
    if (method === "DELETE") {
      current = [];
      return Response.json({ ok: true });
    }
    return Response.json({ portraits: current });
  }) as typeof fetch;

  const { ui } = withClient(
    [],
    <PortraitPicker
      id="bot-1"
      kind="coworker"
      name="客服小熊"
      onOpenChange={() => {}}
      open
      seed="seed-1"
    />,
  );
  const view = render(ui);
  const dialog = await view.findByRole("dialog");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  expect(
    (
      within(dialog).getByRole("button", {
        name: /恢复默认/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);

  await user.click(within(dialog).getByRole("button", { name: "帅气" }));
  await waitFor(() =>
    expect(
      within(dialog)
        .getByRole("button", { name: "帅气" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  expect(calls.find((call) => call.method === "PUT")).toEqual({
    method: "PUT",
    url: "/api/portraits/coworker/bot-1",
    body: { preset: "cool" },
  });

  await user.click(within(dialog).getByRole("button", { name: /恢复默认/ }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === "DELETE")).toBe(true),
  );
  expect(calls.find((call) => call.method === "DELETE")?.url).toBe(
    "/api/portraits/coworker/bot-1",
  );
});
