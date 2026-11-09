import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalInbox } from "@/components/approvals/inbox";
=======
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
import { InlineApproval } from "@/components/approvals/inline-approval";
import { ApprovalSettings } from "@/components/approvals/settings";
import { toVisibleChatItems } from "@/components/channels/chat-messages";
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
import { offersStandingRule, POLICY_SOURCE_LABELS } from "@/lib/approvals";
=======
import {
  groupToolSteps,
  ToolActivity,
} from "@/components/channels/tool-activity";
import { TeamBotConsents } from "@/components/settings/team-bot-consents";
import { deploymentKeys } from "@/lib/deployment/queries";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let role: "user" | "admin" = "user";
const sent: { path: string; method: string; body: unknown }[] = [];

const inbox = {
  enabled: false,
  requests: [
    {
      id: "request-1",
      status: "pending",
      createdAt: new Date().toISOString(),
      action: {
        botId: "Shopper",
        toolRef: "computer_click",
        effect: "write",
        scope: "shop.example",
        threadId: "thread",
        args: { element: "Pay now" },
        target: {},
        toolCallId: "pay-call",
        policy: {
          behaviour: "hand_off",
          source: "safety",
          reason:
            "Paying, purchasing or moving money is always done by the person.",
        },
      },
    },
  ],
  rules: [
    {
      id: "mine",
      botId: "*",
      toolRef: "mcp/gmail/*",
      effect: "*",
      scope: "*",
      behaviour: "allow",
    },
  ],
  teamRules: [
    {
      id: "locked",
      botId: "*",
      toolRef: "mcp/drive/share",
      effect: "*",
      scope: "*",
      behaviour: "ask",
    },
  ],
  preferences: { enabled: false, autoReview: false, hostCommands: "allow" },
  team: {
    enforceAutoReview: true,
    customRulesEnabled: true,
    hostCommandsCap: "ask",
    enforceDangerousCommands: false,
  },
  hostCommands: "ask",
  questions: [],
};

beforeEach(() => {
  sent.length = 0;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (init?.method && init.method !== "GET") {
        sent.push({
          path: url,
          method: init.method,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ ok: true });
      }
      if (url === "/api/approvals") return Response.json(inbox);
      if (url === "/api/me")
        return Response.json({
          user: { id: "me", email: "me@example.test", role },
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
function draw() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ApprovalInbox />
=======
/** A screen in a router of one route, for the links it holds. */
function draw(
  screen: ReactNode = <ApprovalSettings />,
  edition: "team" | "personal" = "team",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), { edition });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => screen }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
    </QueryClientProvider>,
  );
}

test("a hand-off is marked done by the person, never allowed on their behalf", async () => {
  const view = draw();
  await view.findByText(/交给你：Paying/);
  expect(view.queryByRole("button", { name: "允许一次" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "我自己做了" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/request-1/decision",
      method: "POST",
      body: { decision: "handled" },
    }),
  );
});

test("team rules are locked for members, enforced auto-review is shown as required, and the host cap is named", async () => {
  const view = draw();
  await view.findByText("做之前先问（团队规则）");
  const mine = view.getByRole("combobox", {
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
    name: "「mcp/gmail/*」的处理方式",
  }) as HTMLSelectElement;
  expect(mine.value).toBe("allow");
  expect(view.getByText("已锁定")).toBeTruthy();
  const review = view.getByRole("switch", { name: "自动审查" });
  expect(review.getAttribute("aria-checked")).toBe("true");
  expect(view.getByText(/团队要求开启/)).toBeTruthy();
  expect(view.getByText(/团队把这一项限定为「每次都问」/)).toBeTruthy();
  expect(view.queryByText("团队设置")).toBeNull();
=======
    name: "Behaviour for Any action on Gmail",
  });
  expect(mine.textContent).toContain("Take action without asking");
  expect(view.getByText("Locked")).toBeTruthy();
  const review = view.getByRole("switch", { name: "Auto-review" });
  expect(review.getAttribute("aria-checked")).toBe("true");
  expect(view.getByText(/An admin requires this/)).toBeTruthy();
  expect(
    view.getByText(/An admin limits this to "Ask every time"/),
  ).toBeTruthy();
  expect(view.queryByText("Team settings")).toBeNull();
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
});

