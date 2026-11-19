import {
  isKnownSkinInput,
  normalizeSkinId,
  SKIN_IDS,
} from "@openbot/shared/user-preferences";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "./auth/guards";
import {
  isWorkClock,
  isWorkStretch,
  savedTimeZone,
  type UserPreferencesStore,
} from "./user-preferences";

/** An IANA zone this runtime knows, stored canonicalised. */
const timeZone = z
  .string()
  .refine((value) => savedTimeZone(value) !== undefined)
  .transform((value) => savedTimeZone(value) as string);

/**
 * The person's work hours (spec 2026-11-15-delivery-loop §10), any part of them: what is not named
 * keeps what is saved.
 */
const workHoursPatch = z
  .strictObject({
    start: z
      .string()
      .refine((value) => isWorkClock(value))
      .optional(),
    end: z
      .string()
      .refine((value) => isWorkClock(value))
      .optional(),
    timeZone: timeZone.optional(),
    weekends: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0);

/*
 * Each preference is optional so one control can save its own without restating the others, and
 * the merge in Postgres keeps the rest. Strict, so an unknown key is refused rather than stored, and
 * at least one key, so an empty body is a mistake rather than a no-op write.
 */
const preferencesPatch = z
  .strictObject({
    messageListEmphasis: z.enum(["agent", "thread"]).optional(),
    selfHostBannerDismissed: z.boolean().optional(),
    narration: z.enum(["on", "off"]).optional(),
    skin: z
      .string()
      .refine(isKnownSkinInput)
      .transform(normalizeSkinId)
      .optional(),
    proactive: z.enum(["on", "off"]).optional(),
    workHours: workHoursPatch.optional(),
    /*
     * The zone the browser is set to, sent on its saves: kept as the work hours' zone the first time
     * (none saved yet), never over one already there. Choosing a zone is `workHours.timeZone`.
     */
    browserTimeZone: timeZone.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0);

/** One or more of the run-end switches, as booleans; what is not named keeps what is saved. */
const runNoticePatch = z
  .strictObject({
    push: z.boolean().optional(),
    im: z.boolean().optional(),
    desktop: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0);

export function userPreferencesRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  store?: UserPreferencesStore,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);
  app.get("/", async (context) => {
    if (!store)
      return context.json(
        { error: "User preferences are not available." },
        503,
      );
    return context.json({
      preferences: await store.read(context.var.actor.id),
    });
  });
  /*
   * Where a person is told that a conversation's turn ended while they were away: `push` (the phone),
   * `im` (the chat platforms they bound) and `desktop` (system notifications from open pages). All on
   * until turned off. A path of its own, before the general save, so the general read and its strict
   * body stay what they were.
   */
  app.get("/run-notice", async (context) => {
    if (!store?.runEndNotice)
      return context.json(
        { error: "User preferences are not available." },
        503,
      );
    return context.json({
      runNotice: await store.runEndNotice.read(context.var.actor.id),
    });
  });
  app.patch("/run-notice", async (context) => {
    if (!store?.runEndNotice)
      return context.json(
        { error: "User preferences are not available." },
        503,
      );
    const parsed = runNoticePatch.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success)
      return context.json(
        { error: "Choose true or false for push, im or desktop." },
        400,
      );
    return context.json({
      runNotice: await store.runEndNotice.patch(
        context.var.actor.id,
        parsed.data,
      ),
    });
  });
  app.patch("/", async (context) => {
    if (!store)
      return context.json(
        { error: "User preferences are not available." },
        503,
      );
    const parsed = preferencesPatch.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json(
        {
          error: `Choose agent or thread for message list emphasis, true or false for the self-host banner, on or off for narration or check-ins, one of these skins: ${SKIN_IDS.join(", ")}, or work hours as HH:MM with a known time zone.`,
        },
        400,
      );
    }
    /*
     * The work hours as they would stand after this save must be one stretch of a day, the start
     * before the end: otherwise no time would ever be inside them, and nothing would ever be pushed.
     */
    const hours = parsed.data.workHours;
    if (hours?.start !== undefined || hours?.end !== undefined) {
      const saved = (await store.read(context.var.actor.id)).workHours;
      if (!isWorkStretch(hours.start ?? saved.start, hours.end ?? saved.end))
        return context.json(
          { error: "开工时间要早于收工时间（同一天内，最晚 23:59）。" },
          400,
        );
    }
    return context.json({
      preferences: await store.patch(context.var.actor.id, parsed.data),
    });
  });
  return app;
}
