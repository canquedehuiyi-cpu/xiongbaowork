import { expect, test } from "bun:test";
import {
  CANDIDATE_REF,
  discoveryGroups,
  readDiscovery,
} from "../src/computer/app-discovery";

const REF = "cand_abc123_AAAAAAAAAAAAAAAAAAAAAA";
const REF2 = "cand_abc123_BBBBBBBBBBBBBBBBBBBBBB";

const good = {
  ref: REF,
  name: "笔记",
  sourceLabel: "Claude 桌面版",
  kind: "stdio",
  status: "needs_uv",
  note: "需要先安装 uv",
  enabled: false,
};

test("readDiscovery keeps ref, name, source label, kind, status and note; drops bad refs, long names, unknown statuses, extra fields and the app ref", () => {
  const read = readDiscovery({
    candidates: [
      { ...good, app: "app_secret", command: "C:\\x.exe", env: { K: "v" } },
      { ...good, ref: "not-a-ref" },
      { ...good, ref: REF2, name: "长".repeat(41) },
      { ...good, ref: REF2, name: "" },
      { ...good, ref: REF2, name: "  \t " },
      { ...good, ref: REF2, sourceLabel: "源".repeat(61) },
      { ...good, ref: REF2, status: "enabled" },
      { ...good, ref: REF2, kind: "sse" },
      { ...good, ref: REF2, note: "注".repeat(121), name: "仓库" },
      { ...good, ref: REF2, note: undefined, name: "仓库2", status: "ready" },
      "nope",
    ],
    installed: ["微信", "", 5, "长".repeat(121)],
    installedTruncated: 7,
    platform: "win32",
  });
  expect(CANDIDATE_REF.test(REF)).toBeTrue();
  expect(read).toEqual({
    candidates: [
      {
        candidate: REF,
        name: "笔记",
        source: "Claude 桌面版",
        kind: "stdio",
        status: "needs_uv",
        note: "需要先安装 uv",
        enabled: false,
      },
      {
        // Too long a note is dropped; the candidate stays.
        candidate: REF2,
        name: "仓库",
        source: "Claude 桌面版",
        kind: "stdio",
        status: "needs_uv",
        enabled: false,
      },
      {
        candidate: REF2,
        name: "仓库2",
        source: "Claude 桌面版",
        kind: "stdio",
        status: "ready",
        enabled: false,
      },
    ],
    installed: ["微信"],
  });
  expect(readDiscovery("x")).toBeUndefined();
  expect(readDiscovery(null)).toBeUndefined();
  expect(readDiscovery([])).toBeUndefined();
});

test("discoveryGroups leaves enabled candidates out of available and known names out of installed", () => {
  const read = readDiscovery({
    candidates: [
      { ...good, name: "Notes", enabled: true },
      { ...good, ref: REF2, name: "Figma", status: "ready", enabled: false },
    ],
    installed: ["notes", "FIGMA", "微信", "Mine"],
  });
  if (!read) throw new Error("no read");
  const groups = discoveryGroups(read, ["mine"]);
  expect(groups.available.map((c) => c.name)).toEqual(["Figma"]);
  expect("enabled" in (groups.available[0] ?? {})).toBeFalse();
  expect(groups.installed).toEqual(["微信"]);
});

test("caps: 50 candidates, 200 installed names", () => {
  const candidates = Array.from({ length: 80 }, (_, i) => ({
    ...good,
    ref: `cand_abc123_${String(i).padStart(22, "A")}`,
    name: `app${i}`,
  }));
  const installed = Array.from({ length: 300 }, (_, i) => `soft${i}`);
  const read = readDiscovery({ candidates, installed });
  expect(read?.candidates).toHaveLength(50);
  expect(read?.installed).toHaveLength(200);
});
