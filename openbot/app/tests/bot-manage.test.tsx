import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ManageSection } from "@/components/bot-profile/manage";
import type { AgentProfile } from "@/lib/agents/queries";
import type { ResetPlan } from "@/lib/bot-lifecycle/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * What can be done to a Bot from its own page. Navigation is the page's, so the section reports
 * where to go through callbacks, and these tests assert on those.
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

const BOT: AgentProfile = {
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Review receipts.",
  avatarSeed: "expenses",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

const requests: string[] = [];
function serving() {
  requests.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (String(input).endsWith("/duplicate")) {
      return Response.json({ agent: { ...BOT, id: "expenses-copy" } });
    }
    return Response.json({ agent: BOT });
  }) as unknown as typeof fetch;
}

function draw(
  agent: AgentProfile,
  handlers: {
    onHidden?: () => void;
    onDuplicated?: (copyId: string) => void;
    onDeleted?: () => void;
  } = {},
  edition?: "team" | "personal",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (edition) {
    client.setQueryData(deploymentKeys.capabilities(), {
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: edition === "personal",
      edition,
    });
  }
  return render(
    <QueryClientProvider client={client}>
      <ManageSection
        agent={agent}
        onDeleted={handlers.onDeleted ?? (() => {})}
        onDuplicated={handlers.onDuplicated ?? (() => {})}
        onHidden={handlers.onHidden ?? (() => {})}
      />
    </QueryClientProvider>,
  );
}

test("someone who cannot manage the Bot is not offered Delete", () => {
  const view = draw({ ...BOT, canManage: false, mine: false });
  expect(view.queryByText("删除")).toBeNull();
  expect(view.getByText("复制")).toBeTruthy();
});

test("hiding a Bot takes the person back to the roster", async () => {
  serving();
  const onHidden = mock(() => {});
  const view = draw(BOT, { onHidden });
  fireEvent.click(view.getByRole("switch", { name: "隐藏" }));
  await waitFor(() => expect(onHidden).toHaveBeenCalledTimes(1));
});

test("unhiding a hidden Bot keeps the person on its page", async () => {
  serving();
  const onHidden = mock(() => {});
  const view = draw({ ...BOT, hidden: true }, { onHidden });
  fireEvent.click(view.getByRole("switch", { name: "隐藏" }));
  await waitFor(() =>
    expect(requests.some((request) => request.startsWith("POST"))).toBe(true),
  );
  // Let the mutation settle before asserting nothing navigated.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(onHidden).not.toHaveBeenCalled();
});

test("duplicating opens the copy", async () => {
  serving();
  const onDuplicated = mock((_copyId: string) => {});
  const view = draw(BOT, { onDuplicated });
  fireEvent.click(view.getByRole("button", { name: /复制/ }));
  await waitFor(() =>
    expect(onDuplicated).toHaveBeenCalledWith("expenses-copy"),
  );
});

test("a Bot an admin assigned to you reads as pinned and cannot be hidden or unpinned", () => {
  const view = draw({
    ...BOT,
    mine: false,
    canManage: false,
    assignedToMe: true,
  });
  const pinned = view.getByRole("switch", { name: "置顶" });
  const hidden = view.getByRole("switch", { name: "隐藏" });
  expect(pinned.getAttribute("aria-checked")).toBe("true");
  expect(
    pinned.hasAttribute("disabled") ||
      pinned.getAttribute("aria-disabled") === "true",
  ).toBe(true);
  expect(
    hidden.hasAttribute("disabled") ||
      hidden.getAttribute("aria-disabled") === "true",
  ).toBe(true);
  expect(
    view.getAllByText(/管理员把它分配给了你/).length,
  ).toBeGreaterThan(0);
});

test("rows that open a dialog show a chevron, and Duplicate, which acts at once, does not", () => {
  const view = draw(BOT);
  const chevron = (name: RegExp) =>
    view
      .getByRole("button", { name })
      .querySelector(".tabler-icon-chevron-right");
  expect(chevron(/^重置/)).not.toBeNull();
  expect(chevron(/^删除/)).not.toBeNull();
  expect(chevron(/^复制/)).toBeNull();
});

