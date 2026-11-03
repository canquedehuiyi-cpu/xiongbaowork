import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutomationForm } from "@/components/automations/automation-form";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  automationKeys,
  type CreatedAutomation,
  MAX_ACTIVE_TRIGGERS,
} from "@/lib/automations/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Inputs are filled with `user.type`: under happy-dom `fireEvent.change` on an `<input>` does not reach
 * React's onChange (measured on Bun 1.3.14), while on a `<select>` it does.
 *
 * D06 AUT1/AUT3/AUT4: the 新建自动任务 form against a stubbed `/api/automations`. What is asserted is
 * what goes over the wire — the target, every trigger, the limits — and that the server's refusal is
 * the sentence the person reads.
 */
let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterEach(async () => {
  cleanup();
  for (const client of clients) {
    await client.cancelQueries();
    client.clear();
  }
  clients.length = 0;
  calls.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
const calls: { method: string; path: string; body: unknown }[] = [];
const writes = () => calls.filter((entry) => entry.method !== "GET");

const waker = (id: string, name: string): AgentProfile => ({
  id,
  name,
  title: "",
  roleDescription: "",
  avatarSeed: id,
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  modelRef: null,
  persona: null,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
});

const FLOW_ID = "5f0c1f8e-8a39-4f4e-9d8f-0e5a3c6b7d21";

type Answer = (method: string, path: string, body: unknown) => Response;

function serve(answer: Answer) {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (method === "GET" && path === "/api/wakerflows") {
      return Response.json({ flows: [{ id: FLOW_ID, name: "周报流程" }] });
    }
    return answer(method, path, body);
  }) as typeof fetch;
}

/** The happy server: makes the automation, then each trigger; a webhook gets its one-time secret. */
const accept: Answer = (method, path, body) => {
  if (method === "POST" && path === "/api/automations") {
    return Response.json(
      {
        automation: {
          id: "auto-1",
          name: (body as { name: string }).name,
          target: (body as { target: unknown }).target,
          enabled: true,
          maxRuns: (body as { maxRuns: number | null }).maxRuns,
          endDate: (body as { endDate: string | null }).endDate,
          runCount: 0,
          createdAt: new Date().toISOString(),
        },
      },
      { status: 201 },
    );
  }
  if (method === "POST" && path === "/api/automations/auto-1/triggers") {
    const config = body as { kind: string };
    const trigger = {
      id: `trigger-${calls.length}`,
      automationId: "auto-1",
      config,
      enabled: true,
      nextRunAt: null,
      hasSecret: config.kind === "webhook",
      lastError: null,
    };
    return Response.json(
      config.kind === "webhook" ? { trigger, secret: "s3cret" } : { trigger },
      { status: 201 },
    );
  }
  return Response.json(
    { error: `unexpected ${method} ${path}` },
    { status: 500 },
  );
};

function draw(
  options: {
    wakerflow?: boolean;
    onCreated?: (c: CreatedAutomation) => void;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(agentKeys.list(false), [
    waker("agent-a", "小熊甲"),
    waker("agent-b", "小熊乙"),
  ]);
  queryClient.setQueryData(automationKeys.capabilities(), {
    wakerflow: options.wakerflow === true,
  });
  const user = userEvent.setup({ document });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AutomationForm onCreated={options.onCreated ?? (() => {})} />
    </QueryClientProvider>,
  );
  return { view, user };
}

test("AUT3: WakerFlow cannot be chosen while the deployment does not offer it", async () => {
  serve(accept);
  const { view } = draw({ wakerflow: false });
  const kind = view.getByLabelText("执行对象") as HTMLSelectElement;
  const flowOption = Array.from(kind.options).find(
    (option) => option.value === "wakerflow",
  );
  expect(flowOption?.disabled).toBe(true);
  expect(
    view.getByText("WakerFlow 自动执行尚未开放，暂时只能选择 Waker。"),
  ).toBeTruthy();
  // The Waker picker lists the coworkers and nothing asks for the flow list.
  const picker = view.getByLabelText("选择 Waker") as HTMLSelectElement;
  expect(Array.from(picker.options).map((option) => option.value)).toEqual([
    "agent-a",
    "agent-b",
  ]);
  expect(view.queryByLabelText("选择 WakerFlow")).toBeNull();
  expect(calls.some((call) => call.path === "/api/wakerflows")).toBe(false);
});

test("AUT3: with the capability, an existing WakerFlow is sent as the target", async () => {
  serve(accept);
  const { view, user } = draw({ wakerflow: true });
  const kind = view.getByLabelText("执行对象") as HTMLSelectElement;
  expect(
    Array.from(kind.options).find((option) => option.value === "wakerflow")
      ?.disabled,
  ).toBe(false);
  fireEvent.change(kind, { target: { value: "wakerflow" } });
  const flow = (await view.findByLabelText(
    "选择 WakerFlow",
  )) as HTMLSelectElement;
  await waitFor(() =>
    expect(Array.from(flow.options).map((option) => option.value)).toEqual([
      FLOW_ID,
    ]),
  );
  await user.type(view.getByLabelText("要做的事"), "生成周报");
  await user.type(view.getByLabelText("cron 规则 1"), "0 9 * * 1");
  await user.click(view.getByRole("button", { name: "建立自动任务" }));

  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()[0]?.body).toEqual({
    name: "生成周报",
    target: { kind: "wakerflow", flowId: FLOW_ID },
    maxRuns: null,
    endDate: null,
  });
});

