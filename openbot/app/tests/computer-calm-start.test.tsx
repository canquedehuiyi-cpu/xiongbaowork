import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { ToolLine } from "@/components/channels/tool-line";
import { ComputerView } from "@/components/computer/computer-view";

test("a call turned away by a computer still starting reads as not done yet, not as a failure", () => {
  const view = render(
    <ToolLine label="点击了" detail="电脑还在启动。" notYet />,
  );
  const line = view.getByText("点击了，还没做");
  expect(line.closest(".text-amber-600")).toBeNull();
  expect(line.closest(".text-destructive")).toBeNull();
  expect(view.queryByText(/没有成功/)).toBeNull();
});

/**
 * A computer starting in front of a person never reads as a failure.
 *
 * The panel used to call the first frameless screenshot a problem, so every cold start opened on
 * "Can't show the screen right now… ask an admin", and every blip in the live stream covered the
 * screen with a Retry panel. What a person should see instead is a sentence saying the computer is
 * starting, a small "正在重新连接…" while the stream comes back, and a problem only when there
 * really is one.
 */

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: SocketDouble[] = [];

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: string) {
    SocketDouble.all.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send() {}

  close() {
    this.readyState = SocketDouble.CLOSED;
  }
}

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;
let originalIntersectionObserver: typeof IntersectionObserver | undefined;
// Prototypes outlive this file: bun runs every test file in one process, and a canvas stub left
// behind here breaks the next file that draws on one.
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
let originalDecode: typeof HTMLImageElement.prototype.decode;

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  originalIntersectionObserver = globalThis.IntersectionObserver;
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  originalDecode = HTMLImageElement.prototype.decode;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  // Without an observer the preview counts as on screen, which is what these cases are about.
  Reflect.deleteProperty(globalThis, "IntersectionObserver");
  HTMLImageElement.prototype.decode = () => Promise.resolve();
});

afterEach(() => {
  cleanup();
  SocketDouble.all = [];
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  if (originalIntersectionObserver) {
    globalThis.IntersectionObserver = originalIntersectionObserver;
  }
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLImageElement.prototype.decode = originalDecode;
  GlobalRegistrator.unregister();
});

function renderWithQueries(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

const control = {
  holder: "bot",
  since: new Date(0).toISOString(),
  requested: false,
};

/** A server whose answers are given per path ending; anything else is a 404. */
function serve(routes: Record<string, () => Response>) {
  globalThis.fetch = (async (input) => {
    const path = String(input);
    for (const [ending, answer] of Object.entries(routes)) {
      if (path.endsWith(ending)) return answer();
    }
    if (path.endsWith("/control")) return Response.json(control);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const frame = () =>
  Response.json({
    base64: "AAAA",
    width: 320,
    height: 200,
    capturedAt: new Date(0).toISOString(),
    url: "https://example.com",
  });

test("a computer that is starting says so, calmly, and shows no problem", async () => {
  serve({
    "/status": () => Response.json({ botId: "sales", state: "starting" }),
    "/screenshot": () => Response.json({ ready: false, state: "starting" }),
  });

  const view = renderWithQueries(
    <ComputerView
      active
      computerId="sales"
      intervalMs={10}
      name="Sales"
      toolCallId="call-1"
    />,
  );

  expect(
    await view.findByText("正在启动Sales的电脑。第一次启动大约需要一分钟。"),
  ).toBeDefined();
  expect(view.queryByText(/can't show the screen/i)).toBeNull();
  expect(view.queryByText(/error/i)).toBeNull();
});

test("failed screenshots during a start are not a problem until the grace runs out", async () => {
  serve({
    "/status": () => Response.json({ botId: "sales", state: "starting" }),
    "/screenshot": () =>
      Response.json(
        { error: "The computer did not respond." },
        { status: 503 },
      ),
  });

  const view = renderWithQueries(
    <ComputerView
      active
      computerId="sales"
      intervalMs={10}
      name="Sales"
      startupGraceMs={200}
    />,
  );

  await view.findByText(/^正在启动Sales的电脑/);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  expect(view.queryByText(/can't show the screen/i)).toBeNull();

  // Past the grace, with still no frame, it is worth saying.
  expect(
    await view.findByText("现在看不到屏幕", {}, { timeout: 1000 }),
  ).toBeDefined();
  expect(view.getByText("The computer did not respond.")).toBeDefined();
});

test("a computer the server cannot reach is a problem straight away", async () => {
  serve({
    "/status": () =>
      Response.json({
        botId: "sales",
        state: "unreachable",
        reason: "supervisor down",
      }),
    "/screenshot": () =>
      Response.json({
        ready: false,
        state: "unreachable",
        reason: "supervisor down",
      }),
  });

  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );

  expect(await view.findByText("Sales的电脑暂时连不上。")).toBeDefined();
  // The provider's own words are for an admin, not this screen.
  expect(view.queryByText(/supervisor down/)).toBeNull();
});

test("a computer that is off, watched from the side panel, says it starts when the Bot uses it", async () => {
  serve({
    "/status": () => Response.json({ botId: "sales", state: "absent" }),
    "/screenshot": () => Response.json({ ready: false, state: "absent" }),
  });

  const view = renderWithQueries(
    <ComputerView
      active
      computerId="sales"
      intervalMs={10}
      name="Sales"
      startupGraceMs={30}
    />,
  );

  expect(
    await view.findByText("Sales的电脑已关机。员工下次用到它时会自动启动。"),
  ).toBeDefined();
  // Off is not stalled: waiting past the grace still shows no problem.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  expect(view.queryByText(/can't show the screen/i)).toBeNull();
});

test("a live stream that drops shows a quiet badge, not the Retry panel", async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage: () => undefined,
    clearRect: () => undefined,
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  serve({ "/screenshot": frame });

  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );
  await view.findByAltText("员工正在看的内容");
  fireEvent.click(view.getByLabelText("全屏打开员工的屏幕"));
  await waitFor(() => expect(SocketDouble.all.length).toBe(1));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  await act(async () => {
    SocketDouble.all[0]?.onclose?.();
  });

  expect(view.getByText("正在重新连接…")).toBeDefined();
  expect(view.queryByText("重试")).toBeNull();
});

test("a computer that was off and then fails is not called off for ever", async () => {
  // The first answer says off; every one after it is a failed screenshot of a computer now up.
  let shots = 0;
  serve({
    "/status": () => Response.json({ botId: "sales", state: "ready" }),
    "/screenshot": () =>
      shots++ === 0
        ? Response.json({ ready: false, state: "absent" })
        : Response.json(
            { error: "The computer did not respond." },
            { status: 503 },
          ),
  });

  const view = renderWithQueries(
    <ComputerView
      active
      computerId="sales"
      intervalMs={10}
      name="Sales"
      startupGraceMs={100}
    />,
  );

  expect(
    await view.findByText("现在看不到屏幕", {}, { timeout: 1000 }),
  ).toBeDefined();
  expect(view.queryByText(/is off/)).toBeNull();
});

test("a computer that goes to sleep stops showing its last frame", async () => {
  let shots = 0;
  serve({
    "/status": () => Response.json({ botId: "sales", state: "absent" }),
    "/screenshot": () =>
      shots++ === 0
        ? frame()
        : Response.json({ ready: false, state: "absent" }),
  });

  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );

  await view.findByAltText("员工正在看的内容");
  await waitFor(() => {
    expect(
      view.getByText("Sales的电脑已关机。员工下次用到它时会自动启动。"),
    ).toBeDefined();
    expect(view.queryByAltText("员工正在看的内容")).toBeNull();
  });
});
