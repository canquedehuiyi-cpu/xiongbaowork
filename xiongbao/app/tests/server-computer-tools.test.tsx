import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import * as ReactCoreV2 from "@copilotkit/react-core/v2";
import {
  CopilotKitProvider as ChatRuntimeProvider,
  useCopilotKit as useChatRuntime,
} from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ActiveBotProvider } from "@/lib/copilot/active-bot";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import { CopilotProvider } from "@/lib/copilot/provider";
import {
  isServerHeldTool,
  ServerComputerToolsProvider,
  serverComputerRunProperties,
} from "@/lib/copilot/server-computer-tools";
import { SignInTool } from "@/lib/copilot/sign-in-tool";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * 网页单聊的电脑工具交给服务器执行、页面只渲染（期九·四）。
 *
 * 一个开关两半：运行带「电脑工具由服务器执行」的声明，页面上这批工具只注册渲染、不注册处理函数、也不再提供给
 * 模型。两半来自同一个答案，所以页面不会一边让服务器执行、一边自己也执行。开关关着时一切和以前一样。
 */

type Registered = Parameters<typeof ReactCoreV2.useFrontendTool>[0];
const registered: Registered[] = [];
const useFrontendToolSpy = spyOn(
  ReactCoreV2,
  "useFrontendTool",
).mockImplementation(((tool: Registered) => {
  registered.push(tool);
}) as typeof ReactCoreV2.useFrontendTool);

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Whatever the screens read here is "not served": nothing in these cases is about their answers.
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      // The runtime's own handshake is answered so it does not fill the log; the rest is not served.
      if (String(input).endsWith("/info"))
        return Response.json({
          version: "fixture",
          agents: {},
          mode: "sse",
          telemetryDisabled: true,
        });
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
beforeEach(() => {
  registered.length = 0;
  queryClient.clear();
});
afterEach(cleanup);
afterAll(async () => {
  useFrontendToolSpy.mockRestore();
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function capabilities(on: boolean | undefined) {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
    ...(on === undefined ? {} : { chatServerComputerTools: on }),
  });
}

async function computerTools(serverRuns: boolean) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatRuntimeProvider runtimeUrl="http://localhost/api/runtime">
        <ActiveBotProvider>
          <ServerComputerToolsProvider value={serverRuns}>
            <ComputerTools />
            <SignInTool />
          </ServerComputerToolsProvider>
        </ActiveBotProvider>
      </ChatRuntimeProvider>
    </QueryClientProvider>,
  );
  // The permission reads the tools make settle before the cases look at what they registered.
  await settleReactWork();
  return view;
}

const computerOnes = () =>
  registered.filter((tool) => isServerHeldTool(tool.name));

test("the declaration is in the run only where the deployment runs the chat's tools", () => {
  expect(serverComputerRunProperties(true)).toEqual({
    computerTools: "server",
  });
  expect(serverComputerRunProperties(false)).toEqual({});
});

test("the server holds every computer tool and the refusal report, and nothing else", () => {
  for (const name of [
    "computer_navigate",
    "computer_request_help",
    "computer_request_secret",
    "computer_request_sign_in",
    "computer_run_command",
    "computer_app_call",
    "report_refusal",
  ])
    expect(isServerHeldTool(name)).toBe(true);
  for (const name of ["update_plan", "message_bot", "render_ui", "show_chart"])
    expect(isServerHeldTool(name)).toBe(false);
});

test("with the switch on, every computer tool is only drawn: no handler, and not offered to the model", async () => {
  await computerTools(true);
  const held = computerOnes();
  // The whole set, not a sample: the browser tools, the files, the command, the secret, the help request.
  expect(held.length).toBeGreaterThanOrEqual(17);
  for (const name of [
    "computer_navigate",
    "computer_click",
    "computer_type",
    "computer_run_command",
    "computer_request_help",
    "computer_request_secret",
    "computer_request_sign_in",
    "report_refusal",
  ])
    expect(held.some((tool) => tool.name === name)).toBe(true);
  for (const tool of held) {
    expect([tool.name, tool.handler]).toEqual([tool.name, undefined]);
    expect([tool.name, tool.available]).toEqual([tool.name, false]);
  }
  // The drawing is still registered: the result arrives in the stream and has to be drawn.
  for (const name of [
    "computer_navigate",
    "computer_click",
    "computer_run_command",
  ])
    expect(typeof held.find((tool) => tool.name === name)?.render).toBe(
      "function",
    );
});

test("with the switch off, the page runs its own tools exactly as before", async () => {
  await computerTools(false);
  const held = computerOnes();
  expect(held.length).toBeGreaterThanOrEqual(17);
  for (const tool of held) {
    // A function that goes through the approval gate, and still offered (the Bot's permissions may hide it).
    expect([tool.name, typeof tool.handler]).toEqual([tool.name, "function"]);
    expect(tool.available).not.toBe(false);
  }
});

test("a tool the server does not hold keeps its handler even with the switch on", async () => {
  // `useFrontendTool` here is the approval wrapper's: it only changes the computer's tools.
  function Other() {
    useFrontendToolWrapper({
      name: "update_plan",
      description: "Plan",
      handler: async () => "ok",
    });
    return null;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <ChatRuntimeProvider runtimeUrl="http://localhost/api/runtime">
        <ServerComputerToolsProvider value>
          <Other />
        </ServerComputerToolsProvider>
      </ChatRuntimeProvider>
    </QueryClientProvider>,
  );
  await settleReactWork();
  const plan = registered.find((tool) => tool.name === "update_plan");
  expect(typeof plan?.handler).toBe("function");
  expect(plan?.available).not.toBe(false);
});

/** The core, as the provider handed it its properties: what every run it starts carries. */
let core: ReturnType<typeof useChatRuntime>["copilotkit"] | undefined;
function Core() {
  core = useChatRuntime().copilotkit;
  return null;
}
const carried = () => (core?.properties ?? {}) as Record<string, unknown>;

function provider() {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotProvider>
        <Core />
      </CopilotProvider>
    </QueryClientProvider>,
  );
}

test("every run declares that the server runs the computer when the deployment says it does", async () => {
  capabilities(true);
  provider();
  await waitFor(() => expect(carried().computerTools).toBe("server"));
  await settleReactWork();
});

test("the declaration follows the answer when it arrives after the page has drawn", async () => {
  provider();
  expect("computerTools" in carried()).toBe(false);
  act(() => capabilities(true));
  await waitFor(() => expect(carried().computerTools).toBe("server"));
  await settleReactWork();
});

test("no run declares it when the deployment does not say so", async () => {
  capabilities(false);
  provider();
  await settleReactWork();
  expect("computerTools" in carried()).toBe(false);
  cleanup();
  capabilities(undefined);
  provider();
  await settleReactWork();
  expect("computerTools" in carried()).toBe(false);
});

// The wrapper under test, named here so the "other tool" case reads as what it is.
import { useFrontendTool as useFrontendToolWrapper } from "@/lib/copilot/approval-tools";
