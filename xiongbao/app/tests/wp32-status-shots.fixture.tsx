import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TurnClosedVariant } from "@/lib/channels/turn-closed";

/**
 * 状态行实时耗时的五个画面（WP-3.2 S1a）＋终态行的五个画面（WP-3.2 S1b，设计稿 §2.8），
 * 一页一个，供 wp32-status-shots.test.tsx 打包进 Chromium 截图取证。画面按地址的 `#片段` 选：
 * model／tool／answer／typing／observed（S1a，原样不动）；
 * turn-closed--idle-dark／--cancelled-dark／--awaiting-approval-dark／--stopped-error-dark
 * （互斥对照）／--empty-thread-dark（零噪音对照）（S1b）。
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
  /** S1b 终态画面：给了 messages 就用它；busy 不给默认 true（S1a 的在跑画面）。 */
  messages?: Message[];
  busy?: boolean;
  closed?: TurnClosedVariant;
  stopped?: string;
};

/** 一轮说完话的转录（S1b）：人问一句，员工答一句。 */
function answeredTurn(): Message[] {
  return [
    { id: "u1", role: "user", content: "把最近的邮件总结一下。" },
    {
      id: "a1",
      role: "assistant",
      content: "最近三封都是季度数字：营收环比持平，成本略降。",
    },
  ];
}

/** 子任务交还的结果（S1b）：shared/subagent.ts 的合同，readSubagentResult 读得出的那一种。 */
const HANDED_BACK = JSON.stringify({
  handedBack: {
    tool: "computer_click",
    args: { selector: "#pay" },
    reason: "needs-approval",
    said: "要付款了，这一步得你点头。",
  },
  next: "Do it yourself in the conversation, where the person is asked.",
  threadId: "11111111-1111-4111-8111-111111111111",
  steps: 3,
});

/** 一轮里派了个子任务、子任务在待批动作前交还的转录（S1b）。 */
function handedBackTurn(): Message[] {
  return [
    { id: "u1", role: "user", content: "帮我把这单付了。" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-sub",
          type: "function",
          function: {
            name: "run_subagent",
            arguments: JSON.stringify({ task: "走到付款页" }),
          },
        },
      ],
    },
    { id: "t1", role: "tool", toolCallId: "call-sub", content: HANDED_BACK },
    { id: "a2", role: "assistant", content: "走到付款页了，最后一步要你点头。" },
  ];
}

const SCENES: Record<string, Scene> = {
  model: { answered: true, stage: "model" },
  tool: { answered: false, stage: "tool" },
  answer: { answered: true, stage: "answer" },
  typing: { answered: true, typist: { name: "雄宝", agentId: "expenses" } },
  observed: { answered: true, stage: "model", observed: true },
  // S1b（设计稿 §2.8）：三个正性版本＋出错互斥对照＋空 thread 零噪音对照。
  "turn-closed--idle-dark": {
    answered: true,
    messages: answeredTurn(),
    busy: false,
    closed: "idle",
  },
  "turn-closed--cancelled-dark": {
    answered: true,
    messages: answeredTurn(),
    busy: false,
    closed: "cancelled",
  },
  "turn-closed--awaiting-approval-dark": {
    answered: true,
    messages: handedBackTurn(),
    busy: false,
    closed: "awaiting_approval",
  },
  // 互斥对照：版本置了位，但失败句（Stopped）永远抢先，两句话不同屏。
  "turn-closed--stopped-error-dark": {
    answered: true,
    messages: answeredTurn(),
    busy: false,
    closed: "idle",
    stopped: "员工停下了，没有说原因。",
  },
  // 零噪音对照：空 thread 就算版本被置了位也一个字不说。
  "turn-closed--empty-thread-dark": {
    answered: true,
    messages: [],
    busy: false,
    closed: "idle",
  },
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
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
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
                busy={scene.busy ?? true}
                closed={scene.closed}
                elapsedMs={135_000}
                elapsedObserved={scene.observed}
                messages={scene.messages ?? run(scene.answered)}
                restoring={false}
                stage={scene.stage}
                stopped={scene.stopped}
                typist={scene.typist}
              />
            </div>
          </TooltipProvider>
        </ThemeProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}