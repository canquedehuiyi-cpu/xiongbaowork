import {
  DEFAULT_QUIET_HOURS,
  DEFAULT_RUN_END_NOTICE,
  DEFAULT_USER_PREFERENCES,
  normalizeSkinId,
  type QuietHours,
  RUN_END_NOTICE_CHANNELS,
  type RunEndNoticePreferences,
  type StoredPreferences,
  type UserPreferences,
  type WorkHours,
} from "@xiongbao/shared/user-preferences";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./db/client";
import { users } from "./db/schema";
import { DEFAULT_TIME_ZONE } from "./tasks/delivery-tools";
import { runAsTenant } from "./tenant/context";

/*
 * 作息的定义在 shared，因为它同时存在于 `users.preferences` 那一列的类型里和设置页的读取里。这里转出去，
 * 让 `from "./user-preferences"` 的既有引用不用改。
 */
export type { WorkHours };

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
function workHoursOf(stored: StoredPreferences): WorkHours {
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
function withDefaults(stored: StoredPreferences): StoredUserPreferences {
  // The run-end switches and the quiet hours have their own reads; the general one keeps its old shape.
  const { runEndNotice: _own, quietHours: _quiet, ...general } = stored;
  const preferences = { ...DEFAULT_USER_PREFERENCES, ...general };
  // A row saved before the rename holds the old default's name; it reads as the new one.
  return {
    ...preferences,
    skin: normalizeSkinId(String(preferences.skin)),
    workHours: workHoursOf(general),
  };
}

/**
 * The run-end switches a stored row says, over the defaults: on unless the row says `false`. Anything
 * else in the row (a missing key, a value that is not a boolean) reads as on, so a malformed row never
 * silences a person.
 */
export function runEndNoticeOf(
  stored: StoredPreferences,
): RunEndNoticePreferences {
  const saved =
    stored.runEndNotice && typeof stored.runEndNotice === "object"
      ? (stored.runEndNotice as Record<string, unknown>)
      : {};
  const notice = { ...DEFAULT_RUN_END_NOTICE };
  for (const channel of RUN_END_NOTICE_CHANNELS)
    if (saved[channel] === false) notice[channel] = false;
  return notice;
}

/**
 * 安静时段在这个部署上怎么算：`on`（默认）没存过的人也用 22:00–08:00；`opt-in` 只有本人自己存过且开着的才算；
 * `off` 整个部署不看安静时段，所有入口照旧。每次现读，改了环境变量重启就生效。
 */
export type QuietHoursMode = "on" | "opt-in" | "off";

export function quietHoursMode(
  environment: Record<string, string | undefined> = process.env,
): QuietHoursMode {
  const value = environment.XIONGBAO_QUIET_HOURS?.trim().toLowerCase();
  return value === "off" || value === "opt-in" ? value : "on";
}

/**
 * The quiet hours a stored row says, over the defaults. A malformed clock reads as the default one, so
 * a bad row never makes the whole day quiet; in `opt-in` mode a row with no saved quiet hours is off.
 */
export function quietHoursOf(
  stored: StoredPreferences,
  mode: QuietHoursMode = quietHoursMode(),
): QuietHours {
  const saved =
    stored.quietHours && typeof stored.quietHours === "object"
      ? (stored.quietHours as Record<string, unknown>)
      : undefined;
  const hours = saved ?? {};
  return {
    enabled:
      typeof hours.enabled === "boolean"
        ? hours.enabled
        : // Anything saved is the person opting in; nothing saved follows the deployment's mode.
          saved !== undefined || mode !== "opt-in",
    start: isWorkClock(hours.start) ? hours.start : DEFAULT_QUIET_HOURS.start,
    end: isWorkClock(hours.end) ? hours.end : DEFAULT_QUIET_HOURS.end,
  };
}

/** What deciding "is it quiet for this person now" needs: their quiet hours and the zone they are read in. */
export type QuietUser = { quietHours: QuietHours; timeZone: string };

const clockFormats = new Map<string, Intl.DateTimeFormat>();

/** The minute of the local day `at` is in `timeZone`, 0 to 1439. */
function localMinute(at: Date, timeZone: string): number {
  let format = clockFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    });
    clockFormats.set(timeZone, format);
  }
  let hours = 0;
  let minutes = 0;
  for (const part of format.formatToParts(at)) {
    if (part.type === "hour") hours = Number(part.value);
    if (part.type === "minute") minutes = Number(part.value);
  }
  return (hours % 24) * 60 + minutes;
}

/**
 * Whether `now` falls in the person's quiet hours, on their own clock. The start is inside and the end
 * is not; a start later than the end runs across midnight (22:00 to 08:00 is quiet at 23:30 and at
 * 07:59, not at 08:00); a start equal to the end is no quiet time at all. Off in `off` mode.
 */
