import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SKIN,
  isKnownSkinInput,
  normalizeSkinId,
  SKIN_IDS,
} from "@xiongbao/shared/user-preferences";
import {
  parseStoredSkin,
  reconcileSkin,
  SKIN_STORAGE_KEY,
} from "../src/skins/store";

describe("a skin name this build does not ship", () => {
  test("the default is xiongbao", () => {
    expect(DEFAULT_SKIN).toBe("xiongbao");
  });

  test("normalizeSkinId falls back to the default for a name it does not ship", () => {
    // The default's name before the rename is one of those: no longer translated, simply unknown, and
    // an unknown name draws the default. The account's stored value is unchanged until the person picks a skin.
    for (const id of SKIN_IDS) expect(normalizeSkinId(id)).toBe(id);
    expect(normalizeSkinId("retired-skin")).toBe(DEFAULT_SKIN);
    expect(normalizeSkinId("")).toBe(DEFAULT_SKIN);
  });

  test("an unknown name is not accepted as input", () => {
    expect(isKnownSkinInput("xiongbao")).toBe(true);
    expect(isKnownSkinInput("retired-skin")).toBe(false);
    expect(isKnownSkinInput(null)).toBe(false);
  });

  test("a browser cache holding an unknown name draws the default, clears the attribute and is rewritten to the default", () => {
    expect(parseStoredSkin("retired-skin")).toBe("xiongbao");
    const roots: Array<string | null> = [];
    const stored: Array<[string, string]> = [];
    expect(
      reconcileSkin("retired-skin", {
        setRootSkin: (id) => roots.push(id),
        setStoredValue: (key, value) => stored.push([key, value]),
      }),
    ).toBe("xiongbao");
    expect(roots).toEqual([null]);
    expect(stored).toEqual([[SKIN_STORAGE_KEY, "xiongbao"]]);
  });

  test("a cache already holding a skin this build ships, or nothing, is left as it is", () => {
    const stored: Array<[string, string]> = [];
    const effects = {
      setRootSkin: () => {},
      setStoredValue: (key: string, value: string) => stored.push([key, value]),
    };
    for (const id of SKIN_IDS) expect(reconcileSkin(id, effects)).toBe(id);
    expect(reconcileSkin(null, effects)).toBe(DEFAULT_SKIN);
    expect(stored).toEqual([]);
  });
});
