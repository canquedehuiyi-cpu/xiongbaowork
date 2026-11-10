import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QuotaGuidanceDialog } from "@/components/quota/quota-guidance-dialog";
import { RequestError } from "@/lib/client";
import { dispatchToWaker } from "@/lib/channels/dispatch";
import { runErrorReason } from "@/lib/copilot/stopped-turn";
import {
  currentQuotaGuidance,
  dismissQuotaGuidance,
  QUOTA_RUN_ERROR_CODE,
  reportIfQuotaError,
  reportIfQuotaRunError,
  subscribeQuotaGuidance,
} from "@/lib/quota/guidance";

/**
 * Story K4 in the chat: a turn refused for quota shows the same guidance as every other refusal.
 *
 * A chat turn is an event stream, so its refusal arrives as a `RUN_ERROR`, not as a 402 response.
 * The event below is the one `server/src/quota/limits.ts` (`quotaRunError`) writes, as it reads
 * after the SSE line is parsed: code `quota_exceeded` and the 402 body in `rawEvent`. Both chat
 * surfaces turn a run error into their line through `runErrorReason`, which also opens the dialog.
 * A dispatch from the chat is an ordinary request and answers a 402, which `channel-chat.tsx` hands
 * to `reportIfQuotaError`.
 */

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  dismissQuotaGuidance();
});

const body = {
  error: "The Free plan allows 50 tasks per month; this workspace is using 50.",
  code: "quota_exceeded",
  metric: "tasksPerMonth",
  used: 50,
  limit: 50,
  plan: "Free",
  upgradeUrl: "/plans",
};

/** The RUN_ERROR as the server writes it, through JSON as the SSE stream carries it. */
const wireEvent = JSON.parse(
  JSON.stringify({
    type: "RUN_ERROR",
    message: body.error,
    code: "quota_exceeded",
    rawEvent: body,
  }),
);

function drawDialog() {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <>
          <span>对话</span>
          <QuotaGuidanceDialog />
        </>
      ),
    }),
  });
  return render(<RouterProvider router={router} />);
}

/** Listens the way the mounted dialog does, so a report is kept rather than dropped. */
function listening() {
  return subscribeQuotaGuidance(() => undefined);
}

test("the code the app reads is the one the server writes", () => {
  expect(QUOTA_RUN_ERROR_CODE).toBe("quota_exceeded");
});

test("a turn refused for quota opens the guidance dialog: what ran out, the upgrade, the wait", async () => {
  const view = drawDialog();
  // The router renders after a tick; the dialog is listening once the screen is there.
  await view.findByText("对话");
  let line = "";
  act(() => {
    line = runErrorReason(wireEvent);
  });
  // The chat's own line says it in Chinese, not the server's English sentence.
  expect(line).toBe(
    "本月任务次数已用完。Free 套餐：本月任务已用 50/50。额度会在下个周期自动恢复；现在就需要更多，可以升级套餐。",
  );
  expect(currentQuotaGuidance()).toEqual({
    code: "quota_exceeded",
    metric: "tasksPerMonth",
    used: 50,
    limit: 50,
    plan: "Free",
    upgradeUrl: "/plans",
  });
  await waitFor(() =>
    expect(view.getByText("本月任务次数已用完")).toBeTruthy(),
  );
  expect(view.getByText("Free 套餐：本月任务已用 50/50")).toBeTruthy();
  const upgrade = Array.from(document.querySelectorAll("a")).find(
    (anchor) => anchor.getAttribute("href") === "/plans",
  );
  expect(upgrade).toBeTruthy();
  // Closed again before the next test, so nothing of this dialog is left scheduled.
  act(() => dismissQuotaGuidance());
  await waitFor(() =>
    expect(view.queryByText("本月任务次数已用完")).toBeNull(),
  );
});

test("every metric the server can refuse a turn for gets its own guidance", () => {
  const stop = listening();
  try {
    for (const [metric, title] of [
      ["tasksPerMonth", "本月任务次数已用完"],
      ["wakers", "员工数量已达套餐上限"],
      ["devices", "设备数量已达套餐上限"],
      ["customModels", "当前套餐不支持更多自定义模型"],
    ] as const) {
      const guidance = reportIfQuotaRunError({
        ...wireEvent,
        rawEvent: { ...body, metric, used: 3, limit: 3 },
      });
      expect(guidance?.title).toBe(title);
      expect(currentQuotaGuidance()?.metric).toBe(metric);
    }
  } finally {
    stop();
  }
});

test("any other run error keeps its own words and opens nothing", () => {
  const stop = listening();
  try {
    expect(
      runErrorReason({
        type: "RUN_ERROR",
        message: "模型供应商那边出了错（HTTP 500）。供应商没有说明原因。",
        code: "OPENBOT_PROVIDER_REQUEST_REFUSED",
      }),
    ).toBe("模型供应商那边出了错（HTTP 500）。供应商没有说明原因。");
    expect(currentQuotaGuidance()).toBeNull();
    expect(runErrorReason(undefined)).toBe(
      "The Bot stopped without saying why.",
    );
  } finally {
    stop();
  }
});

test("a quota code with a body that does not validate is an ordinary error, not guidance", () => {
  const stop = listening();
  try {
    for (const rawEvent of [
      undefined,
      { ...body, used: -1 },
      { ...body, metric: "tokens" },
      { ...body, upgradeUrl: "https://elsewhere.invalid" },
    ]) {
      expect(runErrorReason({ ...wireEvent, rawEvent })).toBe(body.error);
      expect(currentQuotaGuidance()).toBeNull();
    }
  } finally {
    stop();
  }
});

test("a dispatch from the chat refused for quota is the same 402, and opens the same guidance", async () => {
  globalThis.fetch = Object.assign(
    async () =>
      new Response(JSON.stringify(body), {
        status: 402,
        headers: { "content-type": "application/json" },
      }),
    { preconnect: originalFetch.preconnect },
  );
  const stop = listening();
  try {
    let refused: unknown;
    try {
      await dispatchToWaker({
        channelId: "channel-1",
        id: "message-1",
        agentId: "agent-2",
        text: "帮我看看这个",
      });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(RequestError);
    expect(reportIfQuotaError(refused)).toBe(true);
    expect(currentQuotaGuidance()?.metric).toBe("tasksPerMonth");
  } finally {
    stop();
  }
});
