import { expect, test } from "bun:test";
import { computerGuidance } from "../../shared/bot-prompt";
import type { PluginStore } from "../src/plugins/store";
import {
  CONNECTOR_APPROVAL_GUIDANCE,
  DESTRUCTIVE_TOOL_NOTE,
  grantedToolGuidance,
  grantedTools,
} from "../src/plugins/tools";

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

test("a Bot holding connected-app tools is told OpenBot asks before their deletes, archives and destructive tools", async () => {
  const tools = await grantedTools({
    store: storeWith([
      { ref: "crm/list_deals", description: "List deals.", destructive: false },
    ]),
    botId: "bot",
    actorId: "owner",
  });
  // 只要持有应用工具就说，和这台部署有没有电脑无关。
  const guidance = grantedToolGuidance(tools);
  expect(guidance).toContain(CONNECTOR_APPROVAL_GUIDANCE);
  for (const words of ["connected app", "delete", "archive", "destructive"])
    expect(CONNECTOR_APPROVAL_GUIDANCE).toContain(words);
  // 说清楚只管应用工具：电脑上的命令和文件不在此列。
  expect(CONNECTOR_APPROVAL_GUIDANCE).toContain("not commands or files");
  // A Bot that holds no app tool is not told so.
  expect(grantedToolGuidance([], ["gmail"])).not.toContain(
    CONNECTOR_APPROVAL_GUIDANCE,
  );
  // 只持有 OpenBot 自己的记忆等内部工具时也不说：它们不经审批门，说了反而让 Bot 不再自己确认。
  const internal = [
    "recall_personal_memory",
    "forget_personal_memory",
    "cancel_follow_up",
  ].map((name) => ({ ...tools[0], name, ref: `memory/${name}` }));
  const onlyInternal = grantedToolGuidance(internal as unknown as typeof tools);
  expect(onlyInternal).toContain("forget_personal_memory");
  expect(onlyInternal).not.toContain(CONNECTOR_APPROVAL_GUIDANCE);
  // 和应用工具一起持有时才说，并写明记忆类工具不在此列。
  expect(
    grantedToolGuidance([...(internal as unknown as typeof tools), ...tools]),
  ).toContain(CONNECTOR_APPROVAL_GUIDANCE);
  expect(CONNECTOR_APPROVAL_GUIDANCE).toContain("memory");
  // Nor is it in the computer guidance, beside commands this rule does not cover.
  // Upstream made the computer guidance a function of what the Bot holds; every combination is checked.
  for (const search of [false, true])
    for (const personal of [false, true])
      expect(computerGuidance({ search, personal })).not.toContain(
        "OpenBot itself asks",
      );
});
