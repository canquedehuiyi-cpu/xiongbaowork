import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, renderHook } from "@testing-library/react";
import { useSearchDraft } from "@/lib/use-search-draft";

/*
 * A search box mirrored into the address (`?q=`) but drawn from local state. The router commits a
 * navigation asynchronously, so the address lags the keystrokes; a box controlled by the address
 * alone is reset to the previous value between keystrokes and drops characters. Shared by the
 * workbench pages' search boxes (员工管理, 自主工作, @Waker).
 */

let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(() => {
  if (registeredHere) GlobalRegistrator.unregister();
});

test("keystrokes are kept while the address catches up", () => {
  const { result, rerender } = renderHook(({ url }) => useSearchDraft(url), {
    initialProps: { url: "" },
  });
  act(() => result.current[1]("周"));
  act(() => result.current[1]("周报"));
  // The address commits the first keystroke only now: the draft must not go back to 「周」.
  rerender({ url: "周" });
  expect(result.current[0]).toBe("周报");
  rerender({ url: "周报" });
  expect(result.current[0]).toBe("周报");
});

test("an address changed from elsewhere (Back, 清除筛选) is taken over", () => {
  const { result, rerender } = renderHook(({ url }) => useSearchDraft(url), {
    initialProps: { url: "周报" },
  });
  rerender({ url: "" });
  expect(result.current[0]).toBe("");
  rerender({ url: "发布" });
  expect(result.current[0]).toBe("发布");
});
