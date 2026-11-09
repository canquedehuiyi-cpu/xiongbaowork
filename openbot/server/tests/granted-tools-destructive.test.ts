import { expect, test } from "bun:test";
import {
  APPROVAL_ASKS_GUIDANCE,
  COMPUTER_GUIDANCE,
  DESTRUCTIVE_TOOL_NOTE,
} from "../../shared/bot-prompt";
import type { PluginStore } from "../src/plugins/store";
import { grantedTools } from "../src/plugins/tools";

/**
 * 删除类底线（approvals/policy.ts 的 `destructiveFloor`）总是先问，Bot 不必自己再问一遍。应用
 * 标为破坏性的工具可以叫任何名字（"reset pipeline"），Bot 从名字看不出来，所以提供给模型时在
 * 描述末尾写明；系统提示的审批说明里也说一句。
 */

const storeWith = (
  tools: { ref: string; description: string; destructive: boolean }[],
) =>
  ({
    listForAgent: async () => ({
      tools: tools.map((tool) => ({
        ...tool,
        toolName: `mcp__${tool.ref.replace("/", "__")}`,
        inputSchema: { type: "object" },
      })),
      skills: [],
    }),
  }) as unknown as PluginStore;

test("a tool its app marks destructive is offered with the note at the end of its description", async () => {
  const tools = await grantedTools({
    store: storeWith([
      {
        ref: "crm/reset_pipeline",
        description: "Reset a sales pipeline. ",
        destructive: true,
      },
      { ref: "crm/list_deals", description: "List deals.", destructive: false },
      { ref: "crm/wipe_notes", description: "", destructive: true },
    ]),
    botId: "bot",
    actorId: "owner",
  });
  expect(tools.map((tool) => tool.description)).toEqual([
    `Reset a sales pipeline.\n\n${DESTRUCTIVE_TOOL_NOTE}`,
    "List deals.",
    DESTRUCTIVE_TOOL_NOTE,
  ]);
  expect(DESTRUCTIVE_TOOL_NOTE).toContain("asks the person before it runs");
});

test("every Bot's guidance says deletes, archives and destructive tools are asked about by OpenBot", () => {
  expect(COMPUTER_GUIDANCE).toContain(APPROVAL_ASKS_GUIDANCE);
  for (const word of ["delete", "archive", "destructive", "do not ask"])
    expect(APPROVAL_ASKS_GUIDANCE).toContain(word);
});
