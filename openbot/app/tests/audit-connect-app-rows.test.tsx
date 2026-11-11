import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { AuditPage } from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * Seen on Windows, personal edition: Gmail turned on and not connected, a Bot asked to check the
 * mail. The chat drew the Connect card, and Settings > Activity read "Fetch emails / Gmail /
 * Personal Assistant" with the Decision "The server didn't answer", followed by the refusal as the
 * Bot was given it: `[connect-app]{"serverId":"composio-gmail","title":"Gmail"} You have not
 * connected your Gmail account. Connect it and ask again.` The server had answered: not connected.
 */

/*
 * 熊宝版没有个人版的「活动」页：这里只测管理端的审计表（上游 `components/manage/audit-page.tsx`，
 * 待接入 /admin/audit），个人版专有的用例不收。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const BOT = "personal-assistant";
const REF = "composio-gmail/GMAIL_FETCH_EMAILS";

/** An `mcp.call_failed` row as `callTool` writes it when the call's credential was refused. */
function failedCall(id: string, minute: number, failure: string) {
  return {
    id,
    actorUserId: "dev-local-user",
    initiatorKind: "person",
    initiatorId: null,
    eventType: "mcp.call_failed",
    targetType: "mcp_tool",
    targetId: REF,
    payload: {
      actor: "dev-local-user",
      bot: BOT,
      server: "composio-gmail",
      tool: "GMAIL_FETCH_EMAILS",
      effect: "read",
      reachedAs: "dev-local-user",
      decision: {
        allowed: true,
        mode: "enforce",
        rule: null,
        source: "default",
        carriedOut: true,
      },
      failure,
    },
    createdAt: `2026-11-08T18:${String(minute).padStart(2, "0")}:00Z`,
  };
}

/** The row as it was stored on the Windows install, character for character. */
const STORED_BEFORE = failedCall(
  "before",
  2,
  '[connect-app]{"serverId":"composio-gmail","title":"Gmail"} You have not connected your Gmail account. Connect it and ask again.',
);

async function renderPage(audit: Record<string, unknown[]>) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  for (const [search, events] of Object.entries(audit))
    seedAuditPage(queryClient, search, { events });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: BOT, name: "Personal Assistant" },
  ]);
  queryClient.setQueryData(agentKeys.list(true), []);
  const router = createRouter({
    // Admin › 审计 renders the page with `ask`, which is what puts 「为什么？」 on a row.
    routeTree: createRootRoute({ component: () => <AuditPage ask /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByText("结果");
  return view;
}

const lines = (cell: Element | null) =>
  [...(cell?.children ?? [])].map((line) => line.textContent);

function drawn(container: HTMLElement) {
  return [...container.querySelectorAll("tbody tr")].map((tr) => ({
    what: lines(tr.querySelector("[data-column=what]")),
    decision: lines(tr.querySelector("[data-column=decision]")),
  }));
}

test("Admin reads the refusal's own sentence, without the marker", async () => {
  const view = await renderPage({ "": [STORED_BEFORE] });
  expect(drawn(view.container)[0]?.decision).toEqual([
    "未连接",
    "You have not connected your Gmail account. Connect it and ask again.",
    // Admin asks the controls about the row: see what-if/why-button.tsx.
    "为什么？",
  ]);
  const decision =
    view.container.querySelector("tbody [data-column=decision]")?.textContent ??
    "";
  expect(decision).not.toContain("[connect-app]");
  expect(decision).not.toContain("{");
  expect(decision).not.toMatch(/composio/i);
});
