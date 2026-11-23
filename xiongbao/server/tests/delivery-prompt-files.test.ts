import { describe, expect, test } from "bun:test";
import { TOOL_BRIEFS } from "../src/agents/prompt-slim";
import { deliveryProtocolGuidance } from "../src/tasks/delivery-tools";
import { NO_FILE_PHRASE } from "../src/tasks/physical-gate";

const NOT_IN_CHAT = "不要只把内容贴在对话里";
const FILE_OR_APP = "workspace_file / app";

describe("员工侧提示：交付的是文件就存成文件交付", () => {
  test("交付规约里有这句，并带上「没有文件产物」的说法", () => {
    const text = deliveryProtocolGuidance(["accept_task"]) ?? "";
    expect(text).toContain(NOT_IN_CHAT);
    expect(text).toContain(FILE_OR_APP);
    expect(text).toContain(NO_FILE_PHRASE);
  });

  test("deliver_task 的短描述里有这句", () => {
    const text = TOOL_BRIEFS.deliver_task?.description ?? "";
    expect(text).toContain(NOT_IN_CHAT);
    expect(text).toContain(FILE_OR_APP);
    expect(text).toContain(NO_FILE_PHRASE);
  });
});
