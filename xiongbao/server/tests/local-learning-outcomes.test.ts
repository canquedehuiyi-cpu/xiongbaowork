import { describe, expect, test } from "bun:test";
import { transcriptOf } from "../src/local-learning/evidence";

/*
 * Local learning reads the tool trace and whether each step worked, not only the words (期 2): a line
 * of names and ok / FAILED, never an argument or a result.
 */
describe("what local learning is shown of the tools", () => {
  const call = (id: string, name: string) => ({
    id,
    type: "function",
    function: { name, arguments: '{"secret":"x"}' },
  });

  test("which calls worked and which did not, with no argument and no result", () => {
    const text = transcriptOf([
      { role: "user", content: "把表格整理一下" },
      {
        role: "assistant",
        content: "",
        toolCalls: [call("1", "read_sheet"), call("2", "write_file")],
      },
      { role: "tool", toolCallId: "1", content: "工具原文不该出现" },
      {
        role: "tool",
        toolCallId: "2",
        content: '{"ok":false,"error":"disk full"}',
      },
      { role: "assistant", content: "写不进去" },
    ]);
    expect(text).toContain("(Bot used tools: read_sheet, write_file)");
    expect(text).toContain("(Tool outcomes: read_sheet ok, write_file FAILED)");
    expect(text).not.toContain("工具原文不该出现");
    expect(text).not.toContain("disk full");
    expect(text).not.toContain("secret");
  });

  test("a call with no answer on record adds no outcome line", () => {
    const text = transcriptOf([
      { role: "user", content: "查一下" },
      { role: "assistant", content: "", toolCalls: [call("1", "search")] },
      { role: "assistant", content: "查到了" },
    ]);
    expect(text).toBe("Person: 查一下\n(Bot used tools: search)\nBot: 查到了");
  });
});
