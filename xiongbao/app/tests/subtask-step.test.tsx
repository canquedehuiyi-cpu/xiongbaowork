import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  CopilotChatConfigurationProvider,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { subagentThreadId } from "@openbot/shared/subagent";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";
import { answered, handedBack, type RecordedSubtask } from "./subagent.fixture";

/**
 * A Bot's subtask, drawn by the real transcript as one step of the line its turn's work folds into,
 * from a call, a result and a subagent thread recorded off a real run (see the fixture). The
 * subagent's steps are read through the same route a conversation's history is, answered here the
 * way the server answered it, and only once its row is opened.
 */

const originalFetch = globalThis.fetch;
/** The subagent threads the history route serves, by id. */
const served = new Map<string, unknown[]>();

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost/").pathname;
      const id = /^\/api\/copilotkit\/threads\/([^/]+)\/messages$/.exec(
        path,
      )?.[1];
      const messages = id ? served.get(decodeURIComponent(id)) : undefined;
      return messages
        ? Response.json({ messages })
        : Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  served.clear();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** The person's ask, the Bot's call, and its result when there is one. */
function turn(subtask: RecordedSubtask, settled: boolean): Message[] {
  return [
    {
      id: "ask",
      role: "user",
      content: "Which account needs attention first?",
    },
    {
      id: "call-message",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: subtask.call.id,
          type: "function",
          function: { name: subtask.call.name, arguments: subtask.call.args },
        },
      ],
    },
    ...(settled
      ? [
          {
            id: "result",
            role: "tool" as const,
            toolCallId: subtask.call.id,
            content: subtask.result,
          },
        ]
      : []),
  ];
}

function wrap(parentThreadId: string, transcript: ReactElement) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <CopilotChatConfigurationProvider
          agentId="general-assistant"
          threadId={parentThreadId}
        >
          {transcript}
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

async function draw(
  subtask: RecordedSubtask,
  { settled, busy }: { settled: boolean; busy: boolean },
  steps: unknown[] = subtask.subagent,
) {
  served.set(
    await subagentThreadId(subtask.parentThreadId, subtask.call.id),
    steps,
  );
  return render(
    wrap(
      subtask.parentThreadId,
      <ChatTranscript
        busy={busy}
        messages={turn(subtask, settled)}
        restoring={false}
      />,
    ),
  );
}