test("a member changes a saved rule in place", async () => {
  const view = draw();
  const mine = await view.findByRole("combobox", {
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
    name: "「mcp/gmail/*」的处理方式",
=======
    name: "Behaviour for Any action on Gmail",
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  });
  fireEvent.change(mine, { target: { value: "hand_off" } });
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/rules/mine",
      method: "PATCH",
      body: { behaviour: "hand_off" },
    }),
  );
  expect(
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
    view.queryByRole("combobox", { name: "「mcp/drive/share」的处理方式" }),
=======
    view.queryByRole("combobox", { name: "Behaviour for Share on Drive" }),
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  ).toBeNull();
});

test("a member adds a rule with one of the four behaviours", async () => {
  const view = draw();
  await view.findByText("添加规则");
  const user = userEvent.setup({ document });
  await user.type(
    view.getByRole("textbox", { name: "工具或应用" }),
    "mcp/slack/*",
  );
  fireEvent.change(
    view.getAllByRole("combobox", { name: "处理方式" })[0] as HTMLElement,
    {
      target: { value: "pre_approved" },
    },
  );
  const save = view.getByRole("button", { name: "保存规则" });
  fireEvent.submit(save.closest("form") as HTMLFormElement);
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/rules",
      method: "POST",
      body: {
        botId: "*",
        toolRef: "mcp/slack/*",
        effect: "*",
        scope: "*",
        behaviour: "pre_approved",
      },
    }),
  );
});

<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
test("an administrator sets the team-wide controls", async () => {
  role = "admin";
  try {
    const view = draw();
    await view.findByText("团队设置");
    fireEvent.change(
      view.getByRole("combobox", {
        name: "成员电脑上执行命令的上限",
      }),
      { target: { value: "never" } },
    );
    await waitFor(() =>
      expect(sent).toContainEqual({
        path: "/api/approvals/team",
        method: "PATCH",
        body: { hostCommandsCap: "never" },
      }),
    );
    expect(view.getAllByRole("button", { name: "移除" }).length).toBe(2);
  } finally {
    role = "user";
  }
=======
test("a rule that is not saved keeps the dialog open, with what was typed and why", async () => {
  refuseRule = "That tool is not one a Bot can use.";
  const view = draw(<ApprovalSettings />);
  await view.findByText("Add a rule");
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /Add a rule/ }));
  await user.type(
    await view.findByRole("textbox", { name: "Tool or app" }),
    "mcp/nowhere/*",
  );
  await user.click(view.getByRole("button", { name: "Save rule" }));
  const dialog = await view.findByRole("dialog");
  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "That tool is not one a Bot can use.",
  );
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "Tool or app",
      }) as HTMLInputElement
    ).value,
  ).toBe("mcp/nowhere/*");
  // Saved the second time, the dialog closes.
  await user.click(within(dialog).getByRole("button", { name: "Save rule" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(
    sent.filter((request) => request.path === "/api/approvals/rules"),
  ).toHaveLength(2);
});

test("two rules for one tool are told apart by the rest of what they match, never cut short", async () => {
  inboxOverride = {
    rules: [
      {
        id: "anywhere",
        botId: "*",
        toolRef: "computer_click",
        effect: "*",
        scope: "*",
        behaviour: "ask",
      },
      {
        id: "one-site",
        botId: "*",
        toolRef: "computer_click",
        effect: "write",
        scope: "checkout.a-very-long-shop-name.example",
        behaviour: "allow",
      },
    ],
  };
  const view = draw(<ApprovalSettings />);
  const match = await view.findByText(
    "changes on checkout.a-very-long-shop-name.example",
  );
  expect(match.className).toContain("line-clamp-none");
  // The action, in its approval card's words, stays the row's title.
  expect(view.getAllByText("Click")).toHaveLength(2);
});

test("with personal rules switched off by the team, they are shown as not applying and none can be added", async () => {
  inboxOverride = {
    team: { ...inbox.team, customRulesEnabled: false },
  };
  const view = draw(<ApprovalSettings />);
  expect(
    await view.findByText(
      /An admin has turned off personal rules\. Yours are kept but don't apply\./,
    ),
  ).toBeTruthy();
  expect(view.queryByText("Add a rule")).toBeNull();
});

test("an administrator is told where team settings are", async () => {
  role = "admin";
  const view = draw(<ApprovalSettings />);
  const link = await view.findByRole("link", { name: "Admin → Approvals" });
  expect(link.getAttribute("href")).toBe("/admin/approvals");
});

test("the personal edition's one person is not pointed at an Admin it does not have", async () => {
  role = "admin";
  const served = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(path) === "/api/capabilities"
        ? Response.json({ edition: "personal" })
        : served(path, init),
    { preconnect: originalFetch.preconnect },
  );
  const view = draw(<ApprovalSettings />, "personal");
  await view.findByText("Rules for every Bot");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.queryByRole("link", { name: "Admin → Approvals" })).toBeNull();
});

