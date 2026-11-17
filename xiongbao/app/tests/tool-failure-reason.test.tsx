import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, within } from "@testing-library/react";
import {
  type StepDetails,
  StepRow,
} from "../src/components/channels/tool-activity";
import { failureWords, ToolLine } from "../src/components/channels/tool-line";

/*
 * 失败的那一步，除了「没有成功」之外还能说什么。
 *
 * 只有结果自己写了的原因才上屏：命令给的是退出码（`exitCode`），没有退出码才用它那句 `error`
 * （再没有才是 stderr 的第一行，见 `tool-activity.ts` 的 `resultFacts`）。两个都没有，行上就是
 * 原来那一句「…，没有成功」，一个字不多。成功、进行中的步子永远不走这一句——还没结束的调用
 * 没有退出码，说一个就是编。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/** 一句比行放得下更长的原因，用来看截断。 */
const LONG = "这".repeat(60);

function stepOf(over: {
  kind?: "tool" | "browser";
  failed?: boolean;
  exitCode?: number;
  failure?: string;
}): StepDetails {
  return {
    id: "a",
    kind: over.kind ?? "tool",
    label: "运行了命令",
    pending: false,
    failed: over.failed ?? false,
    refused: false,
    pages: 0,
    inputs: [],
    ...(over.exitCode === undefined ? {} : { exitCode: over.exitCode }),
    ...(over.failure === undefined ? {} : { failure: over.failure }),
  };
}

function row(step: StepDetails) {
  return render(
    <ol>
      <StepRow active={false} step={step} />
    </ol>,
  );
}

test("a failure's words: the exit code, else the sentence, else nothing", () => {
  expect(failureWords(true, 1, undefined)).toBe("退出码 1");
  expect(failureWords(true, 0, undefined)).toBe("退出码 0");
  expect(failureWords(true, undefined, "命令不存在")).toBe("命令不存在");
  // 有数字时报数字，不再抄一遍那句话。
  expect(failureWords(true, 2, "boom")).toBe("退出码 2");
  expect(failureWords(true, undefined, undefined)).toBe("");
  expect(failureWords(true, undefined, "   ")).toBe("");
  // 没失败就不说：成功行上一个字不改。
  expect(failureWords(false, 1, "boom")).toBe("");
});

test("a long reason is cut to what fits the line", () => {
  const said = failureWords(true, undefined, LONG);
  expect(said.length).toBe(40);
  expect(said.endsWith("…")).toBe(true);
  expect(said).toBe(`${LONG.slice(0, 39)}…`);
});

test("a failed step says the exit code beside the sentence it always said", () => {
  const view = render(<ToolLine exitCode={2} failed label="执行命令" />);
  expect(view.getByText("执行命令，没有成功")).toBeTruthy();
  expect(view.getByText("退出码 2")).toBeTruthy();
});

test("a failure the result explains in words says those words", () => {
  const view = render(<ToolLine failed label="执行命令" failure="没有找到这个文件" />);
  expect(view.getByText("执行命令，没有成功")).toBeTruthy();
  expect(view.getByText("没有找到这个文件")).toBeTruthy();
  expect(view.queryByText(/退出码/)).toBeNull();
});

test("a failed step with nothing to explain says only what it always said", () => {
  const view = render(<ToolLine failed label="执行命令" />);
  expect(view.getByText("执行命令，没有成功")).toBeTruthy();
  expect(view.queryByText(/退出码/)).toBeNull();
  expect(view.container.textContent ?? "").toBe("执行命令，没有成功");
});

test("a step that worked keeps the line it had", () => {
  const view = render(<ToolLine exitCode={0} failure="旧的错误字段" label="执行命令" />);
  expect(view.getByText("执行命令")).toBeTruthy();
  expect(view.queryByText(/退出码/)).toBeNull();
  expect(view.queryByText(/旧的错误字段/)).toBeNull();
  expect(view.container.textContent ?? "").toBe("执行命令");
});

test("a step's own row carries the same two facts", () => {
  // 同一个行的三种事实，一个一个画：查询只认自己那个容器，不然上一个容器的「退出码 2」会被当成这一行说的。
  const coded = row(stepOf({ exitCode: 2, failed: true }));
  expect(within(coded.container).getByText("没成功")).toBeTruthy();
  expect(within(coded.container).getByText("退出码 2")).toBeTruthy();

  const told = row(stepOf({ failed: true, failure: "端口被占用了" }));
  expect(within(told.container).getByText("端口被占用了")).toBeTruthy();
  expect(within(told.container).queryByText(/退出码/)).toBeNull();

  const bare = row(stepOf({ failed: true }));
  expect(within(bare.container).getByText("没成功")).toBeTruthy();
  expect(within(bare.container).queryByText(/退出码/)).toBeNull();
});

test("a browser step says why under its line, not beside it", () => {
  // 这一类的失败原因已经写在行下面那句话里（`reason`），行上再说一遍就是同一件事说两次。
  const view = row(stepOf({ exitCode: 2, failed: true, kind: "browser" }));
  expect(view.getByText("没成功")).toBeTruthy();
  expect(view.queryByText(/退出码/)).toBeNull();
});
