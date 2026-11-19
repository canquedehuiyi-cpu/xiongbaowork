import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ApprovalInbox } from "@/components/approvals/inbox";
import type { ApprovalInboxData } from "@/lib/approvals";
import { settleReactWork } from "./settle-react-work";

/**
 * Landing on the one approval a group line is stopped on.
 *
 * A line in a group that waits on a person links to `/settings/approvals?focus=<id>`; the page
 * hands that id down and the row it names is the one marked as arrived-at, so a person coming from
 * the line does not have to look for it among everything else waiting. A focus that names nothing
 * waiting -- already decided, or another person's -- marks nothing rather than pointing at a
 * neighbour.
 *
 * The inbox is played at the HTTP boundary; ApprovalInbox is the real component.
 */

const ADA = "agent-ada";

function waiting(
  id: string,
  reason: string,
): ApprovalInboxData["requests"][number] {
  return {
    id,
    status: "pending",
    createdAt: new Date().toISOString(),
    action: {
      botId: ADA,
      toolRef: "computer_run_command",
      effect: "write",
      scope: "computer",
      threadId: "thread-1",
      args: { command: "rm -rf ./dist" },
      target: { kind: "computer" },
      policy: { behaviour: "ask", source: "policy", reason },
    },
  };
}

let requests: ApprovalInboxData["requests"] = [];
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    _init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost",
    );
    if (url.pathname === "/api/approvals")
      return Response.json({
        enabled: true,
        requests,
        rules: [],
        teamRules: [],
        questions: [],
      });
    if (url.pathname === "/api/me")
      return Response.json({
        user: { id: "me", role: "user", email: "me@example.test" },
      });
    if (url.pathname === "/api/agents")
      return Response.json({
        agents: [{ id: ADA, name: "Ada", avatarSeed: ADA }],
      });
    if (url.pathname === "/api/computers/host-access")
      return Response.json({ folders: [] });
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  requests = [];
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function inbox(focus?: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ApprovalInbox focus={focus} waitingOnly />
    </QueryClientProvider>,
  );
}

test("the approval a line linked here for is marked as the one to decide", async () => {
  requests = [
    waiting("approval-first", "First, unrelated"),
    waiting("approval-target", "The one"),
  ];
  const { container } = inbox("approval-target");
  await waitFor(() => {
    expect(container.querySelectorAll("[data-focus]")).toHaveLength(1);
  });
  expect(container.querySelector("[data-focus]")?.id).toBe(
    "approval-approval-target",
  );
});

test("without an id nothing is marked", async () => {
  requests = [waiting("approval-first", "First")];
  const { container } = inbox();
  await waitFor(() => {
    expect(container.querySelector("#approval-approval-first")).not.toBeNull();
  });
  expect(container.querySelector("[data-focus]")).toBeNull();
});

test("an id naming nothing waiting marks no other row", async () => {
  // Decided since the line was read, or never this person's to decide: the page still lists what
  // waits, and points at none of it as the arrival.
  requests = [waiting("approval-first", "First")];
  const { container } = inbox("approval-gone");
  await waitFor(() => {
    expect(container.querySelector("#approval-approval-first")).not.toBeNull();
  });
  expect(container.querySelector("[data-focus]")).toBeNull();
});
