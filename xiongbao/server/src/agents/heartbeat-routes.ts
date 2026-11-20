/**
 * 员工的「心跳」（期 3·3.1）：开了心跳的员工隔一段时间自己醒来，照清单检查，没事静默、有事才做并告诉本人
 * （`shared/heartbeat.ts`、`heartbeat/runner.ts`）。存在 `agents.configuration.heartbeat`，没有就是没开，不动表结构。
 * 做法和轻量模型的路由（`light-model-routes.ts`）一样：
 *
 * - `GET /:agentId/heartbeat`：读，答 `{ heartbeat: { enabled, intervalMinutes, checklist }, recent: [...] }`；
 *   `recent` 是最近几次真的醒来过的账（原定时刻、结果、认领了几张卡），没开过就是空的。能看到这位员工的人都能读。
 * - `PUT /:agentId/heartbeat`：写，body 是 `{ enabled?, intervalMinutes?, checklist? }` 里的一项或几项，没写的
 *   留着原样。间隔 15 分钟到一周的整数，清单不超过 2000 字。只有能编辑这位员工的人（它的主人，或管理员）能改，
 *   别人 403；找不到、看不到的员工 404；外部员工（`device_acp`）自己干活，读和写都是 400。
 *   打开、或开着时改了间隔，下一次醒来按新的间隔排；改清单不动排队。
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  parseHeartbeatPatch,
  publicHeartbeat,
} from "../../../shared/heartbeat";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { HeartbeatStore } from "../heartbeat/store";
import { runAsTenant } from "../tenant/context";
import { canManageAgent } from "./profile-policy";
import type { AgentActor, AgentProfile } from "./profile-types";

type Ctx = { Variables: AppVariables };

export const HEARTBEAT_EXTERNAL_REFUSAL = "外部员工自己干活，没有心跳。";

export function createHeartbeatRoutes(deps: {
  store: HeartbeatStore;
  profiles: {
    get(actor: AgentActor, id: string): Promise<AgentProfile | null>;
  };
  requireUser: MiddlewareHandler<Ctx>;
  auditStore?: AuditStore;
}) {
  const routes = new Hono<Ctx>();

  routes.get("/:agentId/heartbeat", deps.requireUser, async (context) => {
    const actor = context.var.actor;
    const agentId = context.req.param("agentId");
    // 看不到的员工和没有的员工同一个答案。
    const profile = await deps.profiles.get(actor, agentId);
    if (!profile) return context.json({ error: "找不到这位员工。" }, 404);
    const saved = await runAsTenant(actor.id, () => deps.store.read(agentId));
    if (!saved) return context.json({ error: "找不到这位员工。" }, 404);
    if (saved.type === "device_acp")
      return context.json({ error: HEARTBEAT_EXTERNAL_REFUSAL }, 400);
    const recent = await runAsTenant(actor.id, () =>
      deps.store.recent(agentId),
    );
    return context.json({
      heartbeat: publicHeartbeat(saved.heartbeat),
      recent,
    });
  });

  routes.put("/:agentId/heartbeat", deps.requireUser, async (context) => {
    const actor = context.var.actor;
    const agentId = context.req.param("agentId");
    const profile = await deps.profiles.get(actor, agentId);
    if (!profile) return context.json({ error: "找不到这位员工。" }, 404);
    if (!canManageAgent(actor, profile))
      return context.json(
        { error: "只有这位员工的主人或管理员能改它的心跳。" },
        403,
      );
    const parsed = parseHeartbeatPatch(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const applied = await runAsTenant(actor.id, () =>
      deps.store.apply(actor.id, agentId, parsed.patch),
    );
    if (!applied.ok) {
      if (applied.why === "external")
        return context.json({ error: HEARTBEAT_EXTERNAL_REFUSAL }, 400);
      if (applied.why === "not_yours")
        return context.json(
          { error: "这位员工归别人所有，要改请到它主人那里。" },
          403,
        );
      return context.json({ error: "找不到这位员工。" }, 404);
    }
    if (deps.auditStore)
      await recordAuditEvent(deps.auditStore, {
        eventType: "bot.updated",
        targetType: "agent",
        targetId: agentId,
        actorUserId: actor.id,
        payload: {
          bot: agentId,
          heartbeat: {
            ...(parsed.patch.enabled !== undefined
              ? { enabled: parsed.patch.enabled }
              : {}),
            ...(parsed.patch.intervalMinutes !== undefined
              ? { intervalMinutes: parsed.patch.intervalMinutes }
              : {}),
            // 清单的内容不进审计，只记改过。
            ...(parsed.patch.checklist !== undefined
              ? { checklistChanged: true }
              : {}),
          },
        },
      }).catch(() => undefined);
    return context.json({
      heartbeat: applied.settings,
      nextWakeAt: applied.scheduledFor?.toISOString() ?? null,
    });
  });

  return routes;
}
