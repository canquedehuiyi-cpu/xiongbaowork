import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { RERUN_WARNING, rerunsOf, rerunWarningOf } from "@/lib/tasks/delivery";
import { DeliveryEvidence } from "@/routes/_authed/_app/tasks.$taskId";
import { settleReactWork } from "./settle-react-work";

/**
 * 卡片交付详情里的复核结果（借鉴改进 PR 5，规格 §5.5）：服务器交付时复跑了员工声明的核对命令，每条念成一行，
 * 挨着员工自查；复跑对不上、挡回两次后照收的卡，交付详情顶部有一行警告。
 */
let registeredHere = false;

beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register({ url: "http://localhost/" });
    registeredHere = true;
  }
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const ref = (reruns: unknown) => ({
  kind: "deliverable",
  notes: ["data.csv 共 100 行"],
  checks: ["数过行数"],
  reruns,
});

const three = ref([
  { command: "bun test", result: "passed" },
  {
    command: "wc -l data.csv",
    result: "mismatch",
    why: "数字从 100 变成了 150",
  },
  {
    command: "make install",
    result: "unverified",
    why: "命令会安装、部署或发布",
  },
]);

test("三种结果各念成一行", () => {
  expect(rerunsOf(three)).toEqual([
    { result: "passed", text: "复核通过：bun test" },
    {
      result: "mismatch",
      text: "复核不一致：wc -l data.csv",
      why: "数字从 100 变成了 150",
    },
    {
      result: "unverified",
      text: "未复核：make install（命令会安装、部署或发布）",
    },
  ]);
});

test("读不懂的项不念，没有复核结果就是空", () => {
  expect(
    rerunsOf(ref([{ command: "x", result: "odd" }, { result: "passed" }, 3])),
  ).toEqual([]);
  expect(rerunsOf({ kind: "deliverable", notes: ["x"] })).toEqual([]);
  expect(rerunsOf(null)).toEqual([]);
});

test("带「复核不一致」的卡才有警告", () => {
  expect(rerunWarningOf(three)).toBe("复跑结果和员工说的不一致，验收时请留意");
  expect(RERUN_WARNING).toBe("复跑结果和员工说的不一致，验收时请留意");
  expect(
    rerunWarningOf(ref([{ command: "bun test", result: "passed" }])),
  ).toBeNull();
});

const evidence = (deliverable: unknown) =>
  render(
    <DeliveryEvidence
      agentId="bot-1"
      criteria="去重后数清行数"
      deliverable={deliverable}
      taskId="t1"
    />,
  );

test("交付详情：顶部一行警告，三行结果紧挨员工自查，不一致那一行是 warn 样式", () => {
  const view = evidence(three);
  const alert = view.getByRole("alert");
  expect(alert.textContent).toBe("复跑结果和员工说的不一致，验收时请留意");
  expect(view.getByText("复核通过：bun test").dataset.result).toBe("passed");
  const mismatch = view.getByText("复核不一致：wc -l data.csv");
  expect(mismatch.dataset.result).toBe("mismatch");
  expect(mismatch.closest("[data-warn]")).not.toBeNull();
  expect(
    view.getByText("未复核：make install（命令会安装、部署或发布）").dataset
      .result,
  ).toBe("unverified");
  expect(view.container.querySelectorAll("[data-warn]")).toHaveLength(1);
  // 原因跟在不一致那一行后面，给本人验收时看。
  expect(view.getByText("数字从 100 变成了 150")).not.toBeNull();
  // 顶部的警告排在交付物之前；复核结果紧跟在员工自查后面。
  const text = view.container.textContent ?? "";
  expect(text.indexOf("复跑结果和员工说的不一致")).toBeLessThan(
    text.indexOf("data.csv 共 100 行"),
  );
  expect(text.indexOf("数过行数")).toBeLessThan(
    text.indexOf("复核通过：bun test"),
  );
  expect(text.indexOf("未复核：make install")).toBeLessThan(
    text.indexOf("验收标准"),
  );
});

test("都通过时没有警告；没有复核结果时不画复核那一块", () => {
  const passed = evidence(ref([{ command: "bun test", result: "passed" }]));
  expect(passed.queryByRole("alert")).toBeNull();
  expect(passed.getByText("复核通过：bun test")).not.toBeNull();
  cleanup();
  const none = evidence({ kind: "deliverable", notes: ["x"], checks: ["y"] });
  expect(none.queryByRole("list", { name: "服务器复核" })).toBeNull();
  expect(none.queryByRole("alert")).toBeNull();
  expect(none.getByText("y")).not.toBeNull();
});
