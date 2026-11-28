import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import { DeliveryEvidence } from "@/routes/_authed/_app/tasks.$taskId";
import { settleReactWork } from "./settle-react-work";

/*
 * 任务页「交付物与证据」的工作区文件也能预览（v0.2.17 验收 1b）：和对话里的交付卡同一个「预览」按钮、
 * 同一个预览面板，范围是这张卡（`task=`）。服务器按 #845 的 `deliverable_ref.seat` 找文件所在的电脑，
 * 旧卡没有座位时按 #845 的回退；页面只管带上 `task`。程序行照旧在新标签页打开，不进面板。
 */

const originalFetch = globalThis.fetch;
const ui = () => within(document.body);
let registeredHere = false;

beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register({ url: "http://localhost/" });
    registeredHere = true;
  }
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function serve(): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost/");
    asked.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/files/text"))
      return Response.json({
        kind: "text",
        text: "核对完了",
        truncated: false,
      });
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  return asked;
}

const deliverable = {
  kind: "deliverable",
  workspaceFiles: ["测试-test.txt", "logo.svg"],
  apps: [{ port: 8000, path: "/", title: "销售看板" }],
};

test("a workspace file on the task page has 预览, and it opens the pane scoped by the card", async () => {
  const asked = serve();
  render(
    <DeliveryEvidence agentId="bot-1" deliverable={deliverable} taskId="t1" />,
  );
  const button = ui().getByRole("button", { name: "预览 测试-test.txt" });
  // 只能下载的类型没有「预览」，下载照旧。
  expect(ui().queryByRole("button", { name: "预览 logo.svg" })).toBeNull();
  expect(ui().getAllByRole("link", { name: "下载" })).toHaveLength(2);
  expect(document.querySelector("[data-artifact-preview]")).toBeNull();

  await act(async () => {
    button.click();
  });
  await waitFor(() =>
    expect(document.querySelector("[data-artifact-preview]")).not.toBeNull(),
  );
  await waitFor(() => expect(ui().getByText("核对完了")).toBeTruthy());
  expect(asked).toContain(
    "/api/computers/bot-1/files/text?path=%E6%B5%8B%E8%AF%95-test.txt&task=t1",
  );

  // 关掉回到任务页。
  await act(async () => {
    ui().getByRole("button", { name: "关闭预览" }).click();
  });
  await waitFor(() =>
    expect(document.querySelector("[data-artifact-preview]")).toBeNull(),
  );
  expect(ui().getByRole("button", { name: "预览 测试-test.txt" })).toBeTruthy();
});

test("without the card's employee there is no 预览, as there is no download", () => {
  serve();
  render(
    <DeliveryEvidence agentId={null} deliverable={deliverable} taskId="t1" />,
  );
  expect(ui().queryByRole("button", { name: /^预览/ })).toBeNull();
  expect(ui().queryByRole("link", { name: "下载" })).toBeNull();
});
