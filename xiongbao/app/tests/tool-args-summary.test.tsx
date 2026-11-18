import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { VisibleChatItem } from "../src/components/channels/chat-messages";
import { ServerToolLine } from "../src/components/channels/chat-transcript";
import {
  stepDetails,
  type ToolGroup,
  ToolActivity,
} from "../src/components/channels/tool-activity";
import { acpStepDetail, readAcpStep } from "../src/lib/channels/acp-args";
import { queryClient } from "../src/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * 外部员工那一步在参数里报出来的事实，两条通道说同一句话。
 *
 * 对话里单独成行的那一步（`ServerToolLine`）和折叠成列表的那一步（`ToolActivity`）以前各写一套读法，
 * 于是同一步在两处可以说不一样。现在两处都读 `lib/channels/acp-args.ts` 那一份：这一组断言既钉住这句话
 * 的内容，也钉住「两处一模一样」。参数太长时只说「省略」和原长度，绝不把原文搬到屏幕上（服务器已经
 * 没往下发，这里也不去猜）。
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // 折叠起来的那一行会问审批收件箱（`PendingApprovals`），这里一条也不在。
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
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

const ARGS = JSON.stringify({
  kind: "execute",
  locations: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
  rawInput: '{"command":"echo SECRET"}',
  title: "Run bun test",
});

function acpStep(result?: string): ToolItem {
  return {
    kind: "tool",
    id: "acp-1",
    toolCall: {
      function: { arguments: ARGS, name: "acp/execute" },
      id: "acp-1",
      type: "function",
    },
    ...(result === undefined ? {} : { result }),
  };
}

function activity(step: ToolItem) {
  const group: ToolGroup = { id: "g", kind: "tools", steps: [step] };
  return render(
    <QueryClientProvider client={queryClient}>
      <ToolActivity active={false} group={group} />
    </QueryClientProvider>,
  );
}

test("the two shapes of the same arguments read the same way", () => {
  const given = {
    kind: "execute",
    locations: [{ path: "src/a.ts" }],
    rawInput: "{}",
    title: "Run bun test",
  };
  expect(readAcpStep(JSON.stringify(given))).toEqual(readAcpStep(given));
  expect(readAcpStep("not json")).toBeNull();
  expect(readAcpStep("[1,2]")).toBeNull();
});

test("the line says what it ran and which files it touched", () => {
  expect(acpStepDetail(ARGS)).toBe("Run bun test · src/a.ts 等 2 个文件");
  const one = { kind: "edit", locations: [{ path: "notes/todo.md" }] };
  expect(acpStepDetail(one)).toBe("notes/todo.md");
});

test("a parameter too long to be sent is said, with its length when it is known", () => {
  const told = {
    kind: "execute",
    locations: [],
    rawInputLength: 4200,
    rawInputTruncated: true,
    title: "git push origin fix/login",
  };
  expect(acpStepDetail(told)).toBe(
    "git push origin fix/login · 参数过长已省略（原长 4200 字）",
  );
  // 长度没带（这一步是在 `rawInputLength` 之前存下来的）就只说省略，不补一个数。
  const blind = { ...told, rawInputLength: undefined };
  expect(acpStepDetail(blind)).toBe("git push origin fix/login · 参数过长已省略");
});

test("what the step did not report is not written", () => {
  // 只有协议名：那一件事行首的中文标签已经说了，摘要不重复它，也不编一句别的。
  expect(acpStepDetail({ kind: "execute" })).toBeUndefined();
  expect(acpStepDetail(undefined)).toBeUndefined();
  expect(acpStepDetail('{"title":"   "}')).toBeUndefined();
});

test("the long ones are cut, and never carry the parameter itself", () => {
  const deep = {
    kind: "edit",
    locations: [{ path: `src/${"nested/".repeat(12)}a.ts` }],
    rawInput: '{"secret":"SECRET"}',
    title: "T".repeat(120),
  };
  const said = acpStepDetail(deep);
  expect(said?.includes("SECRET")).toBe(false);
  expect((said?.split(" · ")[0] ?? "").length).toBe(80);
  expect(said?.includes("…")).toBe(true);
});

test("the folded step list draws that sentence", () => {
  const shared = acpStepDetail(ARGS);
  expect(shared).toBeDefined();
  // 步骤列表那一通道：读参数的是同一份代码，画出来也是同一句。
  expect(stepDetails(acpStep()).detail).toBe(shared);
  expect(activity(acpStep()).getByText(shared ?? "")).toBeTruthy();
});

test("the line drawn alone in the conversation says the same", () => {
  const shared = acpStepDetail(ARGS);
  expect(shared).toBeDefined();
  // 对话里单独成行的那一通道，说的是同一句。
  const alone = render(
    <QueryClientProvider client={queryClient}>
      <ServerToolLine args={ARGS} name="acp/execute" />
    </QueryClientProvider>,
  );
  expect(alone.getByText(shared ?? "")).toBeTruthy();
});
