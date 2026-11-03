import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
  approvalChoices,
  approvalOf,
  flipCardsForDecision,
} from "@/components/tasks/approval-actions";
import { agentKeys } from "@/lib/agents/queries";
import { Route as TasksRoute } from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * Spec A8: approving or rejecting inside the board moves the task without a reload -- 批准 → 进行中,
 * 拒绝 → 已结束-失败.
 *
 * Driven through the real route, the real router, a real QueryClient, the real `decideApproval` and
 * `client`; only HTTP is ours. Every decision POST is HELD open until the case releases it, which is
 * what lets a case observe the card BEFORE the server answered -- the optimistic flip -- rather than
 * the refetch that follows, and observe a refusal putting the card back.
 *
 * The fixture has two cards parked on one approval (a crew's parent and its step share one) and a third
 * card parked on a different approval, so "every card that shares the approval moves, and no other" is
 * an assertion rather than a hope.
 */
let registeredHere = false;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type Row = {
  id: string;
  title: string;
  executorAgentId: null;
  source: string;
  status: string;
  channelRef: null;
  open: null;
  deliverableRef: null;
  model: null;
  device: null;
  pendingApprovalId: string | null;
  updatedAt: string;
};

const row = (
  id: string,
  status: string,
  pendingApprovalId: string | null,
): Row => ({
  id,
  title: `${id} card`,
  executorAgentId: null,
  source: "chat",
  status,
  channelRef: null,
  open: null,
  deliverableRef: null,
  model: null,
  device: null,
  pendingApprovalId,
  updatedAt: new Date().toISOString(),
});

const fixture = (): Row[] => [
  row("parent", "needs_action", "ap-shared"),
  row("step", "needs_action", "ap-shared"),
  row("other", "needs_action", "ap-other"),
  row("busy", "running", null),
];

/**
 * A server in miniature: the board reads whatever `rows` currently says, the inbox reports each
 * approval with the policy given, and each decision POST waits for `release`. When the server
 * ACCEPTS a decision it applies it the way the projector does, so the refetch after it agrees with
 * the flip; when it REFUSES, the rows stay as they were.
 */
function installServer(
  options: {
    handOff?: string[];
    /** Open questions (spec I3): each adds a card parked on it, and the inbox lists it. */
    questions?: { id: string; question: string }[];
    /** The first inbox read predates the questions: they were asked after the inbox was cached. */
    questionsAfterFirstRead?: boolean;
  } = {},
) {
  let rows = [
    ...fixture(),
    ...(options.questions ?? []).map((entry) =>
      row(`asked-${entry.id}`, "needs_action", entry.id),
    ),
  ];
  const requests: { method: string; path: string; body?: string }[] = [];
  const held: {
    approvalId: string;
    decision: string;
    resolve: (response: Response) => void;
  }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    requests.push({
      method,
      path,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const answer = /^\/api\/approvals\/questions\/([^/]+)\/respond$/.exec(path);
    if (method === "POST" && answer) {
      const approvalId = decodeURIComponent(answer[1] ?? "");
      return new Promise<Response>((resolve) => {
        held.push({ approvalId, decision: "answer", resolve });
      });
    }
    const decision = /^\/api\/approvals\/([^/]+)\/decision$/.exec(path);
    if (method === "POST" && decision) {
      const approvalId = decodeURIComponent(decision[1] ?? "");
      const chosen = JSON.parse(String(init?.body)).decision as string;
      return new Promise<Response>((resolve) => {
        held.push({ approvalId, decision: chosen, resolve });
      });
    }
    const inboxReads = requests.filter(
      (entry) => entry.method === "GET" && entry.path === "/api/approvals",
    ).length;
    const body = path.startsWith("/api/tasks?")
      ? { tasks: rows }
      : path === "/api/approvals"
        ? {
            enabled: true,
            requests: ["ap-shared", "ap-other"].map((id) => ({
              id,
              status: "pending",
              createdAt: new Date().toISOString(),
              action: {
                botId: "bot",
                toolRef: "computer_write_file",
                effect: "write",
                scope: "project",
                threadId: "thread",
                args: {},
                target: {},
                policy: options.handOff?.includes(id)
                  ? { behaviour: "hand_off", source: "rule", reason: "交给你" }
                  : { behaviour: "ask", source: "rule", reason: "先问" },
              },
            })),
            rules: [],
            teamRules: [],
            // An answered question leaves the inbox, the way `questions.list` drops finished rows.
            questions: (options.questions ?? [])
              .filter(
                (entry) =>
                  !(options.questionsAfterFirstRead && inboxReads <= 1) &&
                  rows.some(
                    (card) =>
                      card.pendingApprovalId === entry.id &&
                      card.status === "needs_action",
                  ),
              )
              .map((entry) => ({
                id: entry.id,
                botId: "bot",
                threadId: "thread",
                question: entry.question,
                createdAt: new Date().toISOString(),
              })),
          }
        : path.startsWith("/api/devices")
          ? { devices: [] }
          : { agents: [] };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }) as typeof fetch;

  /** Answer the oldest held decision: accepted (and applied to `rows`) or refused with `status`. */
  const release = (status = 200, error?: string) => {
    const next = held.shift();
    if (!next) throw new Error("no decision is waiting");
    if (status === 200) {
      const to = next.decision === "deny" ? "failed" : "running";
      rows = rows.map((entry) =>
        entry.pendingApprovalId === next.approvalId
          ? { ...entry, status: to, pendingApprovalId: null }
          : entry,
      );
    }
    next.resolve(
      new Response(
        JSON.stringify(
          status === 200 ? { id: next.approvalId, status: "x" } : { error },
        ),
        { headers: { "content-type": "application/json" }, status },
      ),
    );
  };
  return { requests, held, release };
}

const root = createRootRoute({ component: Outlet });
const authed = createRoute({
  id: "/_authed",
  getParentRoute: () => root,
  component: Outlet,
});
const app = createRoute({
  id: "/_app",
  getParentRoute: () => authed,
  component: Outlet,
});

type TestFileRouteWiring = Parameters<typeof TasksRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof app;
};

