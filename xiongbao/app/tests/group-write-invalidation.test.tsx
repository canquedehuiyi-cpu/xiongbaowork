import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  MutationObserver,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { renameChannelMutationOptions } from "@/lib/channels/mutations";
import { channelKeys } from "@/lib/channels/queries";
import {
  createGroupMutationOptions,
  removeGroupMemberMutationOptions,
} from "@/lib/groups";
import { useApplyProposal } from "@/lib/staffing/queries";
import { wakerGroupKeys } from "@/lib/waker-groups/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Writes that change a group on the server must read the group list again: the list is kept fresh
 * for 30 seconds, and a row menu or a card that reads a stale one is how a group is orphaned.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/apply"))
      return Response.json({
        proposal: { id: "p-1", status: "done", kind: "group" },
      });
    if (url === "/api/groups")
      return Response.json({ channel: { id: "c-1", wakerGroupId: "g-1" } });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A client that records which query families were invalidated. */
function recorded() {
  const queryClient = new QueryClient();
  const keys: unknown[][] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filter?: { queryKey?: unknown[] }) => {
    keys.push([...(filter?.queryKey ?? [])]);
    return original(filter);
  }) as typeof queryClient.invalidateQueries;
  return { queryClient, keys };
}

// biome-ignore lint/suspicious/noExplicitAny: one runner for each mutation's own input and result type
type Loose = any;
const run = (options: Loose, queryClient: QueryClient, variables: unknown) =>
  new MutationObserver<Loose, Error, Loose>(queryClient, options).mutate(
    variables,
  );

test("making a group chat in 新对话 reads the groups again", async () => {
  const { queryClient, keys } = recorded();
  await run(createGroupMutationOptions(queryClient), queryClient, ["a", "b"]);
  expect(keys).toContainEqual([...wakerGroupKeys.all]);
  expect(keys).toContainEqual([...channelKeys.all]);
});

test("leaving a group reads the groups again", async () => {
  const { queryClient, keys } = recorded();
  await run(
    removeGroupMemberMutationOptions(queryClient, "c-1"),
    queryClient,
    "me",
  );
  expect(keys).toContainEqual([...wakerGroupKeys.all]);
  expect(keys).toContainEqual([...channelKeys.all]);
});

test("renaming from the row menu reads the groups again", async () => {
  const { queryClient, keys } = recorded();
  await run(renameChannelMutationOptions(queryClient), queryClient, {
    channelId: "c-1",
    title: "新名字",
  });
  expect(keys).toContainEqual([...wakerGroupKeys.all]);
  expect(keys).toContainEqual([...channelKeys.list()]);
});

test("running a staffing proposal (组建群组, 调整群组) reads the groups again", async () => {
  const { queryClient, keys } = recorded();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useApplyProposal("p-1"), { wrapper });
  result.current.mutate();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(keys).toContainEqual([...wakerGroupKeys.all]);
  expect(keys).toContainEqual([...channelKeys.all]);
});
