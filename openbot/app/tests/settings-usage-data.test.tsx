/**
 * Settings → General's Share usage data: OpenBot Desktop's usage data could only be turned off with
 * an environment variable at launch. The switch writes the same opt-out.
 *
 * These tests stand in for the IPC Tauri injects into the Desktop window, answering as the shell's
 * `openbot-desktop` plugin does (desktop/src-tauri/src/desktop_page.rs: `usage_data` and
 * `set_usage_data`, whose effect on the CLI and the server is tested in
 * desktop/src-tauri/src/desktop_telemetry.rs). The General page, its query and its mutation are the
 * real ones.
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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import type { DesktopUsageData } from "@/lib/desktop/queries";
import { queryClient } from "@/query-client";
import { Route as GeneralRoute } from "@/routes/_authed/settings/index";
import { settleReactWork } from "./settle-react-work";

let usageData: DesktopUsageData;
let calls: { command: string; args?: unknown }[];

async function shellInvoke(command: string, args?: Record<string, unknown>) {
  calls.push({ command, args });
  switch (command) {
    case "plugin:openbot-desktop|usage_data":
      return usageData;
    case "plugin:openbot-desktop|set_usage_data":
      usageData = { ...usageData, shared: args?.share === true };
      return usageData;
  }
  throw `command ${command} not found`;
}

const originalFetch = global.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
beforeEach(() => {
  calls = [];
  usageData = { shared: true, offByEnvironment: false };
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

test("Share usage data says what is sent and when a change applies, and links what OpenBot sends", async () => {
  const view = renderGeneral();
  await view.findByRole("heading", { name: "隐私" });
  const toggle = view.getByRole("switch", { name: "共享使用数据" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(
    view.getByText(
      /它从不发送你的对话、文件或密钥。改动在熊宝下次启动时生效。/,
    ),
  ).toBeTruthy();
  expect(
    view.getByRole("link", { name: "熊宝会发送什么" }).getAttribute("href"),
  ).toBe(
    "https://github.com/CopilotKit/OpenBot/blob/main/desktop/TELEMETRY.md",
  );
});

test("turning it off asks the desktop app to write the opt-out, and the switch shows it", async () => {
  const view = renderGeneral();
  const toggle = await view.findByRole("switch", { name: "共享使用数据" });
  await userEvent.click(toggle);
  await waitFor(() =>
    expect(calls).toContainEqual({
      command: "plugin:openbot-desktop|set_usage_data",
      args: { share: false },
    }),
  );
  await waitFor(() =>
    expect(
      view
        .getByRole("switch", { name: "共享使用数据" })
        .getAttribute("aria-checked"),
    ).toBe("false"),
  );
  // And on again.
  await userEvent.click(view.getByRole("switch", { name: "共享使用数据" }));
  await waitFor(() =>
    expect(calls).toContainEqual({
      command: "plugin:openbot-desktop|set_usage_data",
      args: { share: true },
    }),
  );
});

test("an opt-out set where the app was launched shows off and cannot be switched on", async () => {
  usageData = { shared: false, offByEnvironment: true };
  const view = renderGeneral();
  const toggle = await view.findByRole("switch", { name: "共享使用数据" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(
    toggle.hasAttribute("disabled") ||
      toggle.getAttribute("aria-disabled") === "true",
  ).toBe(true);
  expect(view.getByText(/已在这台电脑上关闭/)).toBeTruthy();
});

test("a desktop app without the command draws no Privacy section", async () => {
  const view = renderGeneral();
  await view.findByRole("heading", { name: "隐私" });
  cleanup();
  queryClient.clear();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (command: string) => {
      throw `command ${command} not found`;
    },
    transformCallback: () => 0,
  };
  const older = renderGeneral();
  await older.findByRole("heading", { name: "关于你" });
  await settleReactWork();
  expect(older.queryByRole("heading", { name: "隐私" })).toBeNull();
});