/** Opens a disclosure by its line, as a person clicking it would. */
function open(line: HTMLElement) {
  const details = line.closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

/** The subtask's own row, opened, from inside the turn's folded work line. */
async function subtaskRow(view: Awaited<ReturnType<typeof draw>>) {
  const row = (await view.findByText("子任务")).closest("li") as HTMLElement;
  open(row.querySelector("summary") as HTMLElement);
  return within(row);
}

test("each subtask is a card of its own, titled with the start of its task", async () => {
  const view = await draw(answered, { settled: true, busy: false });
  expect(await view.findByText("执行了一个子任务")).toBeTruthy();
  // 一张独立的卡，不收在「用了几个工具」那一行里。
  const cards = view.container.querySelectorAll("[data-subagent-card]");
  expect(cards).toHaveLength(1);
  expect(cards[0]?.closest("details:not([data-subagent-card])")).toBeNull();
  // 卡的标题是它的任务开头 30 个字，旁边说它做完了、走了几步。
  const line = within(
    view.getByText("子任务").closest("summary") as HTMLElement,
  );
  expect(line.getByText("For customer account Birch Lab…")).toBeTruthy();
  expect(line.getByText("已完成")).toBeTruthy();
  expect(line.getByText("2 个步骤")).toBeTruthy();
});

test("while it works, the line says so, and the row opens to each step as the subagent takes it", async () => {
  // Its first step only: the subagent has asked for the account and the tickets, and nothing is back.
  const view = await draw(answered, { settled: false, busy: true }, [
    ...answered.subagent.slice(0, 2),
  ]);
  expect(await view.findByText("正在处理一个子任务…")).toBeTruthy();
  const row = await subtaskRow(view);
  expect(row.getByText("工作中")).toBeTruthy();
  expect(await row.findByText("Get account")).toBeTruthy();
  expect(row.getByText("List open tickets")).toBeTruthy();
  expect(row.getAllByText("进行中")).toHaveLength(2);
});

test("when it is done, its row opens to the answer and the steps it took", async () => {
  const view = await draw(answered, { settled: true, busy: false });
  const row = await subtaskRow(view);
  // The answer, drawn as the Bot wrote it. The step that read the account says the same name inside it.
  expect(row.getAllByText(/Marco Diaz/).length).toBeGreaterThan(0);
  expect(await row.findByText("Get account")).toBeTruthy();
  expect(row.getByText("List open tickets")).toBeTruthy();
  // Finished steps do not say they are in progress.
  expect(row.queryByText("进行中")).toBeNull();
});

test("an action it handed back is said plainly, and nothing asks for an approval it cannot give", async () => {
  const view = await draw(handedBack, { settled: true, busy: false });
  expect(await view.findByText("已交还")).toBeTruthy();
  expect(view.queryByText("Needs your approval")).toBeNull();
  const row = await subtaskRow(view);
  const notice = within(row.getByRole("region", { name: "已交还" }));
  expect(notice.getByText(/员工会在这段对话里问你/)).toBeTruthy();
  expect(notice.getByText("List open tickets（accounts）")).toBeTruthy();
  expect(notice.getByText("Acme Robotics")).toBeTruthy();
  // Why it stopped is on the card too, in the person's words and not the sentence meant for the Bot.
  expect(notice.getByText(/它停下来的原因：这一步在等你批准。/)).toBeTruthy();
  expect(notice.queryByText(/This action is waiting/)).toBeNull();
});

test("a subtask its turn left behind says it never finished, and one the server refused says so", async () => {
  const stopped = await draw(answered, { settled: false, busy: false });
  expect(await stopped.findByText("未完成")).toBeTruthy();
  expect(stopped.queryByText("工作中")).toBeNull();
  cleanup();

  const refused = await draw(
    {
      ...answered,
      result: JSON.stringify(
        "Refused. No subagent was started: one answer can start up to 5 subagents, and this one has. Do this part yourself.",
      ),
    },
    { settled: true, busy: false },
  );
  expect(await refused.findByText("已拦下")).toBeTruthy();
  // Nothing ran to be timed, so the line claims no time for it.
  expect(refused.queryByText(/耗时/)).toBeNull();
});

test("subtasks started together are cards side by side, counted while their turn runs", async () => {
  // Two calls in one step, neither answered yet: the second row is drawn under the first.
  const first = answered;
  const second = { ...handedBack, parentThreadId: answered.parentThreadId };
  const view = await draw(first, { settled: false, busy: true }, [
    ...first.subagent.slice(0, 2),
  ]);
  view.rerender(
    wrap(
      first.parentThreadId,
      <ChatTranscript
        busy
        messages={[
          ...turn(first, false),
          {
            id: "second-call",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: second.call.id,
                type: "function",
                function: {
                  name: second.call.name,
                  arguments: second.call.args,
                },
              },
            ],
          },
        ]}
        restoring={false}
      />,
    ),
  );
  expect(await view.findByText("正在处理 2 个子任务…")).toBeTruthy();
  // 同一步派出的两张卡排在同一组里，各自转着。
  const group = view.container.querySelector("[data-subagent-cards]");
  expect(group?.querySelectorAll("[data-subagent-card]")).toHaveLength(2);
  expect(view.getAllByText("子任务")).toHaveLength(2);
  expect(view.getAllByText("工作中")).toHaveLength(2);
  expect(group?.querySelectorAll("[data-working-spinner]")).toHaveLength(2);
  expect(view.queryByText("未完成")).toBeNull();
});

/* --------------------------------------------------------------------------------------------
 * What the row says when the subtask ends.
 *
 * The server's account of a run — why it stopped, what it had said, how long it took — is written
 * for the Bot that asked for the work. On this page it belongs to the person, so it is read here in
 * the words a person uses, and a result written before any of it was carried says no more about the
 * run than it used to.
 * ------------------------------------------------------------------------------------------ */

/**
 * The same subtask, with its result carrying what the server now writes on it.
 *
 * The change is made to the decoded object, because `said` rides inside `handedBack` and `ms` beside
 * it: a flat merge would put what belongs to the stop next to the stop's own outcome.
 */
function withResult(
  subtask: RecordedSubtask,
  change: (result: Record<string, unknown>) => Record<string, unknown>,
): RecordedSubtask {
  const result = JSON.parse(JSON.parse(subtask.result) as string) as Record<
    string,
    unknown
  >;
  // Stored the way the server sends it: its JSON, encoded once more as the tool message's text.
  const text = JSON.stringify(JSON.stringify(change(result)));
  return { ...subtask, result: text };
}

/** What it had said before it stopped, which is a line of its own on the card. */
const hadSaid =
  "The account is on the Team plan. I need your yes before listing its tickets.";

/** A call the server refused before a run started, which is a sentence rather than a result. */
function refusedFor(say: string): RecordedSubtask {
  return { ...answered, result: JSON.stringify(`${REFUSAL_MARKER} ${say}`) };
}

/** The subtask's line in the work line, as it stands without anyone opening it. */
async function subtaskLine(view: Awaited<ReturnType<typeof draw>>) {
  return within(
    (await view.findByText("子任务")).closest("summary") as HTMLElement,
  );
}

