import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GroupPeopleButton } from "@/components/channels/group-people";
import { settleReactWork } from "./settle-react-work";

/**
 * Who is in a group, from a button in its top bar: the people in it, taking someone out or leaving,
 * and adding someone by email. It used to float above the composer.
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

let people: Record<string, unknown>[] = [];
const requests: string[] = [];
function serving(initial: Record<string, unknown>[]) {
  people = initial;
  requests.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      requests.push(`${method} ${url} ${init?.body ?? ""}`);
      if (method === "POST") {
        people = [
          ...people,
          {
            userId: "u3",
            email: "sam@example.test",
            name: "Sam",
            creator: false,
          },
        ];
      }
      return Response.json({ ok: true });
    }
    if (url === "/api/me") {
      return Response.json({
        user: { id: "me", role: "user", email: "me@example.test" },
      });
    }
    return Response.json({ bots: [], people, messages: [] });
  }) as unknown as typeof fetch;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GroupPeopleButton channelId="group-1" />
    </QueryClientProvider>,
  );
}

const ME = {
  userId: "me",
  email: "me@example.test",
  name: null,
  creator: true,
};
const ALEX = {
  userId: "u2",
  email: "alex@example.test",
  name: "Alex",
  creator: false,
};

test("the top bar says how many people are in the group", async () => {
  serving([ME, ALEX]);
  const view = draw();
  expect(await view.findByRole("button", { name: "2 人" })).toBeTruthy();
});

test("the creator sees everyone and can take another person out", async () => {
  serving([ME, ALEX]);
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "2 人" }));
  expect(await view.findByText("Alex")).toBeTruthy();
  expect(view.getByText("你")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "移除 alex@example.test" }));
  await waitFor(() =>
    expect(requests).toContain("DELETE /api/groups/group-1/members/u2 "),
  );
});

test("adding someone by email lists them without reopening the dialog", async () => {
  serving([ME]);
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "1 人" }));
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("textbox", { name: "对方的邮箱" }),
    "sam@example.test",
  );
  fireEvent.click(view.getByRole("button", { name: "添加" }));
  await waitFor(() =>
    expect(requests).toContain(
      'POST /api/groups/group-1/members {"email":"sam@example.test"}',
    ),
  );
  expect(await view.findByText("Sam")).toBeTruthy();
});

/** The creator's own row: leaving is allowed, and says who takes the group. */
test("the creator can leave, and is told who takes the group", async () => {
  serving([ME, ALEX]);
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "2 人" }));
  fireEvent.click(await view.findByRole("button", { name: "退出这个群聊" }));
  expect(
    await view.findByText(
      "退出后，这个群组和它的头像、组团流程、运行记录、看板任务卡都归「Alex」。",
    ),
  ).toBeTruthy();
  // Nothing has been sent yet: it is a question first.
  expect(requests).toEqual([]);
  fireEvent.click(view.getByRole("button", { name: "确认退出" }));
  await waitFor(() =>
    expect(requests).toContain("DELETE /api/groups/group-1/members/me "),
  );
});

test("the last person is told the chat goes and the group stays", async () => {
  serving([ME]);
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "1 人" }));
  fireEvent.click(await view.findByRole("button", { name: "退出这个群聊" }));
  expect(
    await view.findByText(
      "你是最后一个人。退出后这个聊天会删除，群组留在你的「群组」里，可以重新开始聊天。",
    ),
  ).toBeTruthy();
});

test("the server's refusal to leave is shown as it was sent", async () => {
  serving([ME, ALEX]);
  const base = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "DELETE"
      ? Response.json(
          { error: "有组团流程正在运行，先停下再退群。" },
          { status: 400 },
        )
      : base(input, init)) as unknown as typeof fetch;
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "2 人" }));
  fireEvent.click(await view.findByRole("button", { name: "退出这个群聊" }));
  fireEvent.click(await view.findByRole("button", { name: "确认退出" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "有组团流程正在运行，先停下再退群。",
  );
});