const tasksRoute = TasksRoute.update({
  id: "/tasks",
  path: "/tasks",
  getParentRoute: () => app,
} as TestFileRouteWiring);

const routeTree = root.addChildren([
  authed.addChildren([app.addChildren([tasksRoute])]),
]);

function draw() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  const router = createRouter({
    context: {},
    history: createMemoryHistory({
      initialEntries: ["/tasks?period=all&q=card&view=list"],
    }),
    routeTree,
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

type View = ReturnType<typeof render>;

/** The board's own list, not the attention region above it (which draws the same cards again). */
const listCard = (view: View, id: string) => {
  const aside = view.container.querySelector('section[aria-label="需要关注"]');
  const card = [...view.container.querySelectorAll("li")].find(
    (li) =>
      !aside?.contains(li) &&
      li.querySelector("span")?.textContent === `${id} card`,
  );
  if (!card) throw new Error(`no card ${id}`);
  return card;
};

const badge = (view: View, id: string) =>
  listCard(view, id).querySelector("[data-status]");

const buttonIn = (view: View, id: string, label: string) =>
  [...listCard(view, id).querySelectorAll("button")].find(
    (button) => (button.textContent ?? "").trim() === label,
  );

const labels = (view: View, id: string) =>
  [...listCard(view, id).querySelectorAll("button")].map((button) =>
    (button.textContent ?? "").trim(),
  );

const reads = (requests: { method: string; path: string }[]) => ({
  board: requests.filter(
    (entry) =>
      entry.method === "GET" &&
      entry.path.startsWith("/api/tasks?") &&
      entry.path.includes("q=card"),
  ).length,
  summary: requests.filter(
    (entry) =>
      entry.method === "GET" &&
      entry.path.startsWith("/api/tasks?") &&
      !entry.path.includes("q="),
  ).length,
  approvals: requests.filter(
    (entry) => entry.method === "GET" && entry.path === "/api/approvals",
  ).length,
});

const decisions = (
  requests: { method: string; path: string; body?: string }[],
) =>
  requests
    .filter((entry) => entry.method === "POST")
    .map((entry) => `${entry.path} ${entry.body}`);

async function ready(view: View, requests: { method: string; path: string }[]) {
  await waitFor(() => {
    expect(buttonIn(view, "parent", "批准")).toBeDefined();
    expect(reads(requests).approvals).toBeGreaterThan(0);
  });
  return reads(requests);
}

test("pure: only a card parked on that approval moves, and to the projector's status", () => {
  const rows = fixture();
  const allowed = flipCardsForDecision(rows, "ap-shared", "allow_once");
  expect(
    allowed.map((entry) => [entry.id, entry.status, entry.pendingApprovalId]),
  ).toEqual([
    ["parent", "running", null],
    ["step", "running", null],
    ["other", "needs_action", "ap-other"],
    ["busy", "running", null],
  ]);
  // Untouched cards are the same objects: the flip owns nothing else.
  expect(allowed[2]).toBe(rows[2]);
  expect(
    flipCardsForDecision(rows, "ap-shared", "deny").map(
      (entry) => entry.status,
    ),
  ).toEqual(["failed", "failed", "needs_action", "running"]);
  expect(
    flipCardsForDecision(rows, "ap-shared", "handled").map(
      (entry) => entry.status,
    ),
  ).toEqual(["running", "running", "needs_action", "running"]);
  // A card that is not waiting on a person has nothing to answer, whatever id it still carries.
  expect(
    approvalOf({ id: "x", status: "running", pendingApprovalId: "ap" }),
  ).toBeNull();
  expect(approvalOf({ id: "x", status: "needs_action" })).toBeNull();
  expect(approvalChoices(false).map((choice) => choice.label)).toEqual([
    "批准",
    "拒绝",
  ]);
  expect(approvalChoices(true).map((choice) => choice.decision)).toEqual([
    "handled",
    "deny",
  ]);
});

test("批准 flips every card sharing the approval to 进行中 before the server answers, then refreshes all three reads", async () => {
  const server = installServer();
  const view = draw();
  const base = await ready(view, server.requests);
  // Only a parked card offers the choice.
  expect(buttonIn(view, "busy", "批准")).toBeUndefined();

  await userEvent.click(buttonIn(view, "parent", "批准") as HTMLElement);

  // The POST is still held: what the screen shows now is the optimistic flip.
  await waitFor(() => {
    expect(server.held).toHaveLength(1);
    expect(badge(view, "parent")?.getAttribute("data-status")).toBe("running");
    expect(badge(view, "step")?.getAttribute("data-status")).toBe("running");
  });
  expect(badge(view, "parent")?.textContent).toBe("进行中");
  // A different approval's card is not touched.
  expect(badge(view, "other")?.getAttribute("data-status")).toBe(
    "needs_action",
  );
  expect(buttonIn(view, "other", "批准")).toBeDefined();
  expect(buttonIn(view, "parent", "批准")).toBeUndefined();
  expect(decisions(server.requests)).toEqual([
    '/api/approvals/ap-shared/decision {"decision":"allow_once"}',
  ]);

  server.release(200);
  await waitFor(() => {
    const after = reads(server.requests);
    expect(after.board).toBeGreaterThan(base.board);
    expect(after.summary).toBeGreaterThan(base.summary);
    expect(after.approvals).toBeGreaterThan(base.approvals);
  });
  // The server's answer agrees with the flip, so nothing moves back.
  await waitFor(() => {
    expect(badge(view, "parent")?.getAttribute("data-status")).toBe("running");
    expect(badge(view, "step")?.getAttribute("data-status")).toBe("running");
  });
  expect(view.container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  view.unmount();
});

test("拒绝 flips every card sharing the approval to 失败", async () => {
  const server = installServer();
  const view = draw();
  await ready(view, server.requests);

  await userEvent.click(buttonIn(view, "step", "拒绝") as HTMLElement);
  await waitFor(() => {
    expect(server.held).toHaveLength(1);
    expect(badge(view, "parent")?.getAttribute("data-status")).toBe("failed");
    expect(badge(view, "step")?.getAttribute("data-status")).toBe("failed");
  });
  expect(badge(view, "step")?.textContent).toBe("失败");
  expect(badge(view, "other")?.getAttribute("data-status")).toBe(
    "needs_action",
  );
  expect(decisions(server.requests)).toEqual([
    '/api/approvals/ap-shared/decision {"decision":"deny"}',
  ]);

  server.release(200);
  await waitFor(() => {
    expect(badge(view, "step")?.getAttribute("data-status")).toBe("failed");
    expect(server.held).toHaveLength(0);
  });
  view.unmount();
});

test("a refused decision puts every card back, says why, and still refreshes the reads", async () => {
  const server = installServer();
  const view = draw();
  const base = await ready(view, server.requests);

  await userEvent.click(buttonIn(view, "parent", "批准") as HTMLElement);
  await waitFor(() => {
    expect(badge(view, "parent")?.getAttribute("data-status")).toBe("running");
  });

  // Counted after the click, so the refresh asserted below must come from the refused decision.
  const beforeRelease = reads(server.requests).approvals;
  server.release(400, "This request was already decided.");
  await waitFor(() => {
    expect(badge(view, "parent")?.getAttribute("data-status")).toBe(
      "needs_action",
    );
    expect(badge(view, "step")?.getAttribute("data-status")).toBe(
      "needs_action",
    );
    expect(
      [...view.container.querySelectorAll('[role="alert"]')]
        .map((node) => node.textContent ?? "")
        .join(" "),
    ).toContain("This request was already decided.");
  });
  await waitFor(() => {
    expect(reads(server.requests).board).toBeGreaterThan(base.board);
    expect(reads(server.requests).approvals).toBeGreaterThan(beforeRelease);
  });
  // The buttons are back, because the question is still open on the server.
  expect(buttonIn(view, "parent", "批准")).toBeDefined();
  view.unmount();
});

test("a refusal puts back only its own cards, not another approval's decision still in flight", async () => {
  const server = installServer();
  const view = draw();
  await ready(view, server.requests);

  await userEvent.click(buttonIn(view, "parent", "批准") as HTMLElement);
  await userEvent.click(buttonIn(view, "other", "拒绝") as HTMLElement);
  await waitFor(() => {
    expect(server.held).toHaveLength(2);
    expect(badge(view, "parent")?.getAttribute("data-status")).toBe("running");
    expect(badge(view, "other")?.getAttribute("data-status")).toBe("failed");
  });

  // The oldest held decision -- ap-shared -- is refused while ap-other is still waiting.
  server.release(400, "This request was already decided.");
  await waitFor(() => {
    expect(badge(view, "parent")?.getAttribute("data-status")).toBe(
      "needs_action",
    );
    expect(badge(view, "step")?.getAttribute("data-status")).toBe(
      "needs_action",
    );
  });
  // Rolling back a whole snapshot taken before the second click would have undone this flip too.
  expect(badge(view, "other")?.getAttribute("data-status")).toBe("failed");

  server.release(200);
  await waitFor(() => {
    expect(server.held).toHaveLength(0);
    expect(badge(view, "other")?.getAttribute("data-status")).toBe("failed");
  });
  // The first approval's refusal is still said, though a later decision has since succeeded.
  expect(
    [...view.container.querySelectorAll('[role="alert"]')]
      .map((node) => node.textContent ?? "")
      .join(" "),
  ).toContain("This request was already decided.");
  view.unmount();
});

test("one approval answers once: a second click before the card re-renders sends nothing", async () => {
  const server = installServer();
  const view = draw();
  await ready(view, server.requests);
  const allow = buttonIn(view, "parent", "批准") as HTMLElement;
  // The same card's copy in the attention region above is the same question.
  const aside = view.container.querySelector('section[aria-label="需要关注"]');
  const asideAllow = [...(aside?.querySelectorAll("button") ?? [])].find(
    (button) => (button.textContent ?? "").trim() === "批准",
  ) as HTMLElement;
  expect(asideAllow).toBeDefined();
  // Synchronous clicks, before React has re-rendered anything: only the gate can stop the second.
  fireEvent.click(allow);
  fireEvent.click(allow);
  fireEvent.click(asideAllow);
  await waitFor(() => expect(server.held).toHaveLength(1));
  expect(decisions(server.requests)).toHaveLength(1);
  server.release(200);
  await waitFor(() => expect(server.held).toHaveLength(0));
  expect(decisions(server.requests)).toHaveLength(1);
  view.unmount();
});

test("an action handed to the person offers 已处理 instead of 批准, and sends `handled`", async () => {
  const server = installServer({ handOff: ["ap-shared"] });
  const view = draw();
  await waitFor(() => {
    expect(buttonIn(view, "parent", "已处理")).toBeDefined();
  });
  expect(labels(view, "parent")).not.toContain("批准");
  expect(labels(view, "parent")).toContain("拒绝");
  // The other approval is an ordinary ask.
  expect(buttonIn(view, "other", "批准")).toBeDefined();

  await userEvent.click(buttonIn(view, "parent", "已处理") as HTMLElement);
  await waitFor(() => {
    expect(badge(view, "parent")?.getAttribute("data-status")).toBe("running");
    expect(badge(view, "step")?.getAttribute("data-status")).toBe("running");
  });
  expect(decisions(server.requests)).toEqual([
    '/api/approvals/ap-shared/decision {"decision":"handled"}',
  ]);
  server.release(200);
  await waitFor(() => expect(server.held).toHaveLength(0));
  view.unmount();
});

/**
 * Spec I3: a card parked on a QUESTION (`ask_person`) is answered on the board. It shows the question and
 * an answer box -- never 批准/拒绝, which would send a decision for an approval that does not exist --
 * and 回答 posts to the endpoint the 审批 page answers with. The card goes back to 进行中 before the
 * server answers, and a refusal puts it back with its answer box.
 */
const QUESTION = { id: "q-branch", question: "合并到哪个分支？" };

const answerBox = (view: View, id: string) =>
  listCard(view, id).querySelector(
    'input[aria-label="你的回答"]',
  ) as HTMLInputElement | null;

test("pure: an answer moves the question's cards to 进行中 and nothing else", () => {
  const rows = [...fixture(), row("asked", "needs_action", "q-1")];
  const answered = flipCardsForDecision(rows, "q-1", "answer");
  expect(
    answered.map((entry) => [entry.id, entry.status, entry.pendingApprovalId]),
  ).toEqual([
    ["parent", "needs_action", "ap-shared"],
    ["step", "needs_action", "ap-shared"],
    ["other", "needs_action", "ap-other"],
    ["busy", "running", null],
    ["asked", "running", null],
  ]);
  expect(answered[0]).toBe(rows[0]);
});

test("回答 on a question's card posts the answer and flips the card to 进行中 before the server answers", async () => {
  const server = installServer({ questions: [QUESTION] });
  const view = draw();
  const base = await ready(view, server.requests);
  const asked = `asked-${QUESTION.id}`;
  await waitFor(() => expect(answerBox(view, asked)).not.toBeNull());
  // The question is shown in the coworker's words, with an answer box rather than a decision.
  expect(listCard(view, asked).textContent).toContain(QUESTION.question);
  expect(labels(view, asked)).toEqual(["回答"]);
  // Nothing to send until something is written.
  expect((buttonIn(view, asked, "回答") as HTMLButtonElement).disabled).toBe(
    true,
  );

  await userEvent.type(answerBox(view, asked) as HTMLElement, "  main 分支  ");
  await userEvent.click(buttonIn(view, asked, "回答") as HTMLElement);

  await waitFor(() => {
    expect(server.held).toHaveLength(1);
    expect(badge(view, asked)?.getAttribute("data-status")).toBe("running");
  });
  expect(badge(view, asked)?.textContent).toBe("进行中");
  // The approvals' cards are not touched by an answer.
  expect(badge(view, "parent")?.getAttribute("data-status")).toBe(
    "needs_action",
  );
  expect(buttonIn(view, "parent", "批准")).toBeDefined();
  expect(decisions(server.requests)).toEqual([
    `/api/approvals/questions/${QUESTION.id}/respond {"response":"main 分支"}`,
  ]);

  server.release(200);
  await waitFor(() => {
    const after = reads(server.requests);
    expect(after.board).toBeGreaterThan(base.board);
    expect(after.summary).toBeGreaterThan(base.summary);
    expect(after.approvals).toBeGreaterThan(base.approvals);
  });
  await waitFor(() => {
    expect(badge(view, asked)?.getAttribute("data-status")).toBe("running");
  });
  expect(answerBox(view, asked)).toBeNull();
  expect(view.container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  view.unmount();
});

test("a refused answer puts the question's card back with its answer box and says why", async () => {
  const server = installServer({ questions: [QUESTION] });
  const view = draw();
  await ready(view, server.requests);
  const asked = `asked-${QUESTION.id}`;
  await waitFor(() => expect(answerBox(view, asked)).not.toBeNull());

  await userEvent.type(answerBox(view, asked) as HTMLElement, "main");
  await userEvent.click(buttonIn(view, asked, "回答") as HTMLElement);
  await waitFor(() => {
    expect(badge(view, asked)?.getAttribute("data-status")).toBe("running");
  });

  server.release(404, "That approval was not found.");
  await waitFor(() => {
    expect(badge(view, asked)?.getAttribute("data-status")).toBe(
      "needs_action",
    );
    expect(
      [...view.container.querySelectorAll('[role="alert"]')]
        .map((node) => node.textContent ?? "")
        .join(" "),
    ).toContain("That approval was not found.");
  });
  await waitFor(() => expect(answerBox(view, asked)).not.toBeNull());
  expect(labels(view, asked)).not.toContain("批准");
  view.unmount();
});

test("a question newer than the cached inbox is read again, and its card never offers 批准", async () => {
  const server = installServer({
    questions: [QUESTION],
    questionsAfterFirstRead: true,
  });
  const view = draw();
  await ready(view, server.requests);
  const asked = `asked-${QUESTION.id}`;
  // The first inbox read does not know the question: the card waits for a second read, offering nothing.
  expect(labels(view, asked)).not.toContain("批准");
  await waitFor(() => expect(answerBox(view, asked)).not.toBeNull());
  expect(reads(server.requests).approvals).toBeGreaterThan(1);
  expect(labels(view, asked)).toEqual(["回答"]);
  // The approvals the first read already knew kept their buttons throughout.
  expect(buttonIn(view, "parent", "批准")).toBeDefined();
  expect(decisions(server.requests)).toEqual([]);
  view.unmount();
});