test("a subtask says how long its run took, and one written before it was timed says nothing about time", async () => {
  const spent = await draw(
    withResult(answered, (result) => ({ ...result, ms: 12_345 })),
    { settled: true, busy: false },
  );
  expect(
    await (await subtaskLine(spent)).findByText("2 个步骤 · 耗时 12.3 秒"),
  ).toBeTruthy();
  cleanup();

  // The result as it was written before the server timed a run: the steps, and no claim about time.
  const untimed = await draw(answered, { settled: true, busy: false });
  expect((await subtaskLine(untimed)).getByText("2 个步骤")).toBeTruthy();
  expect(untimed.queryByText(/耗时/)).toBeNull();
  cleanup();

  // While it works there is nothing to measure yet, whatever the turn is doing around it.
  const working = await draw(
    withResult(answered, (result) => ({ ...result, ms: 12_345 })),
    { settled: false, busy: true },
  );
  expect((await subtaskLine(working)).getByText("工作中")).toBeTruthy();
  expect(working.queryByText(/耗时/)).toBeNull();
});

test("a handed-back subtask says why it stopped and what it had said before stopping", async () => {
  const view = await draw(
    withResult(handedBack, (result) => ({
      ...result,
      handedBack: {
        ...(result.handedBack as Record<string, unknown>),
        said: hadSaid,
      },
    })),
    { settled: true, busy: false },
  );
  const row = await subtaskRow(view);
  const notice = within(row.getByRole("region", { name: "已交还" }));
  // The gate's sentence is an instruction to the Bot, so the card gives it as the reason it stopped.
  expect(notice.getByText(/它停下来的原因：这一步在等你批准。/)).toBeTruthy();
  expect(notice.queryByText(/This action is waiting/)).toBeNull();
  // What it had said is its own account, and is given as it wrote it.
  expect(notice.getByText(/它停下来时说的/)).toBeTruthy();
  expect(
    await notice.findByText(/I need your yes before listing its tickets/),
  ).toBeTruthy();
  cleanup();

  // `reason` is part of the hand-back's contract — a result without it is not read as a hand-back at
  // all — so the shape from before this was carried is the reason without an account of its own.
  const untold = await draw(handedBack, { settled: true, busy: false });
  const untoldNotice = within(
    (await subtaskRow(untold)).getByRole("region", { name: "已交还" }),
  );
  expect(untoldNotice.getByText(/它停下来的原因/)).toBeTruthy();
  expect(untoldNotice.queryByText(/它停下来时说的/)).toBeNull();
  expect(untold.queryByText(/耗时/)).toBeNull();
});

test("a subtask that did not finish is said in the person's words, whatever the server's reason was", async () => {
  const stopped = await draw(
    withResult(answered, (result) => ({
      ...result,
      answer: undefined,
      error:
        "The subagent did not finish: The routine's turn was stopped after 300s.",
      ms: 301_000,
    })),
    { settled: true, busy: false },
  );
  const line = await subtaskLine(stopped);
  expect(line.getByText(/没能完成 · 耗时 5 分 1 秒/)).toBeTruthy();
  const row = await subtaskRow(stopped);
  expect(
    await row.findByText(/它运行了 300 秒后被停下来，没能给出答案。/),
  ).toBeTruthy();
  expect(row.queryByText(/did not finish/)).toBeNull();
  cleanup();

  // A reason nobody has words for yet is still shown, rather than quietly left off the page.
  const other = await draw(
    withResult(answered, (result) => ({
      ...result,
      answer: undefined,
      error: "The subagent did not finish: The provider is unavailable.",
    })),
    { settled: true, busy: false },
  );
  expect((await subtaskLine(other)).getByText(/没能完成/)).toBeTruthy();
  expect(
    await (await subtaskRow(other)).findByText(
      /它没能完成：The provider is unavailable\./,
    ),
  ).toBeTruthy();
});

test("a call refused before any run started says what it was refused for", async () => {
  // One more call than an answer is given: the reason the Bot is told is the reason shown.
  const capped = await draw(
    refusedFor(
      "No subagent was started: one answer can start up to 5 subagents, and this one has. Do this part yourself.",
    ),
    { settled: true, busy: false },
  );
  expect((await subtaskLine(capped)).getByText("已拦下")).toBeTruthy();
  // Nothing ran, so there is no time to claim for it.
  expect(capped.queryByText(/耗时/)).toBeNull();
  const row = await subtaskRow(capped);
  expect(
    await row.findByText(/一次运行最多启动 5 个子任务，这一次已经用完了/),
  ).toBeTruthy();
  expect(row.queryByText(/one answer can start up to/)).toBeNull();
  cleanup();

  const checkin = await draw(
    refusedFor(
      "No subagent was started: in a task from a check-in, every step is checked with the person in this conversation. Do this part yourself.",
    ),
    { settled: true, busy: false },
  );
  expect(
    await (await subtaskRow(checkin)).findByText(
      /这个任务里每一步都要在这段对话里问你/,
    ),
  ).toBeTruthy();
  cleanup();

  const unclear = await draw(
    refusedFor(
      "No subagent was started: say what the task is and what answer you want back.",
    ),
    { settled: true, busy: false },
  );
  expect(
    await (await subtaskRow(unclear)).findByText(/没有说清任务和要回来的答案/),
  ).toBeTruthy();
});
