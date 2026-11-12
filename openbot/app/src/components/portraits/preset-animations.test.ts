import { expect, test } from "bun:test";
import {
  AVATAR_MOTION_CLASS,
  AVATAR_MOTION_LABELS,
  AVATAR_MOTION_STATES,
  PRESET_ANIMATIONS,
} from "./preset-animations";
import { BAO_ROLE_PRESETS, PORTRAIT_PRESETS } from "@/lib/portraits/queries";

test("every preset has all seven motion states, each with a poster and a loop", () => {
  expect(AVATAR_MOTION_STATES).toHaveLength(7);
  expect(PORTRAIT_PRESETS).toHaveLength(5);
  expect(BAO_ROLE_PRESETS).toHaveLength(45);
  const allPresets = [...PORTRAIT_PRESETS, ...BAO_ROLE_PRESETS];
  expect(allPresets).toHaveLength(50);
  for (const preset of allPresets) {
    const states = PRESET_ANIMATIONS[preset.value];
    expect(Object.keys(states).sort()).toEqual([...AVATAR_MOTION_STATES].sort());
    for (const state of AVATAR_MOTION_STATES) {
      const animation = states[state];
      expect(animation.preset).toBe(preset.value);
      expect(animation.state).toBe(state);
      expect(animation.poster.length).toBeGreaterThan(0);
      expect(animation.motionClass).toBe(AVATAR_MOTION_CLASS[state]);
      expect(AVATAR_MOTION_LABELS[state].length).toBeGreaterThan(0);
    }
  }
});

test("the seven states each move differently", () => {
  const classes = new Set(Object.values(AVATAR_MOTION_CLASS));
  expect(classes.size).toBe(7);
});
