import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentKeys } from "@/lib/agents/queries";
import {
  AttentionRegion,
  deliverableSummary,
} from "@/routes/_authed/_app/tasks";

/**
 * Spec A9 on the board: a card in 查收结果 says what its run produced, and 查收 is the button beside
 * it. The chip is drawn for a `deliverable` record only — any other shape in the same column (a
 * circuit breaker's note, an old free-form ref) is not an output and must not be offered as one.
 *
 * Also the machine chip: the server sends the task row's own `deviceId`, and the card used to read a
 * `device` field that never arrives, so no card ever named its machine.
 *
 * Queries come off `render()`, not the module-level `screen`, for the reason
 * `tasks-attention-region.test.tsx` gives.
 */
type CardTask = Parameters<typeof AttentionRegion>[0]["tasks"][number];

let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
const clients = new Set<QueryClient>();
function testClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentKeys.list(false), []);
  clients.add(client);
  return client;
}
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.clear();
});
afterAll(() => {
  if (registeredHere) GlobalRegistrator.unregister();
});

const card = (over: Partial<CardTask> & { id: string }): CardTask =>
  ({
    title: `${over.id} card`,
    executorAgentId: "agent-aaaaaaaa",
    source: "chat",
    status: "awaiting_review",
    channelRef: null,
    open: null,
    deliverableRef: null,
    model: null,
    deviceId: null,
    updatedAt: new Date().toISOString(),
    ...over,
  }) as CardTask;

const CHART = {
  kind: "deliverable",
  components: [
    { name: "showBarChart", args: { title: "各团队收入" } },
    { name: "showBarChart", args: { title: "各团队支出" } },
    { name: "showChecklist", args: {} },
  ],
  attachments: ["att-1", "att-2"],
};

test("the summary names what was drawn and how many files were handed over", () => {
  expect(deliverableSummary(CHART)).toBe("产出：柱状图、清单 · 2 个附件");
  expect(
    deliverableSummary({
      kind: "deliverable",
      components: [],
      attachments: ["a"],
    }),
  ).toBe("产出：1 个附件");
  // A component the board has no Chinese name for keeps the name it came with.
  expect(
    deliverableSummary({
      kind: "deliverable",
      components: [{ name: "playgroundWidget", args: {} }],
      attachments: [],
    }),
  ).toBe("产出：playgroundWidget");
});

test("nothing that is not a deliverable is summarised as one", () => {
  expect(deliverableSummary(null)).toBeNull();
  expect(deliverableSummary({ file: "report.md" })).toBeNull();
  expect(
    deliverableSummary({
      kind: "circuit_breaker",
      components: [{ name: "showBarChart", args: {} }],
      attachments: ["att-1"],
    }),
  ).toBeNull();
  expect(
    deliverableSummary({
      kind: "deliverable",
      components: [],
      attachments: [],
    }),
  ).toBeNull();
});

test("a card in 查收结果 shows what it produced, and 查收 asks to close that card", async () => {
  const reviewed: string[] = [];
  const view = render(
    <QueryClientProvider client={testClient()}>
      <AttentionRegion
        machineLabel={() => null}
        onArchive={() => {}}
        onReview={(id) => reviewed.push(id)}
        pendingIds={new Set<string>()}
        tasks={[
          card({ id: "chart", title: "收入图", deliverableRef: CHART }),
          card({
            id: "breaker",
            title: "熔断的例行任务",
            deliverableRef: {
              kind: "circuit_breaker",
              components: [{ name: "showBarChart", args: {} }],
              attachments: ["att-9"],
            },
          }),
          card({ id: "words", title: "只回了一段话" }),
        ]}
      />
    </QueryClientProvider>,
  );

  await userEvent.click(view.getByRole("button", { name: "查收结果 (3)" }));
  expect(view.getByText("收入图")).toBeTruthy();
  // One chip, on the one card whose ref is a deliverable.
  const chips = view.container.querySelectorAll("[data-deliverable]");
  expect(chips).toHaveLength(1);
  expect(chips[0]?.textContent).toBe("产出：柱状图、清单 · 2 个附件");
  expect(chips[0]?.closest("li")?.textContent).toContain("收入图");

  const chartCard = chips[0]?.closest("li") as HTMLElement;
  const button = Array.from(chartCard.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === "查收",
  );
  expect(button).toBeTruthy();
  await userEvent.click(button as HTMLElement);
  expect(reviewed).toEqual(["chart"]);
});

test("a card names the machine its work ran on, read from the row's deviceId", () => {
  const asked: (string | null)[] = [];
  const view = render(
    <QueryClientProvider client={testClient()}>
      <AttentionRegion
        machineLabel={(deviceId) => {
          asked.push(deviceId);
          return deviceId === "d-1"
            ? { name: "dev-laptop", online: false }
            : null;
        }}
        onArchive={() => {}}
        onReview={() => {}}
        pendingIds={new Set<string>()}
        tasks={[
          card({ id: "on-laptop", status: "needs_action", deviceId: "d-1" }),
        ]}
      />
    </QueryClientProvider>,
  );
  expect(asked).toContain("d-1");
  // Spec F4: and whether that machine is there now.
  const chip = view.getByText("dev-laptop · 离线");
  expect(chip.getAttribute("data-device-online")).toBe("false");
});
