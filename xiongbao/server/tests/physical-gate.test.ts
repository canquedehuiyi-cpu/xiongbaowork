import { describe, expect, test } from "bun:test";
import {
  NO_FILE_PHRASE,
  PHYSICAL_BOUNCE_KEY,
  physicalBounceReason,
  physicalGateOn,
  uncheckedPhysical,
} from "../src/tasks/physical-gate";

const note = [{ kind: "note", ref: "已完成" }] as const;
const bounce = {
  role: "tool",
  content: JSON.stringify({ bounced: true, [PHYSICAL_BOUNCE_KEY]: true }),
};

describe("physical gate", () => {
  test("bounces once, not again after its own bounce", () => {
    expect(
      uncheckedPhysical({
        items: note,
        criteria: "做一份PPT",
        title: null,
        messages: [],
      }),
    ).toBe(true);
    const messages = [{ role: "user", content: "做" }, bounce];
    expect(
      uncheckedPhysical({
        items: note,
        criteria: "PPT",
        title: null,
        messages,
      }),
    ).toBe(false);
  });
  test("a bounce from an earlier turn does not count", () => {
    const messages = [bounce, { role: "user", content: "再做一份" }];
    expect(
      uncheckedPhysical({
        items: note,
        criteria: "做PPT",
        title: null,
        messages,
      }),
    ).toBe(true);
  });
  test("the no-file phrase lets it through", () => {
    const items = [
      { kind: "note", ref: `${NO_FILE_PHRASE}，结论如下` },
    ] as const;
    expect(
      uncheckedPhysical({
        items,
        criteria: "做PPT",
        title: null,
        messages: [],
      }),
    ).toBe(false);
  });
  test("a workspace_file item is not bounced", () => {
    const items = [
      { kind: "note", ref: "x" },
      { kind: "workspace_file", ref: "a.pptx" },
    ] as const;
    expect(
      uncheckedPhysical({
        items,
        criteria: "做PPT",
        title: null,
        messages: [],
      }),
    ).toBe(false);
  });
  test("card title and item title count; no physical word passes", () => {
    expect(
      uncheckedPhysical({
        items: note,
        criteria: null,
        title: "整理表格",
        messages: [],
      }),
    ).toBe(true);
    const titled = [{ kind: "note", ref: "x", title: "网页方案" }] as const;
    expect(
      uncheckedPhysical({
        items: titled,
        criteria: null,
        title: null,
        messages: [],
      }),
    ).toBe(true);
    expect(
      uncheckedPhysical({
        items: note,
        criteria: "算出总数",
        title: "统计",
        messages: [],
      }),
    ).toBe(false);
  });
  test("env switch and reason", () => {
    expect(physicalGateOn({})).toBe(true);
    expect(physicalGateOn({ XIONGBAO_PHYSICAL_GATE: "off" })).toBe(false);
    expect(physicalBounceReason()).toContain("这件活没有文件产物");
  });
});