test("a member is not pointed at Admin", async () => {
  const view = draw(<ApprovalSettings />);
  await view.findByText("Rules for every Bot");
  expect(view.queryByRole("link", { name: "Admin → Approvals" })).toBeNull();
});

test("rules for every Bot point to where rules for a single Bot are", async () => {
  inboxOverride = {
    rules: [
      ...inbox.rules,
      {
        id: "one-bot",
        botId: "shopper-bot",
        toolRef: "computer_click",
        effect: "*",
        scope: "*",
        behaviour: "ask",
      },
    ],
  };
  const view = draw(<ApprovalSettings />);
  const link = await view.findByRole("link", { name: "that Bot's page" });
  expect(link.getAttribute("href")).toBe("/bots");
  // A rule naming one Bot lives on that Bot's page, not here.
  expect(
    view.queryByRole("combobox", { name: "Behaviour for Click" }),
  ).toBeNull();
});

test("a rule naming no Bot this person can open is listed so it can be removed", async () => {
  inboxOverride = {
    rules: [
      ...inbox.rules,
      {
        id: "orphan",
        botId: "Shopper",
        toolRef: "computer_click",
        effect: "*",
        scope: "*",
        behaviour: "allow",
      },
    ],
  };
  const view = draw(<ApprovalSettings />);
  expect(await view.findByText("Rules for other Bots")).toBeTruthy();
  expect(
    view.getByRole("combobox", { name: "Behaviour for Click" }),
  ).toBeTruthy();
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
});

test("a pending change is drawn in the conversation where the action was, and decided there", async () => {
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <InlineApproval toolCallId="pay-call" fallback={<p>Clicked on page</p>} />
      <InlineApproval
        toolCallId="other-call"
        fallback={<p>Filled in field</p>}
      />
    </QueryClientProvider>,
  );
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
  await view.findByRole("region", { name: "等你批准" });
  expect(view.getByText(/需要你来做：click，目标 shop\.example/)).toBeTruthy();
=======
  await view.findByRole("region", { name: "Waiting for your approval" });
  expect(view.getByText("Click on shop.example")).toBeTruthy();
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  // Another call's line is left to its own renderer.
  expect(view.getByText("Filled in field")).toBeTruthy();
  expect(view.queryByText("Clicked on page")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "我自己做了" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/request-1/decision",
      method: "POST",
      body: { decision: "handled" },
    }),
  );
});

