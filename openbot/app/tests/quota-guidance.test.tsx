import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { QuotaGuidanceDialog } from "@/components/quota/quota-guidance-dialog";
import { client, type QuotaErrorDetails } from "@/lib/client";
import {
  currentQuotaGuidance,
  dismissQuotaGuidance,
  guidanceFor,
  reportQuotaExceeded,
  subscribeQuotaGuidance,
} from "@/lib/quota/guidance";
import { queryClient } from "@/query-client";

/**
 * Story K4: a structured 402 from anywhere in the app opens one guidance surface that names the plan,
 * the used/limit pair, and the ways out. The server is replaced by an in-memory `fetch`, as in
 * `quota-error-contract.test.ts`; the real `client` parses the refusal and the real shared
 * `queryClient` routes it to the dialog.
 */

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  queryClient.clear();
  dismissQuotaGuidance();
});

const path = "/api/quota-guidance-fixture";

function details(
  metric: QuotaErrorDetails["metric"],
  used = 2,
  limit = 2,
): QuotaErrorDetails {
  return {
    code: "quota_exceeded",
    metric,
    used,
    limit,
    plan: "Team",
    upgradeUrl: "/plans",
  };
}

/** An in-memory server that answers every request with `body` at `status`, counting the calls. */
function serve(status: number, body: unknown): { calls: number } {
  const seen = { calls: 0 };
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      expect(input).toBe(path);
      seen.calls += 1;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  return seen;
}

function Write() {
  const write = useMutation({
    mutationFn: () =>
      client(path, { method: "POST", fallback: "Could not save" }),
  });
  return (
    <div>
      <button type="button" onClick={() => write.mutate()}>
        保存
      </button>
      {write.error && <p role="alert">{write.error.message}</p>}
    </div>
  );
}

function Read() {
  const read = useQuery({
    queryKey: ["quota-guidance-fixture"],
    queryFn: () => client(path, { fallback: "Could not load" }),
  });
  return read.error ? <p role="alert">{read.error.message}</p> : null;
}

function draw(screen: () => ReactNode) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <>
          {screen()}
          <QuotaGuidanceDialog />
        </>
      ),
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The href of the anchor that holds `text`, which Base UI may render with a button role. */
function hrefOf(container: HTMLElement, text: string): string | null {
  const anchor = Array.from(container.querySelectorAll("a")).find(
    (a) => a.textContent?.trim() === text,
  );
  return anchor ? anchor.getAttribute("href") : null;
}

test("guidanceFor names the plan, used/limit, /plans and the cleanup screen for every metric", () => {
  expect(guidanceFor(details("wakers", 3, 3))).toEqual({
    metric: "wakers",
    title: "员工数量已达套餐上限",
    sentence: "Team 套餐：员工已用 3/3",
    hint: "删除不再需要的员工即可腾出名额，或升级套餐获得更多名额。",
    upgradeHref: "/plans",
    cleanup: { href: "/agents", label: "管理员工" },
  });
  expect(guidanceFor(details("devices", 1, 1))).toEqual({
    metric: "devices",
    title: "设备数量已达套餐上限",
    sentence: "Team 套餐：设备已用 1/1",
    hint: "移除不再使用的设备即可腾出名额，或升级套餐获得更多名额。",
    upgradeHref: "/plans",
    // 设置 › 我的设备 is where a registered device (what the quota counts) is removed.
    cleanup: { href: "/settings", label: "管理设备" },
  });
  expect(guidanceFor(details("customModels", 5, 5))).toEqual({
    metric: "customModels",
    title: "当前套餐不支持更多自定义模型",
    sentence: "Team 套餐：自定义模型已用 5/5",
    hint: "从模型库删除不再使用的模型即可腾出名额，或升级套餐获得更多名额。",
    upgradeHref: "/plans",
    cleanup: { href: "/resources", label: "管理模型库" },
  });
  const tasks = guidanceFor(details("tasksPerMonth", 100, 100));
  expect(tasks).toEqual({
    metric: "tasksPerMonth",
    title: "本月任务次数已用完",
    sentence: "Team 套餐：本月任务已用 100/100",
    hint: "额度会在下个周期自动恢复；现在就需要更多，可以升级套餐。",
    upgradeHref: "/plans",
  });
  expect(tasks.hint).toContain("下个周期自动恢复");
  expect("cleanup" in tasks).toBe(false);
});