export function inQuietHours(
  user: QuietUser,
  now: Date,
  mode: QuietHoursMode = quietHoursMode(),
): boolean {
  if (mode === "off" || !user.quietHours.enabled) return false;
  const start = minuteOfClock(user.quietHours.start);
  const end = minuteOfClock(user.quietHours.end);
  if (start === end) return false;
  const minute = localMinute(now, user.timeZone);
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

/**
 * The first moment after `now` that is not quiet, or null when `now` is not quiet. Found by stepping a
 * minute at a time, so a daylight-saving jump inside the stretch cannot make it land early.
 */
export function quietHoursEnd(
  user: QuietUser,
  now: Date,
  mode: QuietHoursMode = quietHoursMode(),
): Date | null {
  if (!inQuietHours(user, now, mode)) return null;
  const minute = 60_000;
  let at = new Date(Math.floor(now.getTime() / minute) * minute + minute);
  // A day's worth of minutes is the longest stretch there can be.
  for (let step = 0; step < 24 * 60 && inQuietHours(user, at, mode); step += 1)
    at = new Date(at.getTime() + minute);
  return at;
}

/**
 * The person's quiet hours and zone, read fresh in their own frame. A person who cannot be read is not
 * quiet, so a database blip never holds anyone's work back, and says so in the log.
 */
export async function readQuietUser(
  database: Database,
  userId: string,
): Promise<QuietUser | null> {
  try {
    const [user] = await runAsTenant(userId, () =>
      database
        .select({ preferences: users.preferences })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    );
    if (!user) return null;
    return {
      quietHours: quietHoursOf(user.preferences),
      timeZone: workHoursOf(user.preferences).timeZone,
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        type: "quiet-hours-read-failed",
        reason: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return null;
  }
}

/**
 * The one question every proactive door asks: until when is this person's quiet time, or null when
 * they may be reached now. `urgent` work is never held.
 */
export type QuietUntil = (
  ownerUserId: string,
  options?: { urgent?: boolean; now?: Date },
) => Promise<Date | null>;

export function createQuietUntil(
  database: Database,
  clock: () => Date = () => new Date(),
): QuietUntil {
  return async (ownerUserId, options) => {
    if (options?.urgent) return null;
    if (quietHoursMode() === "off") return null;
    const user = await readQuietUser(database, ownerUserId);
    return user ? quietHoursEnd(user, options?.now ?? clock()) : null;
  };
}

/**
 * Whether a person's own page, phone and chat platforms are told a turn ended while they were away
 * (`threads/turn-notice.ts`), read fresh from their preferences in their own frame. Nobody found reads
 * as everything on.
 */
export async function readRunEndNotice(
  database: Database,
  userId: string,
): Promise<RunEndNoticePreferences> {
  const [user] = await runAsTenant(userId, () =>
    database
      .select({ preferences: users.preferences })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  );
  return runEndNoticeOf(user?.preferences ?? {});
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
  return workHoursOf(user?.preferences ?? {});
}

/** The run-end switches: one read, and a save that names any of them and keeps the rest. */
export type RunEndNoticeStore = {
  read: (userId: string) => Promise<RunEndNoticePreferences>;
  patch: (
    userId: string,
    patch: Partial<RunEndNoticePreferences>,
  ) => Promise<RunEndNoticePreferences>;
};

/** 起止相同（等于没有安静时段）的保存，在库里被拒。 */
export class QuietHoursRefusedError extends Error {
  override name = "QuietHoursRefusedError";
}

/** The quiet hours: one read, and a save that names any part of them and keeps the rest. */
export type QuietHoursStore = {
  read: (userId: string) => Promise<QuietHours & { timeZone: string }>;
  patch: (
    userId: string,
    patch: Partial<QuietHours>,
  ) => Promise<QuietHours & { timeZone: string }>;
};

export type UserPreferencesStore = {
  /** Absent in a fake that does not care about the run-end switches. */
  runEndNotice?: RunEndNoticeStore;
  /** Absent in a fake that does not care about the quiet hours. */
  quietHours?: QuietHoursStore;
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
    runEndNotice: {
      async read(userId) {
        const [user] = await database
          .select({ preferences: users.preferences })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (!user) throw new Error("User preferences could not be found.");
        return runEndNoticeOf(user.preferences);
      },
      async patch(userId, patch) {
        // Merged one level down in Postgres, so saving one switch keeps the others and a save of
        // another preference at the same moment is not lost.
        const [user] = await database
          .update(users)
          .set({
            preferences: sql`${users.preferences} || jsonb_build_object('runEndNotice', coalesce(${users.preferences} -> 'runEndNotice', '{}'::jsonb) || ${patch}::jsonb)`,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId))
          .returning({ preferences: users.preferences });
        if (!user) throw new Error("User preferences could not be saved.");
        return runEndNoticeOf(user.preferences);
      },
    },
    quietHours: {
      async read(userId) {
        const [user] = await database
          .select({ preferences: users.preferences })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (!user) throw new Error("User preferences could not be found.");
        return {
          ...quietHoursOf(user.preferences),
          timeZone: workHoursOf(user.preferences).timeZone,
        };
      },
      async patch(userId, patch) {
        /*
         * Merged one level down in Postgres, so saving the start keeps the end and the switch. 起止相同的检查和写入
         * 是同一条 UPDATE（条件里用合并后的起止），两次同时保存各改一头也不会写出一个起止相同的时段。
         */
        const [user] = await database
          .update(users)
          .set({
            preferences: sql`${users.preferences} || jsonb_build_object('quietHours', coalesce(${users.preferences} -> 'quietHours', '{}'::jsonb) || ${patch}::jsonb)`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(users.id, userId),
              sql`coalesce(${patch.start ?? null}::text, ${users.preferences} -> 'quietHours' ->> 'start', ${DEFAULT_QUIET_HOURS.start}) <> coalesce(${patch.end ?? null}::text, ${users.preferences} -> 'quietHours' ->> 'end', ${DEFAULT_QUIET_HOURS.end})`,
            ),
          )
          .returning({ preferences: users.preferences });
        if (!user) {
          const [exists] = await database
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          if (exists) throw new QuietHoursRefusedError("start equals end");
          throw new Error("User preferences could not be saved.");
        }
        return {
          ...quietHoursOf(user.preferences),
          timeZone: workHoursOf(user.preferences).timeZone,
        };
      },
    },
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
