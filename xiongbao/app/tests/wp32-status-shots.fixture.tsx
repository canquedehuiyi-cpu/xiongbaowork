import type { Message } from "@ag-ui/core";
import { CopilotKitProvider as ChatRuntimeProvider } from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * 状态行实时耗时的五个画面（WP-3.2 S1a），一页一个，供 wp32-status-shots.test.tsx 打包进 Chromium
 * 截图取证。画面按地址的 `#片段` 选：model／tool／answer／typing／observed。
 *
 * 都是真组件、真样式：转录是 `ChatTranscript` 本人，深色走 `ThemeProvider` 读 localStorage 的产品
 * 逻辑（测试在页面加载前把 `xiongbao-theme` 置成 dark），不是手挂 class。默认皮肤就是工作台
 * （`DEFAULT_SKIN` = xiongbao），「<员工名> 正在输入」给 typist 就画。
 */

const EMAILS = '{"messages":[{"subject":"Quarterly numbers"}]}';

function step(n: number, tool: string, result?: string): Message[] {
  const id = `call-${n}`;
  return [
    {
      id: `a-${n}`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: {
            name: `mcp__composio-gmail__${tool}`,
            arguments: JSON.stringify({ page: n }),
          },
        },
      ],
    },
    ...(result === undefined
      ? []
      : [
          {
            id: `t-${n}`,
            role: "tool" as const,
            toolCallId: id,
            content: result,
          },
        ]),
  ];
}

function run(lastAnswered: boolean): Message[] {
  return [
    { id: "u1", role: "user", content: "Summarize my recent unread emails." },
    ...step(1, "GMAIL_FETCH_EMAILS", EMAILS),
    ...step(
      2,
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      lastAnswered ? EMAILS : undefined,
    ),
  ];
}

type Scene = {
  answered: boolean;
  stage?: "model" | "tool" | "answer";
  typist?: { name: string; agentId: string };
  observed?: boolean;
};

const SCENES: Record<string, Scene> = {
  model: { answered: true, stage: "model" },
  tool: { answered: false, stage: "tool" },
  answer: { answered: true, stage: "answer" },
  typing: { answered: true, typist: { name: "雄宝", agentId: "expenses" } },
  observed: { answered: true, stage: "model", observed: true },
};

const scene = SCENES[location.hash.slice(1)] ?? SCENES.model;
if (!scene) throw new Error("the model scene is always there");

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <ChatRuntimeProvider runtimeUrl="/api/runtime">
        <ThemeProvider>
          <TooltipProvider>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                height: "100vh",
              }}
            >
              <ChatTranscript
                busy
                elapsedMs={135_000}
                elapsedObserved={scene.observed}
                messages={run(scene.answered)}
                restoring={false}
                stage={scene.stage}
                typist={scene.typist}
              />
            </div>
          </TooltipProvider>
        </ThemeProvider>
      </ChatRuntimeProvider>
    </QueryClientProvider>,
  );
}
