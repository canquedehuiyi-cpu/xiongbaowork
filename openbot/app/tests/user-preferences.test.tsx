import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UserPreferences } from "@openbot/shared/user-preferences";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MessageListPreference } from "@/components/settings/message-list-preference";
import { authKeys } from "@/lib/auth/queries";
import {
  saveUserPreferencesMutationOptions,
  userPreferencesQueryOptions,
} from "@/lib/settings/message-list";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
let response: () => Promise<Response>;
let requests: { path: string; method: string; body: unknown }[];
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  requests = [];
  response = async () =>
    Response.json({ preferences: { messageListEmphasis: "agent" } });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        path: String(input),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      return response();
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

function setup() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(authKeys.currentUser(), {
    id: "alice",
    email: "alice@example.com",
    role: "user",
    onboarding: null,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MessageListPreference />
    </QueryClientProvider>,
  );
  return { client, view };
}

test("loads preferences from the account and renders the saved emphasis", async () => {
  const { view } = setup();
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
  const agent = await view.findByText("我的分身");
  expect(agent.className).toContain("text-[0.9rem]");
=======
  const agent = await view.findByText("General Assistant");
  expect(agent.className).toContain("text-sm");
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  expect(requests).toEqual([
    { path: "/api/settings/preferences", method: "GET", body: undefined },
  ]);
});

test("shows loading and read errors without enabling a save", async () => {
  const pending = Promise.withResolvers<Response>();
  response = () => pending.promise;
  const { view } = setup();
  expect(view.getByRole("combobox")).toHaveProperty("disabled", true);
  expect(view.queryByText("我的分身")).toBeNull();
  pending.resolve(
    Response.json({ error: "Storage unavailable" }, { status: 503 }),
  );
  expect((await view.findByRole("alert")).textContent).toBe(
    "Storage unavailable",
  );
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
  expect(view.getByRole("button", { name: "重试" })).toBeTruthy();
=======
  expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
});

test("successful writes update only the current account cache; failures preserve saved values", async () => {
  const { client, view } = setup();
  await view.findByText("我的分身");
  const bobKey = userPreferencesQueryOptions("bob").queryKey;
  client.setQueryData(bobKey, {
    messageListEmphasis: "agent",
    selfHostBannerDismissed: false,
    narration: null,
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
    skin: "openbot",
=======
    skin: "opendots",
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
    proactive: "on",
  });
  const mutation = client
    .getMutationCache()
    .build(client, saveUserPreferencesMutationOptions(client, "alice"));
  response = async () =>
    Response.json({
      preferences: {
        messageListEmphasis: "thread",
        selfHostBannerDismissed: false,
        narration: null,
        skin: "openbot",
        proactive: "on",
      },
    });
  await mutation.execute({ messageListEmphasis: "thread" });
  await waitFor(() =>
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
    expect(view.getByText("规划下周").className).toContain(
      "text-[0.9rem]",
    ),
=======
    expect(view.getByText("Plan next week").className).toContain("text-sm"),
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  );
  expect(requests.at(-1)).toEqual({
    path: "/api/settings/preferences",
    method: "PATCH",
    body: JSON.stringify({ messageListEmphasis: "thread" }),
  });
  expect(client.getQueryData<UserPreferences>(bobKey)).toEqual({
    messageListEmphasis: "agent",
    selfHostBannerDismissed: false,
    narration: null,
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
    skin: "openbot",
=======
    skin: "opendots",
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
    proactive: "on",
  });
  response = async () =>
    Response.json({ error: "Could not save" }, { status: 500 });
  await expect(
    mutation.execute({ messageListEmphasis: "agent" }),
  ).rejects.toThrow("Could not save");
  expect(
    client.getQueryData<UserPreferences>(
      userPreferencesQueryOptions("alice").queryKey,
    ),
  ).toEqual({
    messageListEmphasis: "thread",
    selfHostBannerDismissed: false,
    narration: null,
    skin: "openbot",
    proactive: "on",
  });
});
