import { expect, test } from "bun:test";
import {
  CANDIDATE_REF,
  createCandidateCache,
  discoveryGroups,
  readDiscovery,
  readEnabled,
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

test("the candidate cache finds a ref for 10 minutes, per machine, and forgets the oldest past 1000 machines", () => {
  let clock = 1_000_000;
  const cache = createCandidateCache(() => clock);
  const here = { tenantId: "t1", deviceId: "studio" };
  const there = { tenantId: "t1", deviceId: "laptop" };
  const candidate = {
    candidate: REF,
    name: "笔记",
    source: "Claude 桌面版",
    kind: "stdio" as const,
    status: "ready" as const,
    enabled: false,
  };
  cache.remember(here, [candidate]);
  expect(cache.find(here, REF)).toEqual(candidate);
  // Another machine of the same tenant does not see it, nor another tenant's machine of that name.
  expect(cache.find(there, REF)).toBeUndefined();
  expect(
    cache.find({ tenantId: "t2", deviceId: "studio" }, REF),
  ).toBeUndefined();
  expect(cache.find(here, REF2)).toBeUndefined();
  clock += 599_999;
  expect(cache.find(here, REF)?.name).toBe("笔记");
  clock += 1;
  expect(cache.find(here, REF)).toBeUndefined();
  // A fresh listing starts the ten minutes again.
  cache.remember(here, [candidate]);
  expect(cache.find(here, REF)?.name).toBe("笔记");
  // 1000 more machines: the oldest (here) is forgotten; the newest are kept.
  for (let i = 0; i < 1000; i += 1)
    cache.remember({ tenantId: "t1", deviceId: `m${i}` }, [
      { ...candidate, name: `m${i}` },
    ]);
  expect(cache.find(here, REF)).toBeUndefined();
  expect(cache.find({ tenantId: "t1", deviceId: "m0" }, REF)?.name).toBe("m0");
  expect(cache.find({ tenantId: "t1", deviceId: "m999" }, REF)?.name).toBe(
    "m999",
  );
  // Remembered again, a machine goes to the back of the line: m1 is the oldest now.
  cache.remember({ tenantId: "t1", deviceId: "m0" }, [candidate]);
  cache.remember(there, [candidate]);
  expect(cache.find({ tenantId: "t1", deviceId: "m0" }, REF)).toBeDefined();
  expect(cache.find({ tenantId: "t1", deviceId: "m1" }, REF)).toBeUndefined();
});

test("readEnabled drops a bad app ref or name", () => {
  const ref = "app_AAAAAAAAAAAAAAAAAAAAAA";
  const tools = [{ name: "echo" }];
  expect(
    readEnabled({ app: { ref, name: " 笔记 ", command: "C:\\x.exe" }, tools }),
  ).toEqual({ app: { ref, name: "笔记" }, tools });
  for (const bad of [
    { app: { ref: "app_short", name: "笔记" }, tools },
    { app: { ref: REF, name: "笔记" }, tools },
    { app: { ref, name: "" }, tools },
    { app: { ref, name: "  " }, tools },
    { app: { ref, name: "长".repeat(41) }, tools },
    { app: { ref, name: 5 }, tools },
    { app: { ref, name: "笔记" }, tools: "not a list" },
    { app: { ref, name: "笔记" } },
    { app: "笔记", tools },
    { queued: true, key: "parked" },
    null,
    "x",
    [],
  ])
    expect(readEnabled(bad)).toBeUndefined();
});
