/**
 * 看板上派给岗位的卡（期 3·3.3）的读写接口。
 *
 * - `POST /api/board-cards`：放一张卡 `{ title, detail?, role, priority?, urgent? }`。`role` 是岗位，对应员工的头衔；
 *   `priority` 越大越先（-100 到 100，默认 0）；`urgent` 的卡安静时段里也可以被领。放进来之后会踢一下同岗位开了
 *   心跳的员工，让它现在就去领，不用等下一次醒来。
 * - `GET /api/board-cards`：本人的卡，带领它的员工（`claimedBy`）、什么时候领的、开出来的看板卡（`taskId`）和那张
 *   看板卡现在的状态（`taskStatus`）；界面用 `taskId` 对上看板卡，显示「员工已认领」。
 * - `DELETE /api/board-cards/:id`：撤掉一张还没人领的卡；已经被领走的 409（要停它去取消那张看板卡）。
 */
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import { runAsTenant } from "../tenant/context";
import type { BoardCard, BoardCardsStore } from "./claim";

const newCard = z.strictObject({
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(2000).optional(),
  role: z.string().trim().min(1).max(80),
  priority: z.number().int().min(-100).max(100).optional(),
  urgent: z.boolean().optional(),
});

export function createBoardCardRoutes(deps: {
  cards: BoardCardsStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** 放进一张卡之后踢一下同岗位开了心跳的员工；不等它做完。 */
  kick?: (ownerUserId: string, card: BoardCard) => Promise<unknown>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);

  routes.post("/", async (context) => {
    const actor = context.var.actor;
    const parsed = newCard.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success)
      return context.json(
        {
          error:
            "要写 title（标题）和 role（岗位）；detail、priority（-100 到 100）、urgent 可选。",
        },
        400,
      );
    const card = await runAsTenant(actor.id, () =>
      deps.cards.create({ ...parsed.data, createdBy: actor.id }),
    );
    void deps.kick?.(actor.id, card)?.catch?.((error: unknown) =>
      console.warn(
        JSON.stringify({
          type: "board-card-kick-failed",
          reason: error instanceof Error ? error.name : "UnknownError",
        }),
      ),
    );
    return context.json({ card }, 201);
  });

  routes.get("/", async (context) => {
    const cards = await runAsTenant(context.var.actor.id, () =>
      deps.cards.list(),
    );
    return context.json({ cards });
  });

  routes.delete("/:id", async (context) => {
    const removed = await runAsTenant(context.var.actor.id, () =>
      deps.cards.cancelOpen(context.req.param("id")),
    ).catch(() => false);
    if (!removed)
      return context.json(
        { error: "找不到这张没人领的卡；已经被领走的要去取消那张看板卡。" },
        409,
      );
    return context.json({ ok: true });
  });

  return routes;
}
