import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SKIN,
  isKnownSkinInput,
  normalizeSkinId,
  SKIN_IDS,
} from "@openbot/shared/user-preferences";
import { parseStoredSkin, reconcileSkin } from "../src/skins/store";

describe("the default skin's old name", () => {
  test("the default is xiongbao", () => {
    expect(DEFAULT_SKIN).toBe("xiongbao");
    expect(SKIN_IDS).not.toContain("openbot");
  });

  test("normalizeSkinId reads the old default name as the new one and leaves the others alone", () => {
    expect(normalizeSkinId("openbot")).toBe("xiongbao");
    for (const id of SKIN_IDS) expect(normalizeSkinId(id)).toBe(id);
    expect(normalizeSkinId("retired-skin")).toBe(DEFAULT_SKIN);
    expect(normalizeSkinId("")).toBe(DEFAULT_SKIN);
  });

  test("the old name is still accepted as input, an unknown one is not", () => {
    expect(isKnownSkinInput("openbot")).toBe(true);
    expect(isKnownSkinInput("xiongbao")).toBe(true);
    expect(isKnownSkinInput("retired-skin")).toBe(false);
    expect(isKnownSkinInput(null)).toBe(false);
  });

  test("a browser cache holding the old name draws the default and clears the attribute", () => {
    expect(parseStoredSkin("openbot")).toBe("xiongbao");
    const roots: Array<string | null> = [];
    expect(
      reconcileSkin("openbot", { setRootSkin: (id) => roots.push(id) }),
    ).toBe("xiongbao");
    expect(roots).toEqual([null]);
  });
});
