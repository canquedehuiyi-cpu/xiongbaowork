/**
 * 员工的「轻量模型」（期 1·1.5）：巡检和跟进这类轻量轮用的便宜模型（`shared/light-model.ts`），平时的活仍用员工自己的
 * 模型。存在 `agents.configuration.lightModel`，一个模型名，没有就是没设置（用平时的模型），所以不动表结构。
 * 做法和难任务模型的路由（`hard-model-routes.ts`）一样：
 *
 * - `GET /:agentId/light-model`：读，答 `{ lightModel: string | null }`。能看到这位员工的人都能读。
 * - `PUT /:agentId/light-model`：写，body `{ lightModel: string | null }`，空或 null 是清掉。只有能编辑这位员工的人
 *   （它的主人，或管理员）能改，别人 403；找不到、看不到的员工 404。
 *
 * 能选的模型和对话里模型选择器是同一份目录（管理员的白名单已算在里面，`allowed`）：不在里面的名字 400，不存。
 * 外部员工（`device_acp`）自己干活，不用这里的模型，读和写都是 400。
 */
import { eq, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { LIGHT_MODEL_KEY, lightModelOf } from "../../../shared/light-model";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { agents } from "../db/schema";
import { runAsTenant } from "../tenant/context";
import { canManageAgent } from "./profile-policy";
import type { AgentActor, AgentProfile } from "./profile-types";

type Ctx = { Variables: AppVariables };

/** 员工配置里的轻量模型：读出来，或写进去（空是清掉）。写时返回有没有改到这一行。 */
export type LightModelStore = {
  /** `null`：没有这位员工。`type` 用来拦外部员工。 */
  read: (
    agentId: string,
  ) => Promise<{ type: string; lightModel: string | null } | null>;
  write: (agentId: string, lightModel: string | null) => Promise<boolean>;
};

export function createLightModelStore(database: Database): LightModelStore {
  return {
    async read(agentId) {
      const [row] = await database
        .select({ type: agents.type, configuration: agents.configuration })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      return row
        ? {
            type: row.type,
            lightModel: lightModelOf(row.configuration) ?? null,
          }
        : null;
    },
    async write(agentId, lightModel) {
      // 一条语句改这一个键，别的配置原样留着；同时有别的设置在存时谁也不会把谁冲掉。
      const configuration =
        lightModel === null
          ? sql`${agents.configuration} - ${LIGHT_MODEL_KEY}`
          : sql`coalesce(${agents.configuration}, '{}'::jsonb) || jsonb_build_object(${LIGHT_MODEL_KEY}::text, ${lightModel}::text)`;
      const rows = await database
        .update(agents)
        .set({ configuration, updatedAt: sql`now()` })
        .where(eq(agents.id, agentId))
        .returning({ id: agents.id });
      return rows.length > 0;
    },
  };
}

const body = z.strictObject({
  lightModel: z.union([z.string().max(200), z.null()]),
});

export const LIGHT_MODEL_EXTERNAL_REFUSAL =
  "外部员工自己干活，不用这里的模型，没有轻量模型。";

export function createLightModelRoutes(deps: {
  store: LightModelStore;
  profiles: {
    get(actor: AgentActor, id: string): Promise<AgentProfile | null>;
  };
  /** 本租户可用的模型名：对话里模型选择器那份目录。 */
  allowed: () => Promise<readonly string[]>;
  requireUser: MiddlewareHandler<Ctx>;
  auditStore?: AuditStore;
}) {
  const routes = new Hono<Ctx>();

  routes.get("/:agentId/light-model", deps.requireUser, async (context) => {
    const actor = context.var.actor;
    const agentId = context.req.param("agentId");
    // 看不到的员工和没有的员工同一个答案。
    const profile = await deps.profiles.get(actor, agentId);
    if (!profile) return context.json({ error: "找不到这位员工。" }, 404);
    const saved = await runAsTenant(actor.id, () => deps.store.read(agentId));
    if (!saved) return context.json({ error: "找不到这位员工。" }, 404);
    if (saved.type === "device_acp")
      return context.json({ error: LIGHT_MODEL_EXTERNAL_REFUSAL }, 400);
    return context.json({ lightModel: saved.lightModel });
  });

  routes.put("/:agentId/light-model", deps.requireUser, async (context) => {
    const actor = context.var.actor;
    const agentId = context.req.param("agentId");
    const profile = await deps.profiles.get(actor, agentId);
    if (!profile) return context.json({ error: "找不到这位员工。" }, 404);
    if (!canManageAgent(actor, profile))
      return context.json(
        { error: "只有这位员工的主人或管理员能改它的轻量模型。" },
        403,
      );
    const parsed = body.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success)
      return context.json(
        { error: "轻量模型要写一个模型名，留空或 null 是清掉。" },
        400,
      );
    const wanted = parsed.data.lightModel?.trim() || null;
    const saved = await runAsTenant(actor.id, () => deps.store.read(agentId));
    if (!saved) return context.json({ error: "找不到这位员工。" }, 404);
    if (saved.type === "device_acp")
      return context.json({ error: LIGHT_MODEL_EXTERNAL_REFUSAL }, 400);
    if (wanted !== null) {
      const allowed = await deps.allowed();
      if (!allowed.includes(wanted))
        return context.json(
          { error: `模型「${wanted}」不在可用的模型里，请从列表里选一个。` },
          400,
        );
    }
    // 没改就不写、不记：同一个值再存一次什么也没发生。
    if (wanted !== saved.lightModel) {
      const written = await runAsTenant(actor.id, () =>
        deps.store.write(agentId, wanted),
      );
      // 这一行不在这个人的帧里可写（别人名下的员工，管理员也只读它）。
      if (!written)
        return context.json(
          { error: "这位员工归别人所有，要改请到它主人那里。" },
          403,
        );
      if (deps.auditStore)
        await recordAuditEvent(deps.auditStore, {
          eventType: "bot.updated",
          targetType: "agent",
          targetId: agentId,
          actorUserId: actor.id,
          payload: { bot: agentId, lightModel: wanted },
        }).catch(() => undefined);
    }
    return context.json({ lightModel: wanted });
  });

  return routes;
}
