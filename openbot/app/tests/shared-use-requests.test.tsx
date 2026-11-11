// app/tests/shared-use-requests.test.tsx
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SharedUseRequests } from "../src/components/approvals/shared-use-requests";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let role: "user" | "admin" = "admin";
let alreadyDecided = false;
const posted: string[] = [];
const request = {
  id: "r1",
  botId: "bot1",
  botName: "Helpdesk",
  ownerUserId: "dana",
  serverId: "gh",
  title: "Team GitHub",
  proposed: { audience: "team", outsideInput: true, members: [] },
  current: { audience: "owner", outsideInput: false, members: [] },
  reason: "refused_call",
  requestedBy: "sam",
  status: "pending",
  createdAt: "2026-10-07T03:00:00.000Z",
};
beforeEach(() => {
  posted.length = 0;
  alreadyDecided = false;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (url === "/api/me")
        return Response.json({
          user: { id: "me", email: "me@example.test", role },
        });
      if (url === "/api/plugins/shared-use")
        return Response.json({ requests: [request] });
      if (init?.method === "POST") {
        posted.push(url);
        if (alreadyDecided)
          return Response.json(
            { error: "That request has already been decided." },
            { status: 409 },
          );
        return Response.json({ request: { ...request, status: "approved" } });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

const draw = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SharedUseRequests />
    </QueryClientProvider>,
  );

describe("Shared account requests", () => {
  test("shows what is asked against what is approved now, and why", async () => {
    role = "admin";
    const view = draw();
    expect(
      await view.findByText("Helpdesk 想用 Team GitHub 的团队账号"),
    ).toBeTruthy();
    expect(view.getByText("现在：只有它的主人")).toBeTruthy();
    expect(view.getByText("申请：所有人，也接受外部输入")).toBeTruthy();
    expect(
      view.getByText(
        "有个动作被拦下了：能用这位员工的人比批准的多。",
      ),
    ).toBeTruthy();
  });

  test("approving posts once", async () => {
    role = "admin";
    const view = draw();
    await userEvent.click(await view.findByRole("button", { name: "批准" }));
    expect(posted).toEqual(["/api/plugins/shared-use/r1/approve"]);
  });

  test("a request another admin already answered says so", async () => {
    role = "admin";
    alreadyDecided = true;
    const view = draw();
    await userEvent.click(await view.findByRole("button", { name: "拒绝" }));
    expect(
      await view.findByText("That request has already been decided."),
    ).toBeTruthy();
  });

  test("is not drawn for someone who is not an administrator", async () => {
    role = "user";
    const view = draw();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.queryByText(/团队账号使用申请/)).toBeNull();
  });
});
