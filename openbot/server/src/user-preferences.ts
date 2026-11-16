import {
  DEFAULT_USER_PREFERENCES,
  normalizeSkinId,
  type UserPreferences,
} from "@openbot/shared/user-preferences";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./db/client";
import { users } from "./db/schema";
import { DEFAULT_TIME_ZONE } from "./tasks/delivery-tools";
import { runAsTenant } from "./tenant/context";

/**
 * When the person works, on their own clock (spec 2026-11-15-delivery-loop §10): the delivery checker
 * pushes nothing outside it, and the start and end briefings go out at its two ends.
 */
export type WorkHours = {
  /** "HH:MM". */
  start: string;
  /**
   * "HH:MM", later than `start`. A saved one is at most "23:59"; "24:00" (the end of the day) is
   * understood by the work-hours check for a value built in code, never stored.
   */
  end: string;
  /** An IANA zone, e.g. "Asia/Shanghai". */
  timeZone: string;
  /** Whether Saturdays and Sundays are work days. */
  weekends: boolean;
};

/**
 * The default work hours: 09:00 to 18:00, weekdays. The zone is the one the person's browser writes the
 * first time it saves ({@link UserPreferencesPatch.browserTimeZone}); until then, the product's own.
 */
export const DEFAULT_WORK_HOURS: Omit<WorkHours, "timeZone"> = {
  start: "09:00",
  end: "18:00",
  weekends: false,
};

/** What the server keeps for a person: the shared preferences, and their work hours. */
export type StoredUserPreferences = UserPreferences & { workHours: WorkHours };

/** One save: any preference, any part of the work hours, and the zone the browser is on. */
export type UserPreferencesPatch = Partial<UserPreferences> & {
  workHours?: Partial<WorkHours>;
  /**
   * The zone the person's browser is set to. Written as `workHours.timeZone` only when none is saved
   * yet -- the first save from a browser -- and never over one, so a zone the person chose stays theirs
   * when they open the app on a laptop set to another.
   */
  browserTimeZone?: string;
};

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** An IANA Area/Location name (or a bare one such as `UTC`), never an offset such as `+05:00`. */
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * The value as a time zone this runtime knows, canonicalised, or undefined for anything else -- the
 * same check the shared helper gives a run's zone (`person-time-zone.ts`), for a saved one.
 */
export function savedTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const zone = value.trim();
  if (zone.length === 0 || zone.length > 64 || !IANA_NAME.test(zone))
    return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
    }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** Whether `value` is a work-hours clock: "HH:MM", 00:00 to 23:59. */
export function isWorkClock(value: unknown): value is string {
  return typeof value === "string" && CLOCK.test(value);
}

/** The minute of the day a work-hours clock names. */
export function minuteOfClock(clock: string): number {
  const [hours, minutes] = clock.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/**
 * Whether a day's work hours are a real stretch: the start before the end, on one day. Hours across
 * midnight are not supported; such hours would hold every reminder for the briefing and push none.
 */
export function isWorkStretch(start: string, end: string): boolean {
  return minuteOfClock(start) < minuteOfClock(end);
}

/** The work hours a stored row says, over the defaults; anything malformed reads as the default. */
function workHoursOf(stored: Record<string, unknown>): WorkHours {
  const hours =
    stored.workHours && typeof stored.workHours === "object"
      ? (stored.workHours as Record<string, unknown>)
      : {};
  const start = isWorkClock(hours.start)
    ? hours.start
    : DEFAULT_WORK_HOURS.start;
  const end = isWorkClock(hours.end) ? hours.end : DEFAULT_WORK_HOURS.end;
  // A row with the start not before the end (written around the save's check) reads as the default day.
  const day = isWorkStretch(start, end)
    ? { start, end }
    : { start: DEFAULT_WORK_HOURS.start, end: DEFAULT_WORK_HOURS.end };
  return {
    ...day,
    // An older row may hold the zone at the top level; the product's own zone when there is none.
    timeZone:
      savedTimeZone(hours.timeZone) ??
      savedTimeZone(stored.timeZone) ??
      DEFAULT_TIME_ZONE,
    weekends:
      typeof hours.weekends === "boolean"
        ? hours.weekends
        : DEFAULT_WORK_HOURS.weekends,
  };
}

/*
 * What is stored, over the defaults. A skin a later build no longer ships stays in the row, so going
 * back to a build that has it brings it back, but this build answers with its default.
 */
function withDefaults(
  stored: Partial<UserPreferences> & Record<string, unknown>,
): StoredUserPreferences {
  const preferences = { ...DEFAULT_USER_PREFERENCES, ...stored };
  // A row saved before the rename holds the old default's name; it reads as the new one.
  return {
    ...preferences,
    skin: normalizeSkinId(String(preferences.skin)),
    workHours: workHoursOf(stored),
  };
}

/**
 * The person's work hours and time zone, read fresh from their preferences in their own frame
 * (spec §10). Nobody found reads as the defaults on the product's zone.
 */
export async function readWorkHours(
  database: Database,
  userId: string,
): Promise<WorkHours> {
  const [user] = await runAsTenant(userId, () =>
    database
      .select({ preferences: users.preferences })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  );
  return workHoursOf((user?.preferences ?? {}) as Record<string, unknown>);
}

export type UserPreferencesStore = {
  claimStarterTour: (userId: string, channelId: string) => Promise<void>;
  read: (userId: string) => Promise<StoredUserPreferences>;
  patch: (
    userId: string,
    preferences: UserPreferencesPatch,
  ) => Promise<StoredUserPreferences>;
};

export function createUserPreferencesStore(
  database: Database,
): UserPreferencesStore {
  return {
    async claimStarterTour(userId, channelId) {
      // PostgreSQL rechecks the condition after a concurrent row update. Only one
      // new conversation can win, even across server processes; merge keeps other preferences.
      await database
        .update(users)
        .set({
          preferences: sql`${users.preferences} || ${{ starterTourChannelId: channelId }}::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(users.id, userId),
            sql`NOT (${users.preferences} ? 'starterTourChannelId')`,
          ),
        );
    },
    async read(userId) {
      const [user] = await database
        .select({ preferences: users.preferences })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) throw new Error("User preferences could not be found.");
      return withDefaults(user.preferences);
    },
    async patch(userId, patch) {
      const { workHours, browserTimeZone, ...preferences } = patch;
      /*
       * The work hours are merged one level down, so a save of the start time keeps the zone. The
       * browser's zone goes in under what is stored, and what is stored under what this save names:
       * the browser's zone only fills a gap, the person's own choice replaces.
       */
      const hours =
        workHours !== undefined || browserTimeZone !== undefined
          ? sql`|| jsonb_build_object('workHours', ${
              browserTimeZone !== undefined ? { timeZone: browserTimeZone } : {}
            }::jsonb || coalesce(${users.preferences} -> 'workHours', '{}'::jsonb) || ${workHours ?? {}}::jsonb)`
          : sql``;
      const [user] = await database
        .update(users)
        .set({
          // Merge in Postgres so simultaneous updates to different preferences are preserved.
          preferences: sql`${users.preferences} || ${preferences}::jsonb ${hours}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
        .returning({ preferences: users.preferences });
      if (!user) throw new Error("User preferences could not be saved.");
      return withDefaults(user.preferences);
    },
  };
}
