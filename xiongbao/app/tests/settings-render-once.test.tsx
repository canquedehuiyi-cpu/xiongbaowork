import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup } from "@testing-library/react";
import { SETTING_KEYS } from "@/lib/settings/setting-keys";
import { queryClient } from "@/query-client";
import {
  AUDIENCES,
  keyVisibleFor,
  OfflineWebSocket,
  renderAt,
  settingKeysIn,
} from "./settings-audience-kit";
import { settleReactWork } from "./settle-react-work";

/*
 * 每个设置只渲染一处（spec §10.3）：每种受众下渲染所有话题页和子页，收集 `data-setting-key`，
 * 每个该看见的键恰好出现一次。后续 PR 往 PAGES 里加自己的话题页和子页、往 SETTING_KEYS 里加键。
 */
const PAGES: readonly string[] = ["/settings"];

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

const TEST_MS = 60000;

test("settingKeysIn 收集带键的控制，重复的算两次，不带键的行不算", () => {
  const root = document.createElement("div");
  root.innerHTML =
    '<input data-setting-key="a.b"><p data-setting-key="a.b"></p><span>只读行</span><i data-setting-key="c"></i>';
  expect(settingKeysIn(root).sort()).toEqual(["a.b", "a.b", "c"]);
});

test("SETTING_KEYS 没有重复，也没有空键", () => {
  expect(new Set(SETTING_KEYS).size).toBe(SETTING_KEYS.length);
  expect(
    SETTING_KEYS.every((key) => /^[a-z][A-Za-z]*(\.[A-Za-z0-9-]+)+$/.test(key)),
  ).toBe(true);
});

test("keyVisibleFor：企业设置、能力开关、团队审批只有团队版管理员看得到", () => {
  for (const key of ["enterprise.x", "capability.y", "approvals.team.z"]) {
    expect(keyVisibleFor(key, "team-admin")).toBe(true);
    expect(keyVisibleFor(key, "unknown-edition")).toBe(true);
    expect(keyVisibleFor(key, "team-member")).toBe(false);
    expect(keyVisibleFor(key, "team-member-local")).toBe(false);
    expect(keyVisibleFor(key, "personal")).toBe(false);
  }
  expect(keyVisibleFor("account.name", "personal")).toBe(true);
  expect(keyVisibleFor("approvals.autoReview", "team-member")).toBe(true);
});

for (const audience of AUDIENCES) {
  test(
    `${audience}：每个设置键在全部话题页里恰好出现一次`,
    async () => {
      const seen: string[] = [];
      for (const page of PAGES) {
        seen.push(...settingKeysIn((await renderAt(page, audience)).container));
        cleanup();
      }
      const visible = SETTING_KEYS.filter((key) =>
        keyVisibleFor(key, audience),
      );
      expect(seen.sort()).toEqual([...visible].sort());
    },
    TEST_MS,
  );
}
