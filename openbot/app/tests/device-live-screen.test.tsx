import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ComputerView } from "@/components/computer/computer-view";
import type { ControlState } from "@/lib/computers/control";
import { queryClient } from "@/query-client";

/**
 * The existing viewer, for a coworker whose browser runs on the tenant's own machine (F2 stage 2).
 *
 * The server marks such a Bot's control state with its device. The viewer then offers 查看实时画面,
 * which opens the live socket to watch without taking the wheel and without a polled screenshot, says
 * whose machine it is, explains a device with no page open yet, and keeps the same 接管 / 交还.
 */

/** Queries over the whole page, bound once the page exists rather than at import. */
const body = () => within(document.body);

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static opened: SocketDouble[] = [];

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];

  constructor(readonly url: string) {
    SocketDouble.opened.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close() {
    this.readyState = SocketDouble.CLOSED;
    this.onclose?.();
  }

  say(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

class IntersectionObserverDouble {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let originalWebSocket: typeof WebSocket;
let originalFetch: typeof fetch;
let originalIntersectionObserver: typeof IntersectionObserver | undefined;

beforeAll(() => {
  GlobalRegistrator.register();
  originalWebSocket = globalThis.WebSocket;
  originalFetch = globalThis.fetch;
  originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  globalThis.IntersectionObserver =
    IntersectionObserverDouble as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  cleanup();
  SocketDouble.opened = [];
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  if (originalIntersectionObserver) {
    globalThis.IntersectionObserver = originalIntersectionObserver;
  } else {
    Reflect.deleteProperty(globalThis, "IntersectionObserver");
  }
  GlobalRegistrator.unregister();
});

/** The viewer as the app mounts it: the recorder under the screen reads through the query client. */
function view(computerId: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ComputerView computerId={computerId} name="小熊" />
    </QueryClientProvider>,
  );
}

/** A deployment whose Bot runs on `device`, or in a container when it is absent. */
function server(device?: string) {
  let state: ControlState = {
    holder: "bot",
    since: "2026-11-04T00:00:00Z",
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
    ...(device ? { device: { deviceId: device } } : {}),
  };
  const calls: string[] = [];
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0]) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith("/control/request")) {
        state = {
          ...state,
          requested: true,
          request: {
            id: "request-1",
            status: "waiting",
            reason: "I want to take control of the browser.",
            source: "manual",
            createdAt: state.since,
            updatedAt: state.since,
          },
        };
        return Response.json(state);
      }
      if (path.endsWith("/control/take") && state.request) {
        state = {
          ...state,
          holder: "human",
          requested: false,
          request: { ...state.request, status: "taken" },
        };
        return Response.json(state);
      }
      if (path.endsWith("/control/release") && state.request) {
        state = {
          ...state,
          holder: "bot",
          request: undefined,
        };
        return Response.json(state);
      }
      if (path.includes("/control")) return Response.json(state);
      // No polled picture: the device-backed viewer must not depend on one.
      return Response.json(
        { error: "No screenshot right now." },
        { status: 503 },
      );
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  return { calls };
}

test("a device-backed Bot offers 查看实时画面, which watches the device's screen without taking the wheel", async () => {
  server("laptop-1");
  view("bot-1");
  const watch = await body().findByRole("button", { name: "查看实时画面" });
  expect(body().getByText(/在你自己的设备上。/)).toBeDefined();
  expect(SocketDouble.opened).toHaveLength(0);

  fireEvent.click(watch);
  const dialog = await body().findByRole("dialog", { name: "员工的屏幕" });
  await waitFor(() => expect(SocketDouble.opened).toHaveLength(1));
  const socket = SocketDouble.opened[0] as SocketDouble;
  expect(socket.url).toContain("/api/computers/bot-1/stream");
  // Watching, not driving: the canvas says so and takes no input.
  expect(
    dialog.querySelector('canvas[aria-label="员工的屏幕，实时"]'),
  ).not.toBeNull();
  expect(dialog.textContent).toContain("实时画面来自你的设备 laptop-1");

  // A coworker with no page open on the machine yet is explained, and the explanation goes when it casts.
  act(() => socket.say({ type: "status", state: "idle" }));
  expect(
    await body().findByText(
      "员工还没有在这台设备上打开页面。它一打开，画面就会出现在这里。",
    ),
  ).toBeDefined();
  act(() => socket.say({ type: "status", state: "casting" }));
  await waitFor(() =>
    expect(
      body().queryByText(
        "员工还没有在这台设备上打开页面。它一打开，画面就会出现在这里。",
      ),
    ).toBeNull(),
  );
});

test("接管 and 交还 work the same for a device-backed Bot", async () => {
  const { calls } = server("laptop-1");
  view("bot-2");
  fireEvent.click(await body().findByRole("button", { name: "查看实时画面" }));
  const dialog = await body().findByRole("dialog", { name: "员工的屏幕" });
  const takeButtons = await body().findAllByRole("button", { name: "接管" });
  fireEvent.click(takeButtons.at(-1) as HTMLElement);
  await waitFor(() =>
    expect(calls.some((path) => path.endsWith("/control/take"))).toBeTrue(),
  );
  await waitFor(() =>
    expect(
      dialog.querySelector(
        'canvas[aria-label="员工的屏幕。由你操作：可以在这里点击和输入。"]',
      ),
    ).not.toBeNull(),
  );
  const giveBack = await body().findAllByRole("button", { name: "交还" });
  fireEvent.click(giveBack.at(-1) as HTMLElement);
  await waitFor(() =>
    expect(calls.some((path) => path.endsWith("/control/release"))).toBeTrue(),
  );
  expect(
    (await body().findAllByRole("button", { name: "接管" })).length,
  ).toBeGreaterThan(0);
});

test("a container-backed Bot is unchanged: no 查看实时画面, and no live socket without a picture", async () => {
  server();
  view("bot-3");
  await body().findAllByRole("button", { name: "接管" });
  expect(body().queryByRole("button", { name: "查看实时画面" })).toBeNull();
  expect(body().queryByText(/在你自己的设备上/)).toBeNull();
  fireEvent.click(body().getByRole("button", { name: "全屏打开员工的屏幕" }));
  await body().findByRole("dialog", { name: "员工的屏幕" });
  await Bun.sleep(20);
  expect(SocketDouble.opened).toHaveLength(0);
});