test("in the real transcript shape a waiting click is folded into browser activity, so its card is drawn beside the group", async () => {
  // What the channel transcript builds from the conversation: a navigate that finished and the
  // click the chat stopped on, unanswered, grouped into one browser-activity line.
  const items = groupToolSteps(
    toVisibleChatItems([
      { id: "u1", role: "user", content: "Order a pizza on httpbin" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "nav-call",
            type: "function",
            function: {
              name: "computer_navigate",
              arguments: '{"url":"https://httpbin.org/forms/post"}',
            },
          },
          {
            id: "pay-call",
            type: "function",
            function: {
              name: "computer_click",
              arguments: '{"ref":"e7","snapshotId":3}',
            },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "nav-call",
        content: '{"ok":true,"url":"https://httpbin.org/forms/post"}',
      },
    ] as never),
    // Browser steps fold whatever the app draws, so nothing else needs naming here.
    () => false,
  );
  const group = items.find((item) => item.kind === "tools");
  if (group?.kind !== "tools") throw new Error("no tool group");
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {/* ToolActivity mounts the waiting cards beside its folded line itself. */}
      <ToolActivity group={group} active={false} />
    </QueryClientProvider>,
  );
  await view.findByRole("region", { name: "等你批准" });
  // Only the waiting call gets a card; the finished navigate does not.
  expect(view.getAllByRole("region", { name: "等你批准" })).toHaveLength(1);
  expect(view.getByRole("button", { name: "我自己做了" })).toBeTruthy();
});

/** A change the Bot's owner asked to be asked about (SEC1 D9), added for the one test below. */
const ownerAsked = {
      id: "request-2",
      status: "pending",
      createdAt: new Date().toISOString(),
      action: {
        botId: "Desk",
        toolRef: "computer_run_command",
        effect: "write",
        scope: "workspace",
        threadId: "thread",
        args: { command: "rm -rf build" },
        target: {},
        toolCallId: "rm-call",
        policy: {
          behaviour: "ask",
          source: "owner_rule",
          reason: "A rule asks before this kind of action.",
        },
      },
    };

test("a sensitive-window request names its source 敏感窗口", async () => {
  const asked = {
    ...ownerAsked,
    id: "request-desktop",
    action: {
      ...ownerAsked.action,
      toolRef: "computer_desktop_snapshot",
      effect: "read",
      scope: "desktop/chrome",
      args: {},
      toolCallId: "desktop-call",
      policy: {
        behaviour: "ask",
        source: "desktop_window",
        reason: "窗口「招商银行」的标题含「银行」，读取它之前需要你批准。",
      },
    },
  };
  inbox.requests.push(asked as unknown as (typeof inbox.requests)[number]);
  try {
    const view = draw();
    expect(await view.findByText(/（来源：敏感窗口）/)).toBeTruthy();
  } finally {
    inbox.requests.pop();
  }
});

test("SEC1: 禁用 is shown as its own behaviour, and a request set by the Bot's owner names that layer", async () => {
  inbox.requests.push(ownerAsked as unknown as (typeof inbox.requests)[number]);
  inbox.teamRules.unshift({
    id: "locked-off",
    botId: "*",
    toolRef: "host/*",
    effect: "*",
    scope: "*",
    behaviour: "deny",
  });
  try {
    await ownerLayerShown();
  } finally {
    inbox.requests.pop();
    inbox.teamRules.shift();
  }
});
async function ownerLayerShown() {
  const view = draw();
  await view.findByText("禁用（团队规则）");
  expect(view.getByText(/（来源：员工所有者设定）/)).toBeTruthy();
  // A member can choose 禁用 for a rule of their own.
  const mine = view.getByRole("combobox", {
    name: "「mcp/gmail/*」的处理方式",
  });
  fireEvent.change(mine, { target: { value: "deny" } });
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/rules/mine",
      method: "PATCH",
      body: { behaviour: "deny" },
    }),
  );
  expect(view.queryByText("强制危险命令审批")).toBeNull();
}

test("SEC1: only an administrator sees and sets the team's 强制危险命令审批 switch (D10)", async () => {
  role = "admin";
  try {
    const view = draw();
    const toggle = await view.findByRole("switch", { name: "强制危险命令审批" });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(sent).toContainEqual({
        path: "/api/approvals/team",
        method: "PATCH",
        body: { enforceDangerousCommands: true },
      }),
    );
  } finally {
    role = "user";
  }
});

