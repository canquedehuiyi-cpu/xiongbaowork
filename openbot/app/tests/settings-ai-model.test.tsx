/**
 * Settings → General's AI model, from the report: somebody on OpenBot Desktop 1.0.0 could not find
 * which AI provider they had signed in with, or change it.
 *
 * These tests stand in for the IPC Tauri injects into the Desktop window, answering as the shell's
 * `openbot-desktop` plugin does (desktop/src-tauri/src/desktop_page.rs: `ai_connection` and
 * `change_ai_connection`). The General page, its queries and its mutation are the real ones.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import type { DesktopAiConnection } from "@/lib/desktop/queries";
import { queryClient } from "@/query-client";
import { Route as GeneralRoute } from "@/routes/_authed/settings/index";
import { settleReactWork } from "./settle-react-work";

let connection: DesktopAiConnection;
let calls: string[];

async function shellInvoke(command: string) {
  calls.push(command);
  switch (command) {
    case "plugin:openbot-desktop|ai_connection":
      return connection;
    case "plugin:openbot-desktop|change_ai_connection":
      return null;
  }
  throw `command ${command} not found`;
}

const originalFetch = global.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
beforeEach(() => {
  calls = [];
  connection = { kind: "claude-plan", model: null, endpointHost: null };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: shellInvoke,
    transformCallback: () => 0,
  };
  // The page's other rows read the server; none of them is under test here.
  global.fetch = Object.assign(
    async () => new Response(null, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

function renderGeneral() {
  const Page = GeneralRoute.options.component as ComponentType;
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Page />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

async function aiModelRow(view: ReturnType<typeof renderGeneral>) {
  await view.findByRole("heading", { name: "AI 模型" });
  return view.getByRole("button", { name: /已用你的|使用你的|已连接到/ });
}

test("a Claude plan shows as Anthropic, signed in with the Claude plan", async () => {
  const view = renderGeneral();
  const row = await aiModelRow(view);
  expect(row.textContent).toBe("Anthropic已用你的 Claude 套餐登录。");
  await userEvent.click(row);
  const dialog = await view.findByRole("dialog");
  expect(within(dialog).getByText("Claude 套餐")).toBeTruthy();
  expect(
    within(dialog).getByText(
      "你的员工使用 Anthropic。你的密钥或登录信息只保存在这台电脑上。",
    ),
  ).toBeTruthy();
});

test("an OpenAI API key shows as OpenAI with an API key, never the key", async () => {
  connection = { kind: "open-ai-api-key", model: null, endpointHost: null };
  const view = renderGeneral();
  const row = await aiModelRow(view);
  expect(row.textContent).toBe("OpenAI使用你的 OpenAI API 密钥。");
  await userEvent.click(row);
  const dialog = await view.findByRole("dialog");
  expect(within(dialog).getByText("API 密钥")).toBeTruthy();
  expect(dialog.textContent).not.toMatch(/sk-/);
});

test("a provider's own address shows by name, with the model named in setup", async () => {
  connection = {
    kind: "compatible-endpoint",
    model: "gemini-3.8-flash",
    endpointHost: "generativelanguage.googleapis.com",
  };
  const view = renderGeneral();
  const row = await aiModelRow(view);
  expect(row.textContent).toBe(
    "Google Gemini使用你的 Google Gemini API 密钥。模型：gemini-3.8-flash",
  );
});

test("Change asks the desktop app to change the AI connection", async () => {
  const view = renderGeneral();
  await userEvent.click(await aiModelRow(view));
  const dialog = await view.findByRole("dialog");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "更换 AI 连接" }),
  );
  await waitFor(() =>
    expect(calls).toContain("plugin:openbot-desktop|change_ai_connection"),
  );
  // OpenBot is stopping and this page goes with it; nothing more to press.
  expect(
    (
      within(dialog).getByRole("button", {
        name: "正在停止熊宝…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("outside the desktop app there is no AI model section", async () => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  const view = renderGeneral();
  await view.findByRole("heading", { name: "关于你" });
  await settleReactWork();
  expect(view.queryByRole("heading", { name: "AI 模型" })).toBeNull();
  expect(calls).toEqual([]);
});
