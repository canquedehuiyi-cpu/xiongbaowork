import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  CHANNEL_SETUP_DOCS,
  UpdateRoutingSection,
} from "@/components/settings/update-routing";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Where updates go, now in Settings: one decision for all of a person's Bots, so it is no longer
 * repeated on every Bot's page.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const ADMIN = { role: "admin", localEvaluation: false };
const writes: { request: string; body: unknown }[] = [];
const everyKind = {
  progress: ["push"],
  decision: "all",
  question: "all",
  attention: "all",
};
const everyChannel = { slack: true, teams: true, sms: true, push: true };
let routing: Record<string, unknown> = everyKind;
let available: Record<string, boolean> = everyChannel;
afterEach(() => {
  routing = everyKind;
  available = everyChannel;
});
function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({
        request: `${method} ${String(input)}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ ok: true });
    }
    // Every channel set up unless a case says otherwise, so each switch reflects the person's preference.
    if (String(input).endsWith("/api/delivery")) {
      return Response.json({
        bindings: [],
        devices: [],
        deliveries: [],
        available,
      });
    }
    return Response.json({ routing });
  }) as unknown as typeof fetch;
}

test("switching a transport on for one kind of update saves that kind's transports", async () => {
  serving();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <UpdateRoutingSection />
    </QueryClientProvider>,
  );
  fireEvent.click(await view.findByRole("switch", { name: "进展：短信" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    request: "PUT /api/bots/routing/progress",
    body: { transports: ["push", "sms"] },
  });
});

test("pings get their own row, Something needs you", async () => {
  routing = {
    progress: ["push"],
    decision: "all",
    question: "all",
    attention: ["push", "slack"],
  };
  serving();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <UpdateRoutingSection />
    </QueryClientProvider>,
  );
  expect(await view.findByText("有事需要你")).toBeTruthy();
  const sms = view.getByRole("switch", { name: "有事需要你：短信" });
  expect(sms.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(sms);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    request: "PUT /api/bots/routing/attention",
    body: { transports: ["push", "slack", "sms"] },
  });
});

/** Who is looking: an admin, or someone running OpenBot themselves, can set channels up; anyone else can't. */
function draw(who: { role: string; localEvaluation: boolean } = ADMIN) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(authKeys.currentUser(), { role: who.role });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: who.localEvaluation,
    edition: "team",
  });
  return render(
    <QueryClientProvider client={client}>
      <UpdateRoutingSection />
    </QueryClientProvider>,
  );
}

test("only channels that are set up get a switch, and a save keeps the others as they were", async () => {
  available = { slack: true, teams: false, sms: false, push: true };
  routing = { ...everyKind, progress: ["push", "sms"] };
  serving();
  const view = draw();
  const slack = await view.findByRole("switch", { name: "进展：Slack" });
  expect(view.queryByRole("switch", { name: "进展：短信" })).toBeNull();
  expect(view.queryByText("Microsoft Teams")).toBeNull();
  expect(view.queryByText(/Not set up|未设置|没设置/)).toBeNull();
  fireEvent.click(slack);
  await waitFor(() => expect(writes).toHaveLength(1));
  // SMS is not set up and has no switch, but the person's choice for it is still saved as it was.
  expect(writes[0]).toEqual({
    request: "PUT /api/bots/routing/progress",
    body: { transports: ["push", "slack", "sms"] },
  });
});

test("with no channel set up, it says updates stay in OpenBot, and whoever can set them up gets the way to", async () => {
  available = { slack: false, teams: false, sms: false, push: false };
  serving();
  const view = draw(ADMIN);
  expect(await view.findByText("消息只在熊宝里显示")).toBeTruthy();
  expect(view.queryAllByRole("switch")).toHaveLength(0);
  expect(
    view.getByText(
      "在熊宝运行的地方设置好推送、Slack、Microsoft Teams 或短信后，就能在这里选择。",
    ),
  ).toBeTruthy();
  const how = view.getByRole("link", { name: "怎么设置" });
  expect(how.getAttribute("href")).toBe(CHANNEL_SETUP_DOCS);
  expect(how.getAttribute("target")).toBe("_blank");
});

test("the section asks where updates go only above switches to choose with", async () => {
  const ASK = /你没在看时，每类消息发到哪里/;
  available = { slack: false, teams: false, sms: false, push: false };
  serving();
  const empty = draw(ADMIN);
  expect(await empty.findByText("消息只在熊宝里显示")).toBeTruthy();
  expect(empty.queryByText(ASK)).toBeNull();
  cleanup();
  available = everyChannel;
  serving();
  const choosing = draw(ADMIN);
  await choosing.findByRole("switch", { name: "进展：Slack" });
  expect(choosing.getByText(ASK)).toBeTruthy();
});

test("in OpenBot Desktop, where these channels can't reach anyone, it says so and links no setup docs", async () => {
  // What the Desktop window injects (`desktopShell`): the page is inside OpenBot Desktop.
  const shell = window as { __TAURI_INTERNALS__?: unknown };
  shell.__TAURI_INTERNALS__ = {
    invoke: async () => undefined,
    transformCallback: () => 0,
  };
  try {
    available = { slack: false, teams: false, sms: false, push: false };
    serving();
    const view = draw({ role: "member", localEvaluation: true });
    expect(
      await view.findByText(
        "推送、Slack、Microsoft Teams 和短信需要熊宝运行在服务器上。",
      ),
    ).toBeTruthy();
    expect(view.queryByRole("link", { name: "怎么设置" })).toBeNull();
  } finally {
    delete shell.__TAURI_INTERNALS__;
  }
});

test("someone running OpenBot on their own computer gets the way to set channels up too", async () => {
  available = { slack: false, teams: false, sms: false, push: false };
  serving();
  const view = draw({ role: "member", localEvaluation: true });
  expect(
    await view.findByRole("link", { name: "怎么设置" }),
  ).toBeTruthy();
});

test("a member who can't set channels up is told their admin does, with no link", async () => {
  available = { slack: false, teams: false, sms: false, push: false };
  serving();
  const view = draw({ role: "member", localEvaluation: false });
  expect(
    await view.findByText(
      "管理员设置好推送、Slack、Microsoft Teams 或短信后，就能在这里选择。",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("link", { name: "怎么设置" })).toBeNull();
});