test("删除类底线问的动作只给「允许一次 / 拒绝」，收件箱和对话里都不画「在这里总是允许」", async () => {
  const deleting = {
    ...ownerAsked,
    id: "request-archive",
    action: {
      ...ownerAsked.action,
      toolRef: "hubspot/HUBSPOT_ARCHIVE_CONTACT",
      scope: "hubspot",
      args: { contactId: "42" },
      toolCallId: "archive-call",
      policy: {
        behaviour: "ask",
        source: "destructive_tool",
        reason: "这个操作会删除或覆盖内容，总是先征得你同意。",
      },
    },
  };
  // The other pending request is a hand-off, so every 允许一次 drawn here is the deleting one's.
  inbox.requests.push(deleting as unknown as (typeof inbox.requests)[number]);
  try {
    const view = draw();
    await view.findByText(/这个操作会删除或覆盖内容/);
    expect(view.getByText(/（来源：删除类操作）/)).toBeTruthy();
    expect(view.getAllByRole("button", { name: "允许一次" })).toHaveLength(1);
    expect(view.queryByRole("button", { name: "在这里总是允许" })).toBeNull();
    cleanup();

    const inline = render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <InlineApproval toolCallId="archive-call" fallback={<p>Archived</p>} />
      </QueryClientProvider>,
    );
    await inline.findByRole("region", { name: "等你批准" });
    expect(inline.getByRole("button", { name: "允许一次" })).toBeTruthy();
    expect(inline.getByRole("button", { name: "拒绝" })).toBeTruthy();
    expect(inline.queryByRole("button", { name: "在这里总是允许" })).toBeNull();
    fireEvent.click(inline.getByRole("button", { name: "允许一次" }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        path: "/api/approvals/request-archive/decision",
        method: "POST",
        body: { decision: "allow_once" },
      }),
    );
  } finally {
    inbox.requests.pop();
  }
});

test("对外发送底线问的动作同样只给「允许一次 / 拒绝」，来源写成「对外发送」", async () => {
  const sending = {
    ...ownerAsked,
    id: "request-send",
    action: {
      ...ownerAsked.action,
      toolRef: "composio-gmail/GMAIL_SEND_EMAIL",
      scope: "composio-gmail",
      args: { to: "client@example.com" },
      toolCallId: "send-call",
      policy: {
        behaviour: "ask",
        source: "outbound_send",
        reason: "这个操作可能会把内容发给别人，总是先征得你同意。",
      },
    },
  };
  inbox.requests.push(sending as unknown as (typeof inbox.requests)[number]);
  try {
    const view = draw();
    await view.findByText(/这个操作可能会把内容发给别人/);
    expect(view.getByText(/（来源：对外发送）/)).toBeTruthy();
    expect(view.getAllByRole("button", { name: "允许一次" })).toHaveLength(1);
    expect(view.queryByRole("button", { name: "在这里总是允许" })).toBeNull();
    cleanup();

    const inline = render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <InlineApproval toolCallId="send-call" fallback={<p>Sent</p>} />
      </QueryClientProvider>,
    );
    await inline.findByRole("region", { name: "等你批准" });
    expect(inline.getByRole("button", { name: "允许一次" })).toBeTruthy();
    expect(inline.queryByRole("button", { name: "在这里总是允许" })).toBeNull();
  } finally {
    inbox.requests.pop();
  }
});

test("分享与公开发布底线同样只给「允许一次」，来源有中文名字", () => {
  expect(POLICY_SOURCE_LABELS.share_access).toBe("分享与授权");
  expect(POLICY_SOURCE_LABELS.publish_post).toBe("公开发布");
  for (const source of [
    "destructive_tool",
    "outbound_send",
    "share_access",
    "publish_post",
  ])
    expect(offersStandingRule({ source })).toBeFalse();
  expect(offersStandingRule({ source: "default" })).toBeTrue();
  expect(offersStandingRule(undefined)).toBeTrue();
});

