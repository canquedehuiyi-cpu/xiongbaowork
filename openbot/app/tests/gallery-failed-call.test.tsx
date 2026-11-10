import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { GALLERY as CHARTS } from "@/components/gallery/charts";
import { GALLERY as DECISIONS } from "@/components/gallery/decisions";
import {
  UNREADABLE as FAILED_UNREADABLE,
  WENT_WRONG as FAILED_WENT_WRONG,
  FailedCard,
} from "@/components/gallery/failed";
import { GALLERY as TABLES } from "@/components/gallery/table";
import { galleryCallFailure } from "@/lib/copilot/gallery-tools";
import { settleReactWork } from "./settle-react-work";

/*
 * gallery 调用结束了却没有可画的内容（上游 #1132）：Claude Code 因为参数不是合法 JSON 拒绝了调用，
 * 结果就是那条错误，卡片却一直「正在等待完整的表格数据…」，重新打开对话也一样。
 * 结束了的失败调用改画成「没能显示」加一句原因。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function spec(name: string) {
  // `import.meta.glob` is Vite's, so under bun the registry is empty; the modules are read directly.
  const found = [...CHARTS, ...DECISIONS, ...TABLES].find(
    (component) => component.name === name,
  );
  if (!found) throw new Error(`${name} is not in the gallery`);
  return found;
}

const REFUSED_ARGS =
  "<tool_use_error>InputValidationError: columns is not an array</tool_use_error>";

test("a finished table call that failed on arguments it can't read says so", () => {
  expect(
    galleryCallFailure(spec("showTable"), {
      status: "complete",
      args: { title: "团队产能", columns: "名字, 人数" },
      result: REFUSED_ARGS,
    }),
  ).toBe(FAILED_UNREADABLE);
});

test("a finished call that failed with arguments that were fine went wrong", () => {
  expect(
    galleryCallFailure(spec("showTable"), {
      status: "complete",
      args: spec("showTable").preview,
      result: "Error: the handler threw",
    }),
  ).toBe(FAILED_WENT_WRONG);
});

test("the harness's flagged failure counts, as Claude Code wraps it", () => {
  expect(
    galleryCallFailure(spec("showBarChart"), {
      status: "complete",
      args: {},
      result: JSON.stringify({ error: true, content: "InputValidationError" }),
    }),
  ).toBe(FAILED_UNREADABLE);
});

test("a call still streaming or running is left to draw itself", () => {
  for (const status of ["inProgress", "executing"]) {
    expect(
      galleryCallFailure(spec("showTable"), {
        status,
        args: {},
        result: REFUSED_ARGS,
      }),
    ).toBeUndefined();
  }
});

test("a confirmation or a refusal is not a failure", () => {
  expect(
    galleryCallFailure(spec("showTable"), {
      status: "complete",
      args: {},
      result: "It is now on screen for the person.",
    }),
  ).toBeUndefined();
  expect(
    galleryCallFailure(spec("showTable"), {
      status: "complete",
      args: {},
      result: "Not shown: Data table. Not granted.",
    }),
  ).toBeUndefined();
});

test("a decision stopped while it waited keeps its question; only unreadable arguments fail it", () => {
  const ask = spec("askApproval");
  expect(
    galleryCallFailure(ask, {
      status: "complete",
      args: { title: 42 },
      result: REFUSED_ARGS,
    }),
  ).toBe(FAILED_UNREADABLE);
  const fine = (ask.preview as { args: Record<string, unknown> }).args;
  expect(
    galleryCallFailure(ask, {
      status: "complete",
      args: fine,
      result: "Error: the run was stopped",
    }),
  ).toBeUndefined();
});

test("the failed card names the component and the reason", () => {
  const view = render(
    <FailedCard reason={FAILED_UNREADABLE} title="Data table" />,
  );
  const text = view.container.textContent ?? "";
  expect(text).toContain("没能显示：Data table");
  expect(text).toContain(FAILED_UNREADABLE);
  expect(view.getByTestId("component-failed")).not.toBeNull();
});
