import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { QuotaService } from "../quota/limits";
import { QuotaExceeded } from "../quota/limits";
import type { DeviceQueue } from "./queue";
import { QUEUE_ATTENTION_THRESHOLD } from "./queue";
import type { DeviceStore } from "./store";

type Ctx = { Variables: AppVariables };

/**
 * The tenant's own machines, as their owner sees and starts them (ticket 016).
 *
 * Pairing is minted here and spent by `createRunnerRoutes` below, split that way because the two ends
 * are authenticated by different things: this half by a person's session, that half by a code nobody
 * has to be signed in to type.
 */
export function createDeviceRoutes(
  store: DeviceStore,
  requireUser: MiddlewareHandler<Ctx>,
  /**
   * What each machine still owes, so the list can say "asleep, with work waiting" (ticket 018).
   *
   * Read here rather than stored on the device row: the backlog is a fact about the queue, and a
   * number copied into a second table is a number that can be wrong on its own.
   */
  queue?: DeviceQueue,
  onReviewed?: (target: { tenantId: string; deviceId: string }) => void,
) {
  const routes = new Hono<Ctx>();

  routes.get("/", requireUser, async (context) => {
    const devices = await store.list(context.var.actor.id);
    if (!queue) return context.json({ devices });
    const tenantId = context.var.actor.id;
    const withBacklog = await Promise.all(
      devices.map(async (device) => {
        const queued = await queue.pending({
          tenantId,
          deviceId: device.deviceId,
        });
        const uncertain = await queue.uncertain({
          tenantId,
          deviceId: device.deviceId,
        });
        // Past that line the backlog is no longer a queue, it is a decision somebody owes: the
        // machine is not coming back by itself and there is work sitting on it.
        return {
          ...device,
          queued,
          uncertain,
          needsAttention: uncertain > 0 || queued > QUEUE_ATTENTION_THRESHOLD,
        };
      }),
    );
    return context.json({ devices: withBacklog });
  });

  routes.post("/pair", requireUser, async (context) => {
    const code = await store.mintPairCode(context.var.actor.id);
    return context.json({ code: code.code, expiresAt: code.expiresAt }, 201);
  });

  routes.get("/:id/actions", requireUser, async (context) => {
    const device = (await store.list(context.var.actor.id)).find(
      (row) => row.id === context.req.param("id"),
    );
    if (!device) return context.json({ error: "No such device." }, 404);
    if (!queue) return context.json({ actions: [] });
    return context.json({
      actions: await queue.reviews({
        tenantId: context.var.actor.id,
        deviceId: device.deviceId,
      }),
    });
  });

  routes.post("/:id/actions/review", requireUser, async (context) => {
    const tenantId = context.var.actor.id;
    const device = (await store.list(tenantId)).find(
      (row) => row.id === context.req.param("id"),
    );
    if (!device) return context.json({ error: "No such device." }, 404);
    if (!queue)
      return context.json({ error: "Device receipts are unavailable." }, 409);
    const body = await context.req.json().catch(() => null);
    if (
      body?.confirmedChecked !== true ||
      typeof body.key !== "string" ||
      !body.key ||
      body.key.length > 2000 ||
      typeof body.note !== "string" ||
      !body.note.trim() ||
      body.note.length > 2000 ||
      !["checked_executed", "checked_not_executed"].includes(body.resolution)
    )
      return context.json(
        {
          error:
            "Check the device, select what actually happened, and provide a review note before confirming.",
        },
        400,
      );
    const target = { tenantId, deviceId: device.deviceId };
    if (!(await queue.review(target, body.key, body)))
      return context.json(
        { error: "This action is not awaiting review. Refresh its receipt." },
        409,
      );
    const uncertain = await queue.uncertain(target);
    if (!uncertain) onReviewed?.(target);
    return context.json({ ok: true, uncertain, paused: uncertain > 0 });
  });

  routes.delete("/:id", requireUser, async (context) => {
    const removed = await store.remove(
      context.var.actor.id,
      context.req.param("id"),
    );
    return removed
      ? context.json({ ok: true })
      : context.json({ error: "No such device." }, 404);
  });

  return routes;
}

/** What a runner sends when it arrives with a code from its owner's screen. */
type RegisterBody = {
  code?: unknown;
  deviceId?: unknown;
  name?: unknown;
  platform?: unknown;
};

/**
 * The runner's side: spend a pairing code, then say you are alive.
 *
 * NOT behind `requireUser`, and that is the whole design. A machine being set up in somebody's study
 * has no session cookie and should not need one; the code on their screen is the credential, it is
 * short-lived, single-use and typed once, and it is what the tenant minted minutes earlier. After it
 * is spent the runner holds a device token, and nothing here accepts a password, a session, or an
 * administrator's key.
 *
 * The device is registered under the tenant the code was minted in — never a tenant named by the
 * caller — which is why the redeeming store returns the row rather than taking one.
 */
export function createRunnerRoutes(
  store: DeviceStore,
  /** The tenant's device ceiling, when this deployment counts one. */
  quota?: QuotaService,
) {
  const routes = new Hono();

  routes.post("/register", async (context) => {
    const body = (await context.req
      .json<RegisterBody>()
      .catch(() => null)) as RegisterBody | null;
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const deviceId =
      typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!code || !deviceId || !name) {
      return context.json(
        { error: "A pairing code, a device id and a name are required." },
        400,
      );
    }
    /*
     * Read the ceiling before the code is spent, and say 402 rather than 403.
     *
     * The two refusals are different pieces of advice: "that code is no good" sends a person to look
     * for a typo, "your plan allows one machine" sends them to the plan. The code is not consumed by a
     * refusal, so pairing the second machine after upgrading uses the same code they already typed.
     */
    let claimed: Awaited<ReturnType<DeviceStore["redeemPairCode"]>>;
    try {
      claimed = await store.redeemPairCode(
        {
          code,
          deviceId: deviceId.slice(0, 200),
          name: name.slice(0, 120),
          platform:
            typeof body?.platform === "string"
              ? body.platform.trim().slice(0, 60)
              : null,
        },
        quota,
      );
    } catch (thrown) {
      if (thrown instanceof QuotaExceeded)
        return context.json(thrown.body, 402);
      throw thrown;
    }
    if (!claimed) {
      return context.json({ error: "That pairing code is no good." }, 403);
    }
    // The token is returned once and never again: the store keeps only its hash.
    return context.json({ token: claimed.token, device: claimed.device }, 201);
  });

  /*
   * The heartbeat for a runner that has no socket open — and the way a runner notices it should dial
   * again.
   *
   * The socket is the primary channel, but a reconnect is exactly when a device knows least about
   * whether the server can see it, so this writes the same one column the socket does. One value,
   * two ways to say it, no second answer: `last_seen_at` is presence and nothing else is stored.
   */
  routes.post("/heartbeat", async (context) => {
    const token = context.req.header("authorization")?.replace(/^Bearer /, "");
    if (!token) return context.json({ error: "No token." }, 401);
    const owner = await store.deviceForToken(token);
    if (!owner) return context.json({ error: "Not a device." }, 401);
    await store.heartbeat(owner.tenantId, owner.deviceId);
    return context.json({ ok: true });
  });

  return routes;
}
