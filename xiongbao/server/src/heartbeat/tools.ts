/**
 * 员工自己维护心跳清单的工具：`update_heartbeat_checklist`（期 3·3.1）。
 *
 * 每位员工默认都有，员工权限里关掉 `bot/update_heartbeat_checklist` 即不给（同 `update_plan`）。它只改清单，不能
 * 打开或关掉心跳、也不能改间隔：这些是本人在设置里决定的，员工不能自己给自己加班。每次传完整清单，替换原来的。
 *
 * 服务器照常存，存不了的（员工是系统自带的、不归这个人，或是外部员工）答一句话告诉模型，不抛错。
 */
import { z } from "zod";
import {
  HEARTBEAT_CHECKLIST_MAX_CHARS,
  parseHeartbeatPatch,
} from "../../../shared/heartbeat";
import type { GrantedTool } from "../plugins/tools";
import { REFUSAL_MARKER } from "../plugins/tools";
import { runAsTenant } from "../tenant/context";
import type { HeartbeatStore } from "./store";

export const UPDATE_HEARTBEAT_CHECKLIST_TOOL = "update_heartbeat_checklist";
export const UPDATE_HEARTBEAT_CHECKLIST_REF = `bot/${UPDATE_HEARTBEAT_CHECKLIST_TOOL}`;

const parameters = z.object({
  checklist: z
    .string()
    .describe(
      `完整的心跳清单，替换原来的，不超过 ${HEARTBEAT_CHECKLIST_MAX_CHARS} 字。每行一项要定时看一眼的事，例如「有新卡就看一眼」「每天 9 点汇总邮件」。写成空串就是清空。`,
    ),
});

export function heartbeatTools(options: {
  store: HeartbeatStore;
  ownerUserId: string;
  agentId: string;
}): GrantedTool[] {
  return [
    {
      name: UPDATE_HEARTBEAT_CHECKLIST_TOOL,
      ref: UPDATE_HEARTBEAT_CHECKLIST_REF,
      description:
        "更新你自己的心跳清单：你定时醒来时照这份清单检查，没事就静默，有事才做并告诉本人。每次传完整清单，替换原来的。只改清单，心跳的开关和间隔由本人在设置里定。",
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success)
          return `${REFUSAL_MARKER} ${parsed.error.issues[0]?.message ?? "清单要写成文字。"}`;
        const patch = parseHeartbeatPatch({ checklist: parsed.data.checklist });
        if (!patch.ok) return `${REFUSAL_MARKER} ${patch.error}`;
        const applied = await runAsTenant(options.ownerUserId, () =>
          options.store.apply(
            options.ownerUserId,
            options.agentId,
            patch.patch,
          ),
        );
        if (!applied.ok)
          return `${REFUSAL_MARKER} ${
            applied.why === "external"
              ? "外部员工自己干活，没有心跳。"
              : applied.why === "not_yours"
                ? "这位员工不归当前这位本人，改不了它的心跳清单。"
                : "找不到这位员工。"
          }`;
        return JSON.stringify({
          updated: true,
          chars: applied.settings.checklist.length,
          enabled: applied.settings.enabled,
          ...(applied.settings.enabled
            ? {}
            : {
                note: "心跳现在是关着的，清单存下了；要等本人在设置里打开才会醒来。",
              }),
        });
      },
    },
  ];
}
