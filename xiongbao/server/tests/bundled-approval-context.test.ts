import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 回归测试（v0.2.16 线上问题）：网页单聊（`computerTools: "server"`，默认开）里，「改动之前先问」开着时，
 * `computer_write_file` 被答成 `ApprovalNeedsConversationError`，没有审批卡。
 *
 * 线上跑的不是 TypeScript 源码，而是镜像里用
 * `bun build server/src/index.ts --target=bun --minify --packages=external` 打出来的单文件（Dockerfile 的
 * server-bundle 阶段）。`--packages=external` 把 `@xiongbao/toolkit/*` 这种包名导入留在包外、运行时再从
 * node_modules 读；而相对路径导入（`../../../toolkit/src/headless-tools`）被内联进包里。于是：
 *
 * - `threads/chat-server-tools.ts` 用相对路径拿 `HeadlessToolsMiddleware` → 包内一份 `headless-tools.ts`，
 *   它的 `withApprovalContext` 来自包内一份 `continuation.ts`（自己的 AsyncLocalStorage）；
 * - `approvals/types.ts` 用 `@xiongbao/toolkit/continuation` 读 `currentApprovalContext` → 包外那份，另一个
 *   AsyncLocalStorage，永远是空的。
 *
 * 所以网关 `govern` 读到的续跑上下文是 undefined，`approvalAction` 抛 `ApprovalNeedsConversationError`。
 * 测试和本地 `bun run` 都直接跑源码，两个导入解析到同一个文件，所以一直没看出来。
 * 修法：server 里对 toolkit 一律用包名导入（`@xiongbao/toolkit/*`），由 `toolkit-imports.test.ts` 守住。
 *
 * 这里用和 Dockerfile 一样的打包参数，把一个只含生产接线（`createChatServerTools` + 真
 * `createComputerToolsForTurn` + 真 `createComputerGateway` + 真 `createApprovalService(...).gate`）的入口打成
 * 单文件再跑；同一个入口直接跑源码作对照。模型用一个只发一次 `computer_write_file` 调用的替身代理，
 * 审批存储用最小内存桩（「改动之前先问」开着，没有别的规则）。
 */

const SERVER = join(import.meta.dir, "..");
let scratch: string;
let entry: string;

const ENTRY = (server: string) => `
import { AbstractAgent, EventType } from "@ag-ui/client";
import { Observable } from "rxjs";
import { createApprovalService } from "${server}/src/approvals/service";
import { createComputerGateway } from "${server}/src/computer/gateway";
import { createComputerToolsForTurn } from "${server}/src/computer/turn-tools";
import { createChatServerTools } from "${server}/src/threads/chat-server-tools";

/** 「改动之前先问」开着、没有别的规则的人：只用到 gate 问人那条路。 */
const opened = [];
const store = {
  enabled: async () => true,
  open: async (action) => {
    opened.push(action);
    return { id: "request-1", status: "pending", decision: null, action };
  },
};
const service = createApprovalService(store);

const reached = [];
const gateway = createComputerGateway({
  provider: {
    name: "test",
    isolation: "per-person",
    locate: async () => "http://computer:4100",
    status: async (seat) => ({ botId: seat.botId, state: "ready" }),
    list: async () => [],
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
  },
  auditStore: { insert: async () => undefined },
  policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
  approvalGate: (candidate) => service.gate(candidate),
  fetchImpl: async (url, init) => {
    reached.push(String(url));
    return Response.json({ path: "test.txt", bytes: 21 });
  },
});

const toolsForTurn = createComputerToolsForTurn({
  gateway,
  actorFor: async (id) => ({ id, role: "user" }),
  profileOf: async () => ({ visibility: "private", ownerUserId: "person-1", type: "built_in" }),
  auditStore: { insert: async () => undefined },
  machine: "workspace",
  usesDeviceApps: async () => false,
  disabledTools: async () => () => false,
});

/** 模型替身：第一次运行调 computer_write_file，拿到结果后说一句 done。 */
class ScriptedBot extends AbstractAgent {
  run(input) {
    return new Observable((subscriber) => {
      const answered = input.messages.some((message) => message.role === "tool");
      const ids = { threadId: input.threadId, runId: input.runId };
      subscriber.next({ type: EventType.RUN_STARTED, ...ids });
      if (answered) {
        subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId: "m2", role: "assistant" });
        subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m2", delta: "done" });
        subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId: "m2" });
      } else {
        subscriber.next({ type: EventType.TOOL_CALL_START, toolCallId: "call-1", toolCallName: "computer_write_file", parentMessageId: "m1" });
        subscriber.next({ type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: JSON.stringify({ path: "test.txt", contents: "line 1\\nline 2\\nline 3\\n" }) });
        subscriber.next({ type: EventType.TOOL_CALL_END, toolCallId: "call-1" });
      }
      subscriber.next({ type: EventType.RUN_FINISHED, ...ids });
      subscriber.complete();
    });
  }
}

export async function chatTurn() {
  const chat = createChatServerTools({ toolsForTurn, holds: () => true });
  const bot = new ScriptedBot({ agentId: "ppt" });
  chat.attach({ ppt: bot }, { id: "person-1", role: "user" });
  bot.threadId = "channel_00000000-0000-4000-8000-000000000001";
  bot.setMessages([{ id: "u1", role: "user", content: "在你的工作区创建 test.txt，写三行。" }]);
  const events = [];
  await bot.runAgent(
    { runId: "run-1", forwardedProps: { computerTools: "server" } },
    { onEvent: ({ event }) => { events.push(event); } },
  );
  return {
    events: events.map((event) => (event.type === "CUSTOM" ? "CUSTOM:" + event.name : event.type)),
    results: events.filter((event) => event.type === "TOOL_CALL_RESULT").map((event) => String(event.content)),
    opened: opened.map((action) => action.continuation?.toolCallId ?? null),
    reached,
  };
}
`;

type Turn = {
  events: string[];
  results: string[];
  opened: (string | null)[];
  reached: string[];
};

beforeAll(async () => {
  // Inside server/, so the bundle's external `@xiongbao/*` and npm imports resolve the way /app/server/dist's do.
  scratch = await mkdtemp(join(SERVER, ".bundled-approval-"));
  entry = join(scratch, "entry.ts");
  await writeFile(entry, ENTRY(SERVER));
  // The Dockerfile's own flags (stage server-bundle).
  const built = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    minify: true,
    packages: "external",
    outdir: join(scratch, "dist"),
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const NEEDS_CONVERSATION = "not started from a conversation that can ask you";

function expectAskedForApproval(turn: Turn) {
  // Never refused for want of a conversation.
  expect(turn.results.some((r) => r.includes(NEEDS_CONVERSATION))).toBe(false);
  // Held for the person: an approval opened for this very call, nothing sent to the computer.
  expect(turn.opened).toEqual(["call-1"]);
  expect(turn.reached).toEqual([]);
  // And the turn stops to wait for them (the card is drawn from this).
  expect(turn.events).toContain("CUSTOM:xiongbao.headless.waiting");
}

describe("web single chat, server-run computer tools, ask before changes on", () => {
  test("control: from source (how every test runs) the write is held for approval", async () => {
    const { chatTurn } = (await import(entry)) as {
      chatTurn: () => Promise<Turn>;
    };
    expectAskedForApproval(await chatTurn());
  });

  test("as the image runs it (bun build --packages=external), the write is held for approval too", async () => {
    const { chatTurn } = (await import(join(scratch, "dist", "entry.js"))) as {
      chatTurn: () => Promise<Turn>;
    };
    expectAskedForApproval(await chatTurn());
  });
});
