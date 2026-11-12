import { PRESET_IMAGES } from "@/components/portraits/preset-images";
import type { PortraitPreset } from "@/lib/portraits/queries";

/**
 * One looping animation for every face, in the seven states a Muse avatar has: the face that is
 * drawn while connecting, idling, making something, celebrating a milestone, waiting for other
 * agents, waking, and working. A staff or group portrait gets the same seven, so a roster never
 * has to guess which faces can move.
 *
 * WHAT AN ANIMATION IS HERE. The poster is the preset's picture; the movement is a small CSS loop
 * on that picture (a bob, a sway, a pulse — never a new drawing). A video file per state is the
 * next step and deliberately not in this batch: the poster and the loop are what the picker can
 * preview today, and `videoUrl` stays null until a video is shipped for that state.
 */
export const AVATAR_MOTION_STATES = [
  "connecting",
  "idle",
  "making_something",
  "milestone_level_up",
  "waiting_for_subagents",
  "waking",
  "working",
] as const;

export type AvatarMotionState = (typeof AVATAR_MOTION_STATES)[number];

export const AVATAR_MOTION_LABELS: Record<AvatarMotionState, string> = {
  connecting: "正在连接",
  idle: "待机",
  making_something: "正在制作",
  milestone_level_up: "升级庆祝",
  waiting_for_subagents: "等待队友",
  waking: "唤醒",
  working: "工作中",
};

/** The CSS loop each state draws; the keyframes live in `app/src/styles.css`. */
export const AVATAR_MOTION_CLASS: Record<AvatarMotionState, string> = {
  connecting: "portrait-motion-connecting",
  idle: "portrait-motion-idle",
  making_something: "portrait-motion-making-something",
  milestone_level_up: "portrait-motion-milestone-level-up",
  waiting_for_subagents: "portrait-motion-waiting-for-subagents",
  waking: "portrait-motion-waking",
  working: "portrait-motion-working",
};

export type PresetAnimation = {
  preset: PortraitPreset;
  state: AvatarMotionState;
  /** The still face this state starts from — and falls back to when motion is off. */
  poster: string;
  /** The loop this state plays on the poster. */
  motionClass: string;
  /** A video for this state, when one is shipped; null until then. */
  videoUrl: string | null;
};

function animationFor(
  preset: PortraitPreset,
  state: AvatarMotionState,
): PresetAnimation {
  return {
    preset,
    state,
    poster: PRESET_IMAGES[preset],
    motionClass: AVATAR_MOTION_CLASS[state],
    videoUrl: null,
  };
}

/** Every preset, in every one of the seven states: five faces, thirty-five animations. */
export const PRESET_ANIMATIONS: Record<
  PortraitPreset,
  Record<AvatarMotionState, PresetAnimation>
> = {
  naughty: {
    connecting: animationFor("naughty", "connecting"),
    idle: animationFor("naughty", "idle"),
    making_something: animationFor("naughty", "making_something"),
    milestone_level_up: animationFor("naughty", "milestone_level_up"),
    waiting_for_subagents: animationFor("naughty", "waiting_for_subagents"),
    waking: animationFor("naughty", "waking"),
    working: animationFor("naughty", "working"),
  },
  cute: {
    connecting: animationFor("cute", "connecting"),
    idle: animationFor("cute", "idle"),
    making_something: animationFor("cute", "making_something"),
    milestone_level_up: animationFor("cute", "milestone_level_up"),
    waiting_for_subagents: animationFor("cute", "waiting_for_subagents"),
    waking: animationFor("cute", "waking"),
    working: animationFor("cute", "working"),
  },
  cool: {
    connecting: animationFor("cool", "connecting"),
    idle: animationFor("cool", "idle"),
    making_something: animationFor("cool", "making_something"),
    milestone_level_up: animationFor("cool", "milestone_level_up"),
    waiting_for_subagents: animationFor("cool", "waiting_for_subagents"),
    waking: animationFor("cool", "waking"),
    working: animationFor("cool", "working"),
  },
  happy: {
    connecting: animationFor("happy", "connecting"),
    idle: animationFor("happy", "idle"),
    making_something: animationFor("happy", "making_something"),
    milestone_level_up: animationFor("happy", "milestone_level_up"),
    waiting_for_subagents: animationFor("happy", "waiting_for_subagents"),
    waking: animationFor("happy", "waking"),
    working: animationFor("happy", "working"),
  },
  sweet: {
    connecting: animationFor("sweet", "connecting"),
    idle: animationFor("sweet", "idle"),
    making_something: animationFor("sweet", "making_something"),
    milestone_level_up: animationFor("sweet", "milestone_level_up"),
    waiting_for_subagents: animationFor("sweet", "waiting_for_subagents"),
    waking: animationFor("sweet", "waking"),
    working: animationFor("sweet", "working"),
  },
};
