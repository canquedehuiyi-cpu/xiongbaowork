export type MessageListEmphasis = "agent" | "thread";

/** Whether this person's Bots check in on their behalf at all. */
export type ProactivePreference = "on" | "off";
/**
 * Every skin this product ships. `xiongbao` is the default and is the product exactly as it is without a
 * skin: no frame of its own, no tokens of its own.
 *
 * Here rather than in the app because the choice is saved on the person's account, so the server
 * has to know which values it may store.
 */
export const SKIN_IDS = [
  "xiongbao",
  "classic",
  "openduet",
  "opendots",
  "openmuse",
] as const;

export type SkinId = (typeof SKIN_IDS)[number];

export const DEFAULT_SKIN: SkinId = "xiongbao";

export function isSkinId(value: unknown): value is SkinId {
  return SKIN_IDS.some((id) => id === value);
}

/**
 * The input this build accepts: the ids it ships. The name the default went by before the rename is not
 * one of them any more, and its window has closed, so it is refused rather than carried along.
 */
export function isKnownSkinInput(value: unknown): value is string {
  return isSkinId(value);
}

/**
 * The id this build draws for a saved one: anything unknown, the old name of the default included,
 * reads as the default.
 */
export function normalizeSkinId(id: string): SkinId {
  return isSkinId(id) ? id : DEFAULT_SKIN;
}

export type UserPreferences = {
  /** Server-owned first new eligible conversation; shared by both starter Bots. */
  starterTourChannelId?: string;
  /** Set by profile saves so choosing a name finishes the first-run prompt. */
  profileNameSet?: boolean;
  messageListEmphasis: MessageListEmphasis;
  /** Whether this person closed the banner offering help self-hosting XiongBao. */
  selfHostBannerDismissed: boolean;
  /** How XiongBao looks for this person, on every device they sign in from. */
  skin: SkinId;
  /**
   * Check-ins for all of this person's Bots. On by default; `off` stops every Bot's background
   * checks for them before any model call, whatever each Bot's own setting says. Each Bot's own
   * on, off and interval stay as they were, so turning this back on restores them.
   */
  proactive: ProactivePreference;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  messageListEmphasis: "thread",
  selfHostBannerDismissed: false,
  skin: DEFAULT_SKIN,
  proactive: "on",
};

/**
 * When a person works, on their own clock (spec 2026-11-15-delivery-loop §10): the delivery checker
 * pushes nothing outside it, and the start and end briefings go out at its two ends.
 *
 * Here rather than in the server because it is stored on the person's account: the settings page
 * writes it and the server reads it, so both need the one shape.
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
 * 安静时段（期 3·3.2）：这段时间里，员工不主动开轮、不推送通知。按本人的时区算，可以跨午夜（22:00 到次日
 * 08:00）。开始和结束相同当作没有这段时间。存在 `users.preferences.quietHours`，没存过的人用默认：22:00 到 08:00，
 * 开着；部署上用 `XIONGBAO_QUIET_HOURS` 整体关掉，或改成「要本人自己设了才算」。
 */
export type QuietHours = {
  enabled: boolean;
  /** "HH:MM". */
  start: string;
  /** "HH:MM"，早于 `start` 就是跨午夜。 */
  end: string;
};

export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: true,
  start: "22:00",
  end: "08:00",
};

/**
 * Where a person is told that a conversation's turn ended while nobody was looking at it
 * (threads/turn-notice.ts): their phone, the chat platforms they bound (WeChat and the like), and the
 * pages of the app they have open (web and desktop system notifications).
 *
 * One switch each, all on until the person turns one off. Kept in the person's own preferences row
 * under `runEndNotice`, and read and written through `/api/settings/preferences/run-notice` rather than
 * the general preferences read, whose shape stays what it was.
 */
export const RUN_END_NOTICE_CHANNELS = ["push", "im", "desktop"] as const;
export type RunEndNoticeChannel = (typeof RUN_END_NOTICE_CHANNELS)[number];
export type RunEndNoticePreferences = Record<RunEndNoticeChannel, boolean>;

export const DEFAULT_RUN_END_NOTICE: RunEndNoticePreferences = {
  push: true,
  im: true,
  desktop: true,
};

/**
 * What a `users.preferences` row holds: the preferences above, this person's work hours, and — from
 * builds that predate work hours having an object of their own — the zone at the top level.
 *
 * Every field is optional because a row is a merge target: a save writes the keys it names and leaves
 * the rest (`createUserPreferencesStore().patch`), and a read fills the gaps with the defaults. The
 * column said `Partial<UserPreferences>` until this type existed, which was a row that could not hold
 * the work hours it was being written with.
 */
export type StoredPreferences = Partial<UserPreferences> & {
  workHours?: Partial<WorkHours>;
  /** An older row's zone: read when `workHours` carries none. */
  timeZone?: string;
  /** Which carriers hear that a turn ended while the person was away; a missing one is on. */
  runEndNotice?: Partial<RunEndNoticePreferences>;
  /** 安静时段；缺的键用默认，整段没存过的人看部署的 `XIONGBAO_QUIET_HOURS`。 */
  quietHours?: Partial<QuietHours>;
};