/** A reset plan with a conversation to delete, so the notice lists something. */
function servingResetPlan() {
  const plan: ResetPlan = {
    conversations: 1,
    sharedConversationsKept: 0,
    memorySources: 0,
    memories: 0,
    routines: 0,
    responsibilities: 0,
    followUps: 0,
    formedMemories: 0,
    backgroundResearch: 0,
    standingApprovals: 0,
  };
  global.fetch = (async () =>
    Response.json({ plan })) as unknown as typeof fetch;
}

/*
 * The personal edition has no memory (see `offersMemory`), so Reset promises none: neither the row
 * nor the notice it opens says the Bot remembers anything for you.
 */
test("Reset promises no memory in the personal edition", async () => {
  servingResetPlan();
  const view = draw(BOT, {}, "personal");
  const row = view.getByRole("button", { name: /^重置/ });
  expect(row.textContent).toContain(
    "删除你和它的对话和它排期的工作。",
  );
  expect(row.textContent).not.toMatch(/记住|记忆/);
  fireEvent.click(row);
  expect(await view.findByText("1 段对话")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/记住|记忆/);
});

test("Reset still names what a Bot remembers for you in the team edition", async () => {
  servingResetPlan();
  const view = draw(BOT, {}, "team");
  const row = view.getByRole("button", { name: /^重置/ });
  expect(row.textContent).toContain("它为你记住的东西");
  fireEvent.click(row);
  expect(await view.findByText("1 段对话")).toBeTruthy();
  expect(
    view.getByText("你自己的记忆——你直接告诉员工的那些——会保留。"),
  ).toBeTruthy();
});

/*
 * The personal edition has one person. Nobody else has a Bots list for "only your list" to set
 * apart, and nobody else for "everyone" to mean. Its Delete says what's true for them: the Bot goes,
 * and its conversations stay readable (channel-chat.tsx: "You can still read this conversation").
 */
test("the personal edition's rows say nothing about other people", async () => {
  const view = draw(BOT, {}, "personal");
  const text = () => document.body.textContent ?? "";
  expect(view.getByText("让它一直在你的员工列表顶部。")).toBeTruthy();
  expect(view.getByText("从你的员工列表里拿掉。")).toBeTruthy();
  const remove = view.getByRole("button", { name: /^删除/ });
  expect(remove.textContent).toContain(
    "删除它。你仍然可以查看和它的对话。删除后无法撤销。",
  );
  expect(text()).not.toMatch(/只改你自己的列表|所有人/);
  fireEvent.click(remove);
  expect(
    await view.findByText(
      "你仍然可以查看和它的对话，但它不会再回复。删除后无法撤销。",
    ),
  ).toBeTruthy();
  expect(text()).not.toMatch(/所有人|别人|其他人/);
});

test("the personal edition's Reset notice doesn't mention other people's data", async () => {
  servingResetPlan();
  const view = draw(BOT, {}, "personal");
  fireEvent.click(view.getByRole("button", { name: /^重置/ }));
  expect(
    await view.findByText(
      "这会删除 Expenses 与你之间的东西。删除后无法撤销。",
    ),
  ).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/别人|其他人/);
});

test("a hidden or pinned Bot in the personal edition says where it is, and no more", () => {
  const view = draw({ ...BOT, hidden: true, pinned: true }, {}, "personal");
  expect(view.getByText("在你的员工列表顶部。")).toBeTruthy();
  expect(view.getByText("在你员工列表的「已隐藏」里。")).toBeTruthy();
});

test("a team deployment keeps saying whose list changes and who a delete reaches", async () => {
  servingResetPlan();
  const view = draw(BOT, {}, "team");
  expect(
    view.getByText(
      "让它一直在你的员工列表顶部。只改你自己的列表。",
    ),
  ).toBeTruthy();
  expect(
    view.getByText("从你的员工列表里拿掉。只改你自己的列表。"),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: /^删除/ }).textContent).toContain(
    "对所有人删除它。删除后无法撤销。",
  );
  fireEvent.click(view.getByRole("button", { name: /^重置/ }));
  expect(
    await view.findByText(
      "这会删除 Expenses 与你之间的东西，只限于你。别人的对话和数据不会被碰。删除后无法撤销。",
    ),
  ).toBeTruthy();
});
