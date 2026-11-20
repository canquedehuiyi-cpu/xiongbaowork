import { describe, expect, test } from "bun:test";
import { TOOL_BRIEFS } from "../src/agents/prompt-slim";
import {
  headlessDeliveryRun,
  SLIM_ANSWER_FORMAT,
  SLIM_DELIVERY,
  SLIM_SOURCES,
  SLIM_SUBAGENTS,
} from "../src/agents/slim-guidance";

/*
 * token 第五轮：每一步都发的固定提示词再压短。这里钉两件事：各段的字符数上限（以后谁往里加话，先想想是不是该
 * 按条件出现），和压短之后安全底线、交付规则的要点一条没少。
 */

describe("固定提示词各段不超过上限", () => {
  test.each([
    ["SLIM_SOURCES", SLIM_SOURCES, 950],
    ["SLIM_ANSWER_FORMAT", SLIM_ANSWER_FORMAT, 800],
    ["SLIM_SUBAGENTS", SLIM_SUBAGENTS, 880],
    ["SLIM_DELIVERY", SLIM_DELIVERY, 1_200],
    ["ask_person 短描述", TOOL_BRIEFS.ask_person?.description ?? "", 450],
    ["run_subagent 短描述", TOOL_BRIEFS.run_subagent?.description ?? "", 220],
  ])("%s", (_name, text, limit) => {
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(limit);
  });
});

describe("压短之后要点还在", () => {
  test("交付：不经文件分享站、逐项核对、说清没做完的", () => {
    expect(SLIM_DELIVERY).toContain("file-sharing, transfer or paste site");
    expect(SLIM_DELIVERY).toContain("Checked item by item");
    expect(SLIM_DELIVERY).toContain("Honest about the rest");
    expect(SLIM_DELIVERY).toContain(
      "clickable in a channel that cannot show it",
    );
  });

  test("子代理：需要批准的事自己做；最多 5 个；不能再派", () => {
    expect(SLIM_SUBAGENTS).toContain("needing the person's approval");
    expect(SLIM_SUBAGENTS).toContain("At most 5");
    expect(SLIM_SUBAGENTS).toContain("cannot start subagents");
  });

  test("来源：没读过的不当成查过的；要据以行动的数字说没核对", () => {
    expect(SLIM_SOURCES).toContain("never present it as looked up");
    expect(SLIM_SOURCES).toContain(
      "I have not checked this against your own policy",
    );
  });

  test("提问：什么时候才问人", () => {
    const ask = TOOL_BRIEFS.ask_person?.description ?? "";
    expect(ask).toContain("hard to undo");
    expect(ask).toContain("stop and wait");
  });

  test("子代理短描述：需要批准的操作交还给你", () => {
    expect(TOOL_BRIEFS.run_subagent?.description).toContain(
      "需要批准的操作子代理会停下",
    );
  });
});

describe("headlessDeliveryRun：什么样的轮次不放「回答格式」", () => {
  const held = ["accept_task", "deliver_task", "computer_run_command"];
  test("只带电脑工具、握着 accept_task 的：是", () => {
    expect(
      headlessDeliveryRun(held, ["computer_run_command", "report_refusal"], {}),
    ).toBe(true);
  });
  test("带了别的工具（界面的组件）、没带任何工具、不知道、没有 accept_task：不是", () => {
    expect(
      headlessDeliveryRun(held, ["computer_click", "render_chart"], {}),
    ).toBe(false);
    expect(headlessDeliveryRun(held, [], {})).toBe(false);
    expect(headlessDeliveryRun(held, undefined, {})).toBe(false);
    expect(headlessDeliveryRun(["deliver_task"], ["computer_click"], {})).toBe(
      false,
    );
  });
  test("回退：XIONGBAO_HEADLESS_ANSWER_FORMAT=on", () => {
    expect(
      headlessDeliveryRun(held, ["computer_click"], {
        XIONGBAO_HEADLESS_ANSWER_FORMAT: "on",
      }),
    ).toBe(false);
  });
});
