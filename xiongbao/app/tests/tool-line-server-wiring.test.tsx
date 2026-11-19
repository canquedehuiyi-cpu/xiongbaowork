import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { ServerToolLine } from "@/components/channels/chat-transcript";
import { resultFacts } from "@/components/channels/tool-activity";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * 单工具行（ServerToolLine）上，结果自己带的那两个事实也要说出来（WP-3.2 S0）。
 *
 * 分组步骤行早就说耗时与退出码（`tool-elapsed.test.tsx` 钉着），单独成行的那一条以前只传
 * label/refused/failed/running，结果里量出来的耗时白白丢了。这一组把同一条律复制到单行路径：
 * 带了就要说出来，没带就一个字也不许多——不许出现「-」「0.0s」这种占位。文案零新增：说的还是
 * `elapsedWords`/`failureWords` 那两句既有话。
 *
 * 一处口径更正（对规格测试清单，leader 裁决，见 fix-plan §4.8）：原拟用例「a nonzero exit code
 * is said on a single tool line」在现解析器下不可达——`toolResultFailed` 只认三个英文前缀串，
 * `readOutcome` 只整串 JSON 解析，失败标记与退出码测量在同一条结果上互斥。本票红线是不改这两个
 * 解析器的行为，所以这里改为钉住：失败但没测量的一步不造退出码、不造占位；另在导出级断言
 * `resultFacts` 三属性透传无损，证接线的数据路是通的。
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // 与 tool-elapsed 同一套桩：审批收件箱一条也不在。
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

/** 行上的耗时长什么样：秒、一位小数。用来断言「没带就没有」。 */
const DURATION = /\d+(?:\.\d+)?s\b/;

function line(name: string, args: Record<string, unknown>, result?: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ServerToolLine args={JSON.stringify(args)} name={name} result={result} />
    </QueryClientProvider>,
  );
}

test("a server-side tool line says how long it took when the result says so", () => {
  const view = line(
    "computer_navigate",
    { url: "https://example.com" },
    JSON.stringify({
      elapsedMs: 2400,
      ok: true,
      // 成功的一步带着退出码 0：退出码是失败那一步的事，成功行上一个字不改。
      exitCode: 0,
      title: "Example",
      url: "https://example.com",
      visited: true,
    }),
  );
  expect(view.getByText("2.4s")).toBeTruthy();
  expect(view.queryByText(/退出码/)).toBeNull();
  expect(view.queryByText(/没有成功/)).toBeNull();
});

test("a failed step with nothing measured adds no exit code and no placeholder", () => {
  // 服务端工具门认得的那句失败前缀（tool-result.ts 的 toolResultFailed）：它是 plain 文本，
  // 解析不出测量值——这一步失败了，但没量出耗时、没带退出码，行上就不许编一个。
  const view = line(
    "mcp__composio-gmail__GMAIL_FETCH_EMAILS",
    {},
    "The vendor reported an error:\nboomed",
  );
  expect(view.getByText(/没有成功/)).toBeTruthy();
  expect(DURATION.test(view.container.textContent ?? "")).toBe(false);
  expect(view.queryByText(/退出码/)).toBeNull();
  expect(view.queryByText("-")).toBeNull();
  expect(view.queryByText("—")).toBeNull();

  // 接线的数据路本身是通的：结果写了三样，resultFacts 就原样搬三样（单行与分组行共用这一份）。
  expect(
    resultFacts(JSON.stringify({ elapsedMs: 2400, exitCode: 2, error: "boom" })),
  ).toEqual({ elapsedMs: 2400, exitCode: 2, failure: "boom" });
});

test("a single tool result with nothing measured adds no duration and no placeholder", () => {
  const view = line(
    "computer_navigate",
    { url: "https://example.com" },
    JSON.stringify({ ok: true, title: "Example", url: "https://example.com" }),
  );
  expect(DURATION.test(view.container.textContent ?? "")).toBe(false);
  expect(view.queryByText("-")).toBeNull();
  expect(view.queryByText("—")).toBeNull();
  // 行还是那条行：没测量只是少说一件事，不是不画。
  expect(view.container.textContent).toBeTruthy();
});