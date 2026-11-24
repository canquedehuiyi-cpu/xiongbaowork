import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SKIN,
  isKnownSkinInput,
  normalizeSkinId,
  SKIN_IDS,
} from "@xiongbao/shared/user-preferences";
import { parseStoredSkin, reconcileSkin } from "../src/skins/store";

describe("the default skin's old name", () => {
  test("the default is xiongbao", () => {
    expect(DEFAULT_SKIN).toBe("xiongbao");
    expect(SKIN_IDS).not.toContain("openbot");
  });

  test("normalizeSkinId falls back to the default for a name it does not ship, the old default among them", () => {
    // The window of the old name closed: it is no longer translated, it is simply unknown, and an
    // unknown name draws the default. The stored value is unchanged until the person picks a skin.
    expect(normalizeSkinId("openbot")).toBe("xiongbao");
    for (const id of SKIN_IDS) expect(normalizeSkinId(id)).toBe(id);
    expect(normalizeSkinId("retired-skin")).toBe(DEFAULT_SKIN);
    expect(normalizeSkinId("")).toBe(DEFAULT_SKIN);
  });

  test("the old name is no longer accepted as input, and an unknown one is not either", () => {
    expect(isKnownSkinInput("openbot")).toBe(false);
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