test("personal approvals keep the person's controls without team-only explanations or shared Bots", async () => {
  inboxOverride = {
    teamRules: [],
    team: { enforceAutoReview: false, customRulesEnabled: true },
    hostCommands: "allow",
  };
  const view = draw(
    <>
      <ApprovalSettings />
      <TeamBotConsents />
    </>,
    "personal",
  );
  await view.findByText("Rules for every Bot");
  expect(view.queryByText(/Team rules are locked/)).toBeNull();
  expect(view.queryByText("Shared Bots")).toBeNull();
  expect(
    view.getByRole("switch", { name: "Always ask before making changes" }),
  ).toBeTruthy();
  expect(view.getByRole("switch", { name: "Auto-review" })).toBeTruthy();
});
test("team approvals still show the shared Bot account controls", async () => {
  const view = draw(<TeamBotConsents />);
  expect(await view.findByText("Shared Bots")).toBeTruthy();
  expect(view.getByRole("button", { name: "Reset" })).toBeTruthy();
});

/*
 * What always asks, said where the switches are, in the words onboarding uses, and only what is
 * true: a Bot deleting a file in its own workspace is an ordinary change
 * (server/src/approvals/policy.ts, NOT_ACCOUNT_ACTIONS), so the page must not promise that every
 * delete asks. The switch says it adds every change on top.
 */
test.each(["team", "personal"] as const)(
  "the %s edition says what always asks, and that a Bot's own workspace is left out of it",
  async (edition) => {
    inboxOverride = {
      teamRules: [],
      team: { enforceAutoReview: false, customRulesEnabled: true },
    };
    const view = draw(<ApprovalSettings />, edition);
    await view.findByText("Rules for every Bot");
    const said = view.container.textContent ?? "";
    for (const sentence of [
      "Bots always ask for your approval before deleting, sending, sharing, or posting content in your apps or on websites.",
      "They also ask before every edit or command in a folder on your own computer.",
      "Bots leave payments and account security changes for you to do yourself.",
      "Bots can create, edit, and delete files in their own workspace without asking, unless your settings or rules say so.",
      "Require your approval for every change to your apps, websites, and files, including routine edits and updates.",
    ])
      expect(said.replace(/\s+/g, " ")).toContain(sentence);
    expect(said).not.toContain(
      "Review a Bot's changes to websites, connected apps, and files.",
    );
  },
);

/*
 * FOUND IN THE 1.0 RC1 MAC PASS: a rule saved from an approval card's "Always allow here" was
 * titled by its tool id ("computer_click", "composio-gmail/GMAIL_SEND_EMAIL" over "on
 * composio-gmail"). It is titled in the words the card used for the same action.
 */
test("a saved rule is titled in its approval card's words, never by its tool id", async () => {
  inboxOverride = {
    rules: [
      {
        id: "click-here",
        botId: "*",
        toolRef: "computer_click",
        effect: "*",
        scope: "en.wikipedia.org",
        behaviour: "allow",
      },
      {
        id: "send-mail",
        botId: "*",
        toolRef: "composio-gmail/GMAIL_SEND_EMAIL",
        effect: "*",
        scope: "composio-gmail",
        behaviour: "allow",
      },
    ],
    teamRules: [],
  };
  const view = draw(<ApprovalSettings />);
  expect(
    await view.findByRole("combobox", { name: "Behaviour for Click" }),
  ).toBeTruthy();
  expect(view.getByText("Click")).toBeTruthy();
  expect(view.getByText("on en.wikipedia.org")).toBeTruthy();
  expect(view.getByText("Send email on Gmail")).toBeTruthy();
  const text = view.container.textContent ?? "";
  expect(text).not.toContain("computer_click");
  expect(text).not.toContain("composio");
  expect(text).not.toContain("GMAIL_SEND_EMAIL");
});
