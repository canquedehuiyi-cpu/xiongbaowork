/**
 * 「发现的应用」(ui/discover.js), without a window: what each candidate shows, and which shell
 * command a switch calls.
 */
import { expect, test } from "bun:test";
import { describeCandidates, toggleCandidate } from "../ui/discover.js";

const base = { kind: "stdio", enabled: false };
const HINT = "没有发现可用的本机应用。可以在下面「高级：手动添加」里自己添加。";

test("describeCandidates: a needs_uv candidate is greyed out with 需要先安装 uv; an enabled one is on", () => {
  const described = describeCandidates({
    ok: true,
    platform: "win32",
    installed: ["Excel", "Word", "Git"],
    candidates: [
      {
        ...base,
        ref: "cand_1",
        name: "笔记",
        sourceLabel: "Claude Desktop",
        status: "needs_uv",
        note: "需要先安装 uv",
      },
      {
        ...base,
        ref: "cand_2",
        name: "表格",
        sourceLabel: "Cursor",
        status: "ready",
        enabled: true,
        app: "app_AAAAAAAAAAAAAAAAAAAAAA",
      },
    ],
  });
  expect(described.empty).toBeUndefined();
  expect(described.installedCount).toBe(3);
  expect(described.items[0]).toMatchObject({
    ref: "cand_1",
    name: "笔记",
    source: "Claude Desktop",
    on: false,
    disabled: true,
    note: "需要先安装 uv",
  });
  const stale = describeCandidates({
    platform: "win32",
    candidates: [
      { ...base, ref: "c3", name: "旧", sourceLabel: "x", status: "missing_command", enabled: true, app: "app_C" },
    ],
  });
  expect(stale.items[0]).toMatchObject({ on: true, disabled: false });
  expect(described.items[1]).toMatchObject({
    app: "app_AAAAAAAAAAAAAAAAAAAAAA",
    on: true,
    disabled: false,
    note: "",
  });
});

test("toggleCandidate: enabling a new candidate calls enable_candidate; switching a registered one calls set_app_enabled", async () => {
  const calls: [string, unknown][] = [];
  const invoke = async (command: string, args?: unknown) => {
    calls.push([command, args]);
    return command === "enable_candidate"
      ? { ok: true, app: "app_X", tools: ["a"], apps: [] }
      : [];
  };
  const fresh = { ref: "cand_1", app: undefined, name: "笔记" };
  const added = await toggleCandidate(fresh, true, invoke);
  expect(added).toEqual({ message: "已启用，员工可以使用" });
  const registered = { ref: "cand_2", app: "app_B", name: "表格" };
  await toggleCandidate(registered, true, invoke);
  const off = await toggleCandidate(registered, false, invoke);
  expect(off).toEqual({ message: "已停用" });
  expect(calls).toEqual([
    ["enable_candidate", { candidate: "cand_1" }],
    ["set_app_enabled", { target: "app_B", enabled: true }],
    ["set_app_enabled", { target: "app_B", enabled: false }],
  ]);
});

test("toggleCandidate: a refusal comes back as the sentence to show", async () => {
  const result = await toggleCandidate(
    { ref: "cand_1", app: undefined, name: "笔记" },
    true,
    async () => {
      throw "测试没有通过：启动超时";
    },
  );
  expect(result).toEqual({ error: "测试没有通过：启动超时" });
});

test("an empty reply shows the 高级：手动添加 hint", () => {
  expect(
    describeCandidates({ ok: true, platform: "win32", candidates: [] }),
  ).toEqual({ items: [], empty: HINT, installedCount: 0 });
  const ready = {
    ...base,
    ref: "c",
    name: "x",
    sourceLabel: "y",
    status: "ready",
  };
  expect(
    describeCandidates({ platform: "darwin", candidates: [ready] }).empty,
  ).toBe(HINT);
  expect(describeCandidates(undefined).empty).toBe(HINT);
});
