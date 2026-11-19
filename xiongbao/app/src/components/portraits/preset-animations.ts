import coolConnectingVideo from "@/assets/brand/bao-xiaoxiong/videos/cool-connecting.mp4";
import coolIdleVideo from "@/assets/brand/bao-xiaoxiong/videos/cool-idle.mp4";
import coolMakingSomethingVideo from "@/assets/brand/bao-xiaoxiong/videos/cool-making-something.mp4";
import coolMilestoneLevelUpVideo from "@/assets/brand/bao-xiaoxiong/videos/cool-milestone-level-up.mp4";
import coolWaitingForSubagentsVideo from "@/assets/brand/bao-xiaoxiong/videos/cool-waiting-for-subagents.mp4";
import coolWakingVideo from "@/assets/brand/bao-xiaoxiong/videos/cool-waking.mp4";
import coolWorkingVideo from "@/assets/brand/bao-xiaoxiong/videos/cool-working.mp4";
import cuteConnectingVideo from "@/assets/brand/bao-xiaoxiong/videos/cute-connecting.mp4";
import cuteIdleVideo from "@/assets/brand/bao-xiaoxiong/videos/cute-idle.mp4";
import cuteMakingSomethingVideo from "@/assets/brand/bao-xiaoxiong/videos/cute-making-something.mp4";
import cuteMilestoneLevelUpVideo from "@/assets/brand/bao-xiaoxiong/videos/cute-milestone-level-up.mp4";
import cuteWaitingForSubagentsVideo from "@/assets/brand/bao-xiaoxiong/videos/cute-waiting-for-subagents.mp4";
import cuteWakingVideo from "@/assets/brand/bao-xiaoxiong/videos/cute-waking.mp4";
import cuteWorkingVideo from "@/assets/brand/bao-xiaoxiong/videos/cute-working.mp4";
import happyConnectingVideo from "@/assets/brand/bao-xiaoxiong/videos/happy-connecting.mp4";
import happyIdleVideo from "@/assets/brand/bao-xiaoxiong/videos/happy-idle.mp4";
import happyMakingSomethingVideo from "@/assets/brand/bao-xiaoxiong/videos/happy-making-something.mp4";
import happyMilestoneLevelUpVideo from "@/assets/brand/bao-xiaoxiong/videos/happy-milestone-level-up.mp4";
import happyWaitingForSubagentsVideo from "@/assets/brand/bao-xiaoxiong/videos/happy-waiting-for-subagents.mp4";
import happyWakingVideo from "@/assets/brand/bao-xiaoxiong/videos/happy-waking.mp4";
import happyWorkingVideo from "@/assets/brand/bao-xiaoxiong/videos/happy-working.mp4";
import naughtyConnectingVideo from "@/assets/brand/bao-xiaoxiong/videos/naughty-connecting.mp4";
import naughtyIdleVideo from "@/assets/brand/bao-xiaoxiong/videos/naughty-idle.mp4";
import naughtyMakingSomethingVideo from "@/assets/brand/bao-xiaoxiong/videos/naughty-making-something.mp4";
import naughtyMilestoneLevelUpVideo from "@/assets/brand/bao-xiaoxiong/videos/naughty-milestone-level-up.mp4";
import naughtyWaitingForSubagentsVideo from "@/assets/brand/bao-xiaoxiong/videos/naughty-waiting-for-subagents.mp4";
import naughtyWakingVideo from "@/assets/brand/bao-xiaoxiong/videos/naughty-waking.mp4";
import naughtyWorkingVideo from "@/assets/brand/bao-xiaoxiong/videos/naughty-working.mp4";
import sweetConnectingVideo from "@/assets/brand/bao-xiaoxiong/videos/sweet-connecting.mp4";
import sweetIdleVideo from "@/assets/brand/bao-xiaoxiong/videos/sweet-idle.mp4";
import sweetMakingSomethingVideo from "@/assets/brand/bao-xiaoxiong/videos/sweet-making-something.mp4";
import sweetMilestoneLevelUpVideo from "@/assets/brand/bao-xiaoxiong/videos/sweet-milestone-level-up.mp4";
import sweetWaitingForSubagentsVideo from "@/assets/brand/bao-xiaoxiong/videos/sweet-waiting-for-subagents.mp4";
import sweetWakingVideo from "@/assets/brand/bao-xiaoxiong/videos/sweet-waking.mp4";
import sweetWorkingVideo from "@/assets/brand/bao-xiaoxiong/videos/sweet-working.mp4";
import { PRESET_IMAGES } from "@/components/portraits/preset-images";
import { BAO_ROLE_PRESETS, PORTRAIT_PRESETS, type PortraitPreset } from "@/lib/portraits/queries";
/**
 * One looping animation for every face, in the seven states a Muse avatar has: the face that is
 * drawn while connecting, idling, making something, celebrating a milestone, waiting for other
 * agents, waking, and working. A staff or group portrait gets the same seven, so a roster never
 * has to guess which faces can move.
 *
 * WHAT AN ANIMATION IS HERE. The poster is the preset's picture; the movement is a small CSS loop
 * on that picture (a bob, a sway, a pulse — never a new drawing), or a shipped video loop for the
 * same state. The five expressions ship a video per state (第二批); a role face has the CSS loop
 * only, and its `videoUrl` stays null until a video is shipped for it.
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

/** A shipped video loop per state, for the five expressions only (第二批); roles have none yet. */
const PRESET_VIDEOS: Partial<
  Record<PortraitPreset, Partial<Record<AvatarMotionState, string>>>
