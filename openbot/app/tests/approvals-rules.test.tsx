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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalInbox } from "@/components/approvals/inbox";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { toVisibleChatItems } from "@/components/channels/chat-messages";
import {
  groupToolSteps,
  ToolActivity,
} from "@/components/channels/tool-activity";
import { offersStandingRule, POLICY_SOURCE_LABELS } from "@/lib/approvals";

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

function draw() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ApprovalInbox />
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
    name: "「mcp/gmail/*」的处理方式",
  }) as HTMLSelectElement;
  expect(mine.value).toBe("allow");
  expect(view.getByText("已锁定")).toBeTruthy();
  const review = view.getByRole("switch", { name: "自动审查" });
  expect(review.getAttribute("aria-checked")).toBe("true");
  expect(view.getByText(/团队要求开启/)).toBeTruthy();
  expect(view.getByText(/团队把这一项限定为「每次都问」/)).toBeTruthy();
  expect(view.queryByText("团队设置")).toBeNull();
});

test("a member changes a saved rule in place", async () => {
  const view = draw();
  const mine = await view.findByRole("combobox", {
    name: "「mcp/gmail/*」的处理方式",
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
    view.queryByRole("combobox", { name: "「mcp/drive/share」的处理方式" }),
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
  await view.findByRole("region", { name: "等你批准" });
  expect(view.getByText("Click on shop.example")).toBeTruthy();
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
    const toggle = await view.findByRole("switch", {
      name: "强制危险命令审批",
    });
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
    // 对话里的卡片是一张决策卡：选项是单选，发送按钮写着选中的那一项（默认第一项）。
    expect(inline.getByRole("button", { name: "允许一次" })).toBeTruthy();
    expect(inline.getByRole("radio", { name: /拒绝/ })).toBeTruthy();
    expect(inline.queryByRole("radio", { name: /在这里总是允许/ })).toBeNull();
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
