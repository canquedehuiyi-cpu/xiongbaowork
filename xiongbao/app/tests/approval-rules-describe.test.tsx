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
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  backtestHeadline,
  replayWords,
} from "@/components/approvals/describe-rules";
import type {
  ApprovalBacktest,
  ApprovalRulesPreview,
} from "@/lib/approval-rules/queries";
import type { ApprovalRuleTranslation } from "@/lib/approval-rules/translate";
import type { ApprovalRuleInput } from "@/lib/approvals";
import { Route as DescribeRoute } from "@/routes/_authed/admin/approvals_.describe";

/**
 * Team approval rules described in English, on Admin → Approvals → Describe it in words: the model's
 * rules land as fields the admin can change, beside their independent reading and whether they
 * check; what they would have changed is replayed as they are edited; and only Save adds them, with
 * the sentence. The server is a fake that answers as the real routes do.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

const SALES = "agent_5e2f8a90-1c3b-4d6e-8f70-a1b2c3d4e5f6";

/** What the real endpoint answered for this description, through the real screen. */
const OPPORTUNITIES: ApprovalRuleTranslation = {
  rules: [
    {
      toolRef: "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY*",
      effect: "write",
      scope: "composio-salesforce",
      botId: SALES,
      behaviour: "allow",
    },
  ],
  summary:
    "The Sales Assistant updates Salesforce opportunities without asking.",
  explanation:
    "The Sales Assistant updates Salesforce opportunities with the two listed opportunity-update tools without asking.",
  check: { ok: true },
  warning: null,
};

const REPORT: ApprovalBacktest = {
  scanned: 22,
  matched: 4,
  changed: 4,
  removedAsks: 4,
  removedDenied: 1,
  addedAsks: 0,
  fixed: 0,
  changes: [
    {
      id: "audit-1",
      createdAt: "2026-11-09T21:16:20.000Z",
      ownerUserId: "user-ben",
      initiator: { kind: "person", id: null },
      bot: SALES,
      toolRef: "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY",
      effect: "write",
      scope: "composio-salesforce",
      subject: {},
      was: "ask",
      wasSource: "default",
      would: "allow",
      change: "removes_ask",
      person: "deny",
      rule: 1,
      reason: "Rule 1 takes action without asking.",
    },
  ],
};

const sent: { path: string; body: Record<string, unknown> }[] = [];
const originalFetch = global.fetch;

/** The check the real backtest route makes of rows as they stand. */
function checked(rules: ApprovalRuleInput[]): ApprovalRulesPreview {
  const bad = rules.findIndex((rule) => rule.toolRef.startsWith("mcp/"));
  return {
    check:
      bad === -1
        ? { ok: true }
        : {
            ok: false,
            error: "no tool here starts with mcp/",
            problems: [
              {
                row: bad + 1,
                field: "toolRef",
                message: `"${rules[bad]?.toolRef}" matches no tool: no tool here starts with mcp/.`,
              },
            ],
          },
    warning: null,
    report:
      bad === -1
        ? REPORT
        : {
            ...REPORT,
            matched: 0,
            changed: 0,
            removedAsks: 0,
            removedDenied: 0,
            changes: [],
          },
  };
}