test("guidanceFor keeps zero values and trims the plan label", () => {
  const zero = guidanceFor({ ...details("devices", 0, 0), plan: "  Free  " });
  expect(zero.sentence).toBe("Free 套餐：设备已用 0/0");
});

test("a ceiling of 0 offers only the upgrade: nothing to delete, nothing that comes back", () => {
  // The server turns `customModels: false` into a limit of 0, so this is the Free plan's refusal.
  expect(guidanceFor(details("customModels", 0, 0))).toEqual({
    metric: "customModels",
    title: "当前套餐不支持更多自定义模型",
    sentence: "Team 套餐：自定义模型已用 0/0",
    hint: "当前套餐不包含自定义模型，升级套餐后即可使用。",
    upgradeHref: "/plans",
  });
  for (const metric of ["wakers", "devices", "tasksPerMonth"] as const) {
    const guidance = guidanceFor(details(metric, 0, 0));
    expect("cleanup" in guidance).toBe(false);
    expect(guidance.hint).toContain("升级套餐后即可使用");
    expect(guidance.hint).not.toContain("下个周期");
  }
});

test("a refusal reported with no dialog mounted is dropped, not replayed later", () => {
  reportQuotaExceeded(details("wakers"));
  expect(currentQuotaGuidance()).toBeNull();
  const seen: (QuotaErrorDetails | null)[] = [];
  const stop = subscribeQuotaGuidance(() => seen.push(currentQuotaGuidance()));
  reportQuotaExceeded(details("devices"));
  dismissQuotaGuidance();
  stop();
  expect(seen).toEqual([details("devices"), null]);
});

test("a 402 mutation opens the dialog with used/limit, the /plans link and the cleanup link", async () => {
  serve(402, {
    error: "This workspace has reached its allowance.",
    ...details("wakers"),
  });
  const view = draw(() => <Write />);
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(await view.findByRole("button", { name: "保存" }));

  const dialog = await view.findByRole("dialog", {
    name: "员工数量已达套餐上限",
  });
  expect(dialog.textContent).toContain("Team 套餐：员工已用 2/2");
  expect(hrefOf(dialog, "升级套餐")).toBe("/plans");
  expect(hrefOf(dialog, "管理员工")).toBe("/agents");
  // The screen's own inline message is kept beside the dialog.
  expect((await view.findByRole("alert")).textContent).toBe(
    "This workspace has reached its allowance.",
  );

  await user.click(view.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(currentQuotaGuidance()).toBeNull();
});

test("a 402 read opens the dialog without being retried, and a monthly tally offers no cleanup", async () => {
  const server = serve(402, {
    error: "This month's tasks are used up.",
    ...details("tasksPerMonth", 30, 30),
  });
  const view = draw(() => <Read />);

  const dialog = await view.findByRole("dialog", {
    name: "本月任务次数已用完",
  });
  expect(dialog.textContent).toContain("Team 套餐：本月任务已用 30/30");
  expect(dialog.textContent).toContain("下个周期自动恢复");
  expect(hrefOf(dialog, "升级套餐")).toBe("/plans");
  expect(dialog.querySelectorAll("a")).toHaveLength(1);
  expect((await view.findByRole("alert")).textContent).toBe(
    "This month's tasks are used up.",
  );
  expect(server.calls).toBe(1);
});

for (const [label, status, body] of [
  ["a 409 refusal", 409, { error: "That name is taken." }],
  ["a 402 without valid quota details", 402, { error: "Payment required." }],
  [
    "a 402 whose quota fields fail validation",
    402,
    { error: "Payment required.", ...details("wakers"), upgradeUrl: "/x" },
  ],
  // Valid quota fields on a status other than 402 are some other failure, not a full allowance.
  [
    "a 500 that carries valid quota fields",
    500,
    {
      error: "Server broke.",
      ...details("wakers"),
    },
  ],
  [
    "a 409 that carries valid quota fields",
    409,
    {
      error: "Already exists.",
      ...details("devices"),
    },
  ],
] as const) {
  test(`${label} does not open the guidance dialog`, async () => {
    serve(status, body);
    const view = draw(() => <Write />);
    const user = userEvent.setup({ document: view.baseElement.ownerDocument });
    await user.click(await view.findByRole("button", { name: "保存" }));

    expect((await view.findByRole("alert")).textContent).toBe(body.error);
    expect(view.queryByRole("dialog")).toBeNull();
    expect(currentQuotaGuidance()).toBeNull();
  });
}