> = {
  naughty: {
    connecting: naughtyConnectingVideo,
    idle: naughtyIdleVideo,
    making_something: naughtyMakingSomethingVideo,
    milestone_level_up: naughtyMilestoneLevelUpVideo,
    waiting_for_subagents: naughtyWaitingForSubagentsVideo,
    waking: naughtyWakingVideo,
    working: naughtyWorkingVideo,
  },
  cute: {
    connecting: cuteConnectingVideo,
    idle: cuteIdleVideo,
    making_something: cuteMakingSomethingVideo,
    milestone_level_up: cuteMilestoneLevelUpVideo,
    waiting_for_subagents: cuteWaitingForSubagentsVideo,
    waking: cuteWakingVideo,
    working: cuteWorkingVideo,
  },
  cool: {
    connecting: coolConnectingVideo,
    idle: coolIdleVideo,
    making_something: coolMakingSomethingVideo,
    milestone_level_up: coolMilestoneLevelUpVideo,
    waiting_for_subagents: coolWaitingForSubagentsVideo,
    waking: coolWakingVideo,
    working: coolWorkingVideo,
  },
  happy: {
    connecting: happyConnectingVideo,
    idle: happyIdleVideo,
    making_something: happyMakingSomethingVideo,
    milestone_level_up: happyMilestoneLevelUpVideo,
    waiting_for_subagents: happyWaitingForSubagentsVideo,
    waking: happyWakingVideo,
    working: happyWorkingVideo,
  },
  sweet: {
    connecting: sweetConnectingVideo,
    idle: sweetIdleVideo,
    making_something: sweetMakingSomethingVideo,
    milestone_level_up: sweetMilestoneLevelUpVideo,
    waiting_for_subagents: sweetWaitingForSubagentsVideo,
    waking: sweetWakingVideo,
    working: sweetWorkingVideo,
  },
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
    videoUrl: PRESET_VIDEOS[preset]?.[state] ?? null,
  };
}

/** Every named face, in every one of the seven states: fifty faces, three hundred and fifty animations. */
const ALL_PRESETS: PortraitPreset[] = [
  ...PORTRAIT_PRESETS.map((preset) => preset.value),
  ...BAO_ROLE_PRESETS.map((role) => role.value),
];

function animationsFor(preset: PortraitPreset): Record<AvatarMotionState, PresetAnimation> {
  return Object.fromEntries(
    AVATAR_MOTION_STATES.map((state) => [state, animationFor(preset, state)]),
  ) as Record<AvatarMotionState, PresetAnimation>;
}

/** Every preset, in every one of the seven states: fifty faces, three hundred and fifty animations. */
export const PRESET_ANIMATIONS: Record<
  PortraitPreset,
  Record<AvatarMotionState, PresetAnimation>
> = Object.fromEntries(
  ALL_PRESETS.map((preset) => [preset, animationsFor(preset)]),
) as Record<PortraitPreset, Record<AvatarMotionState, PresetAnimation>>;