test("AUT1/AUT4: five triggers of every kind, a run cap and an end date go to the server", async () => {
  serve(accept);
  const created: CreatedAutomation[] = [];
  const { view, user } = draw({ onCreated: (c) => created.push(c) });

  await user.type(view.getByLabelText("要做的事"), "整理客户反馈");
  fireEvent.change(view.getByLabelText("选择 Waker"), {
    target: { value: "agent-b" },
  });
  const add = view.getByRole("button", { name: "添加触发条件" });
  for (let index = 1; index < MAX_ACTIVE_TRIGGERS; index += 1) {
    await user.click(add);
  }
  // 原版显示上限 5: a sixth is not offered.
  expect(add.hasAttribute("disabled")).toBe(true);
  expect(view.getByText(`最多 ${MAX_ACTIVE_TRIGGERS} 个触发条件`)).toBeTruthy();
  expect(view.getByText(/触发条件（5\/5）/)).toBeTruthy();

  // 1: 定期
  await user.type(view.getByLabelText("cron 规则 1"), "0 9 * * 1-5");
  await user.clear(view.getByLabelText("时区 1"));
  await user.type(view.getByLabelText("时区 1"), "Asia/Shanghai");
  // 2: 一次性
  fireEvent.change(view.getByLabelText("触发方式 2"), {
    target: { value: "once" },
  });
  await user.type(view.getByLabelText("触发时间 2"), "2030-01-02T08:30");
  // 3: Hook / API
  fireEvent.change(view.getByLabelText("触发方式 3"), {
    target: { value: "webhook" },
  });
  // 4 and 5: 定期 with another rule each.
  await user.type(view.getByLabelText("cron 规则 4"), "30 18 * * *");
  await user.type(view.getByLabelText("cron 规则 5"), "0 0 1 * *");

  await user.type(view.getByLabelText("最大运行次数"), "12");
  await user.type(view.getByLabelText("截止日期"), "2030-06-30T23:00");
  await user.click(view.getByRole("button", { name: "建立自动任务" }));

  await waitFor(() => expect(writes()).toHaveLength(1 + MAX_ACTIVE_TRIGGERS));
  expect(writes()[0]).toEqual({
    method: "POST",
    path: "/api/automations",
    body: {
      name: "整理客户反馈",
      target: { kind: "waker", agentId: "agent-b" },
      maxRuns: 12,
      endDate: new Date("2030-06-30T23:00").toISOString(),
    },
  });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect(
    writes()
      .slice(1)
      .map((call) => [call.path, call.body]),
  ).toEqual([
    [
      "/api/automations/auto-1/triggers",
      { kind: "schedule", cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
    ],
    [
      "/api/automations/auto-1/triggers",
      { kind: "once", at: new Date("2030-01-02T08:30").toISOString() },
    ],
    ["/api/automations/auto-1/triggers", { kind: "webhook" }],
    [
      "/api/automations/auto-1/triggers",
      { kind: "schedule", cron: "30 18 * * *", timezone: zone },
    ],
    [
      "/api/automations/auto-1/triggers",
      { kind: "schedule", cron: "0 0 1 * *", timezone: zone },
    ],
  ]);
  await waitFor(() => expect(created).toHaveLength(1));
  // The webhook's secret is handed on to be shown once; the others carry none.
  expect(created[0]?.triggers.map((entry) => entry.secret)).toEqual([
    null,
    null,
    "s3cret",
    null,
    null,
  ]);
});

test("a refused automation shows the server's sentence verbatim and the form stays filled", async () => {
  const sentence = "最大运行次数至少为 1。";
  serve((method, path) =>
    method === "POST" && path === "/api/automations"
      ? Response.json({ error: sentence }, { status: 422 })
      : accept(method, path, null),
  );
  const { view, user } = draw();
  await user.type(view.getByLabelText("要做的事"), "每日巡检");
  await user.type(view.getByLabelText("cron 规则 1"), "0 9 * * *");
  await user.type(view.getByLabelText("最大运行次数"), "0");
  await user.click(view.getByRole("button", { name: "建立自动任务" }));

  expect((await view.findByRole("alert")).textContent).toBe(sentence);
  expect((view.getByLabelText("要做的事") as HTMLInputElement).value).toBe(
    "每日巡检",
  );
  // The cap is sent as typed; the rule is the server's.
  expect(writes()[0]?.body).toMatchObject({ maxRuns: 0 });
});

test("a refused trigger takes the half-made automation back and shows the refusal verbatim", async () => {
  const sentence =
    "定时规则需要五段 cron 表达式和有效时区，且间隔不少于 15 分钟。";
  serve((method, path, body) => {
    if (method === "POST" && path === "/api/automations/auto-1/triggers") {
      return Response.json({ error: sentence }, { status: 422 });
    }
    if (method === "DELETE" && path === "/api/automations/auto-1") {
      return new Response(null, { status: 204 });
    }
    return accept(method, path, body);
  });
  const created: CreatedAutomation[] = [];
  const { view, user } = draw({ onCreated: (c) => created.push(c) });
  await user.type(view.getByLabelText("要做的事"), "频繁检查");
  await user.type(view.getByLabelText("cron 规则 1"), "*/5 * * * *");
  await user.click(view.getByRole("button", { name: "建立自动任务" }));

  expect((await view.findByRole("alert")).textContent).toBe(sentence);
  await waitFor(() =>
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/automations",
      "POST /api/automations/auto-1/triggers",
      "DELETE /api/automations/auto-1",
    ]),
  );
  expect(created).toHaveLength(0);
  expect(view.getByRole("button", { name: "建立自动任务" })).toBeTruthy();
});

test("nothing to submit until there is a job, and the last trigger cannot be removed", async () => {
  serve(accept);
  const { view, user } = draw();
  const submit = view.getByRole("button", { name: "建立自动任务" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  expect(
    view
      .getByRole("button", { name: "移除触发条件 1" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await user.type(view.getByLabelText("要做的事"), "x");
  expect(submit.hasAttribute("disabled")).toBe(false);
});