beforeEach(() => {
  sent.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === "POST") sent.push({ path, body });
    if (path.endsWith("/api/approvals/team/rules/translate"))
      return Response.json(OPPORTUNITIES);
    if (path.endsWith("/api/approvals/team/rules/backtest"))
      return Response.json(checked(body.rules));
    if (path.endsWith("/api/approvals/team/rules/batch"))
      return Response.json({ rules: body.rules }, { status: 201 });
    if (path.includes("/api/agents"))
      return Response.json({
        agents: [{ id: SALES, name: "Sales Assistant" }],
      });
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function open() {
  const root = createRootRoute({ component: Outlet });
  const approvals = createRoute({
    path: "/admin/approvals",
    getParentRoute: () => root,
    component: () => null,
  });
  const describe = (
    DescribeRoute as unknown as { update: (options: unknown) => never }
  ).update({
    id: "/admin/approvals_/describe",
    path: "/admin/approvals/describe",
    getParentRoute: () => root,
  });
  const router = createRouter({
    routeTree: root.addChildren([approvals, describe]),
    history: createMemoryHistory({
      initialEntries: ["/admin/approvals/describe"],
    }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

async function describeRules(view: ReturnType<typeof render>, text: string) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(await view.findByLabelText("描述这些规则"), text);
  await user.click(view.getByRole("button", { name: "写成规则" }));
}

const TEXT =
  "Let the sales assistant update opportunities in Salesforce without asking";

test("a description fills the rules, shows their reading and check, replays them, and Save adds them with the sentence", async () => {
  const { view, router } = open();
  await describeRules(view, TEXT);

  expect(
    await view.findByText(OPPORTUNITIES.explanation as string),
  ).toBeTruthy();
  expect(
    view.getByText("通过检查。每条规则都对得上这个部署里的工具和员工。"),
  ).toBeTruthy();
  // The rows, as fields that stay editable.
  expect((view.getByLabelText("工具或应用") as HTMLInputElement).value).toBe(
    "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY*",
  );
  // Replayed as soon as they rest, and the asks a person denied are counted.
  expect(
    await view.findByText(
      "会改变 4 个决定：少问 4 次，其中 1 次有人拒绝过；多问 0 次。",
    ),
  ).toBeTruthy();
  expect(view.getByText("有人拒绝了。")).toBeTruthy();
  expect(sent.filter((call) => call.path.endsWith("/batch"))).toHaveLength(0);

  const save = view.getByRole("button", { name: "保存规则" });
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(save);
  await waitFor(() =>
    expect(sent.filter((call) => call.path.endsWith("/batch"))).toHaveLength(1),
  );
  expect(sent.find((call) => call.path.endsWith("/batch"))?.body).toEqual({
    rules: OPPORTUNITIES.rules,
    authoring: { source: "english", text: TEXT },
  });
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/admin/approvals"),
  );
});

test("an edit after the rules were written is called out, checked as it stands, and can't be saved until it checks", async () => {
  const { view } = open();
  await describeRules(view, TEXT);
  await view.findByText(OPPORTUNITIES.explanation as string);
  expect(view.queryByText(/写好之后你改过这些规则/)).toBeNull();

  const user = userEvent.setup({ document: view.container.ownerDocument });
  const tool = view.getByLabelText("工具或应用") as HTMLInputElement;
  await user.clear(tool);
  await user.type(tool, "mcp/salesforce/*");

  expect(
    view.getByText(
      "写好之后你改过这些规则。上面的检查和解读说的是写出来的规则，不是你改过的版本。",
    ),
  ).toBeTruthy();
  // The live check says what is wrong with the edit, under the field.
  expect(
    await view.findByText(
      '"mcp/salesforce/*" matches no tool: no tool here starts with mcp/.',
    ),
  ).toBeTruthy();
  expect(
    (view.getByRole("button", { name: "保存规则" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);

  // Put right, it checks again and can be saved, still from the sentence.
  await user.clear(tool);
  await user.type(tool, "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY");
  await waitFor(() =>
    expect(
      (view.getByRole("button", { name: "保存规则" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});

test("the headline counts what changed and never what a safety requirement decided", () => {
  expect(backtestHeadline(REPORT)).toBe(
    "会改变 4 个决定：少问 4 次，其中 1 次有人拒绝过；多问 0 次。",
  );
  const none = {
    ...REPORT,
    changed: 0,
    removedAsks: 0,
    removedDenied: 0,
    matched: 2,
    fixed: 2,
  };
  expect(backtestHeadline(none)).toBe("不会改变任何决定。");
  expect(replayWords(none, true)).toBe(
    "用熊宝最近检查过的 22 个动作重放了一遍。这些规则涉及其中 2 个。其中 2 个由安全要求、自动审核或任务决定，规则改变不了。没经过检查就执行的动作不会被记录，所以新的「先问」可能比这里显示的管得更多。",
  );
});
