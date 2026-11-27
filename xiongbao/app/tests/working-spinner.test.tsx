import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider as ChatRuntimeProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { ConversationHeaderCard } from "@/components/channels/conversation-header-card";
import { GroupLine } from "@/components/channels/group-chat";
import { deploymentKeys } from "@/lib/deployment/queries";
import type { GroupMessage } from "@/lib/groups";
import { queryClient } from "@/query-client";
import { clearSkin, setSkin } from "@/skins/store";
import { settleReactWork } from "./settle-react-work";

/**
 * 员工在干活时，状态那一格前面有一个旋转的加载图标（期一）：单聊的「思考中」/「<员工名> 正在输入」、群聊里还在
 * 跑的那一行、顶栏「忙碌」的状态点。图标用应用已有的 tabler `IconLoader2`，转不转交给 `motion-safe:`：设了
 * 减少动画就不转，静止时也看得出是加载图标。不在干活时一个也不画。
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input), "http://localhost/");
      if (url.pathname === "/api/approvals")
        return Response.json({
          enabled: false,
          requests: [],
          rules: [],
          teamRules: [],
          questions: [],
        });
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  clearSkin();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const SPINNER = "[data-working-spinner]";

/** 转，但只在没设减少动画时转：类名是 `motion-safe:animate-spin`，不是光秃秃的 `animate-spin`。 */
function expectSpinner(found: Element | null | undefined) {
  expect(found).toBeTruthy();
  expect(found?.tagName.toLowerCase()).toBe("svg");
  const classes = (found?.getAttribute("class") ?? "").split(/\s+/);
  expect(classes).toContain("motion-safe:animate-spin");
  expect(classes).not.toContain("animate-spin");
  expect(found?.getAttribute("aria-hidden")).toBe("true");
}

const asked: Message[] = [
  { id: "u1", role: "user", content: "把三家竞品的报告写完" },
];

function transcript(busy: boolean, messages: Message[] = asked) {
  return (
    <QueryClientProvider client={queryClient}>
      <ChatRuntimeProvider>
        <ChatTranscript
          busy={busy}
          messages={messages}
          restoring={false}
          typist={{ name: "小研", agentId: "a1" }}
        />
      </ChatRuntimeProvider>
    </QueryClientProvider>
  );
}

test("the thinking line spins while the employee works", async () => {
  // 别的皮肤说「思考中」；默认皮肤说「<员工名> 正在输入」，见下一条。
  setSkin("openduet");
  const view = render(transcript(true));
  const line = await view.findByRole("status");
  // 原有文字一个字不动。
  expect(line.textContent).toBe("思考中");
  expectSpinner(line.querySelector(SPINNER));
});

test("the default skin's typing line spins too", async () => {
  setSkin("xiongbao");
  const view = render(transcript(true));
  const line = await view.findByRole("status");
  expect(line.textContent).toContain("小研 正在输入");
  expectSpinner(line.querySelector(SPINNER));
});

test("nothing spins once the employee is done", async () => {
  const view = render(
    transcript(false, [
      ...asked,
      { id: "a1", role: "assistant", content: "写完了。" },
    ]),
  );
  await view.findByText("写完了。");
  expect(view.container.querySelector(SPINNER)).toBeNull();
});

function groupLine(overrides: Partial<GroupMessage>) {
  const message: GroupMessage = {
    id: "m1",
    channelId: "g1",
    ownerUserId: "me",
    agentId: "ada",
    text: "",
    status: "running",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <GroupLine message={message} mine name="Ada" />
    </QueryClientProvider>,
  );
}

test("a group line still running spins beside 思考中", () => {
  const view = groupLine({});
  const line = view.getByRole("status");
  expect(line.textContent).toBe("思考中");
  expectSpinner(line.querySelector(SPINNER));
});

test("a group line streaming its answer spins by the name", () => {
  const view = groupLine({ text: "甲家写完了，正在查乙家" });
  expectSpinner(view.container.querySelector(SPINNER));
});

test("a finished group line does not spin", () => {
  const view = groupLine({ text: "写完了。", status: "completed" });
  expect(view.container.querySelector(SPINNER)).toBeNull();
});

const agent = {
  id: "a1",
  name: "小研",
  title: "调研员",
  avatarSeed: "a1",
  visibility: "private" as const,
};

function header(screen: ReactNode) {
  const client = new QueryClient();
  client.setQueryData(deploymentKeys.capabilities(), { edition: "team" });
  return render(
    <QueryClientProvider client={client}>{screen}</QueryClientProvider>,
  );
}

test("the header's busy dot becomes a spinner, still read as the working dot", () => {
  const view = header(
    <ConversationHeaderCard
      agent={agent as never}
      presence={{ agentId: "a1", status: "working", doing: "写竞品报告" }}
    />,
  );
  const line = view.container.querySelector("[data-presence]");
  expect(line?.textContent?.trim()).toBe("忙碌 · 写竞品报告");
  const dot = line?.querySelector('[data-status-dot="working"]');
  expectSpinner(dot);
  expect(dot?.matches(SPINNER)).toBe(true);
});

test("an idle header keeps its plain dot", () => {
  const view = header(
    <ConversationHeaderCard
      agent={agent as never}
      presence={{ agentId: "a1", status: "resting", doing: null }}
    />,
  );
  const line = view.container.querySelector("[data-presence]");
  expect(line?.querySelector('[data-status-dot="resting"]')).toBeTruthy();
  expect(line?.querySelector(SPINNER)).toBeNull();
});
