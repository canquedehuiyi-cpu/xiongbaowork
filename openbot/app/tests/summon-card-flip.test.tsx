import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  jest,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  SUMMON_MIN_CHARGE_MS,
  SUMMON_REVEAL_MS,
  SummonCardFlip,
} from "@/components/summon/summon-card-flip";
import { settleReactWork } from "./settle-react-work";

/*
 * Summoning an employee plays a gacha-style card flip: the card back charges while the summon is in
 * flight, flips to the employee's portrait once it lands, and hands over about two seconds later.
 * The result gates the reveal: 「召唤成功」 is never shown for a summon that failed.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const employee = {
  name: "小熊会计",
  title: "财务专员",
  portrait: "/assets/accountant.png",
};

function summon(result: Promise<unknown>) {
  const onDone = mock(() => {});
  const onFail = mock((_error: unknown) => {});
  const view = render(
    <SummonCardFlip
      {...employee}
      onDone={onDone}
      onFail={onFail}
      result={result}
    />,
  );
  return { view, onDone, onFail };
}

/** Lets a settled promise's handlers run and React commit what they set. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function withReducedMotion(reduced: boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((media: string) =>
    ({
      matches: reduced && media === "(prefers-reduced-motion: reduce)",
      media,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

test("while the summon is in flight the card charges and says nothing of success", async () => {
  jest.useFakeTimers();
  const { promise } = Promise.withResolvers<unknown>();
  const { view, onDone, onFail } = summon(promise);

  const dialog = view.getByRole("dialog");
  expect(dialog.dataset.phase).toBe("charging");
  expect(view.getByRole("status").textContent).toContain("小熊会计");
  expect(view.queryByText("召唤成功")).toBeNull();

  await advance(10_000);
  expect(view.queryByText("召唤成功")).toBeNull();
  expect(onDone).not.toHaveBeenCalled();
  expect(onFail).not.toHaveBeenCalled();
});

test("once it lands the card flips to the employee, says 召唤成功, and hands over about 2s later, once", async () => {
  jest.useFakeTimers();
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const { view, onDone } = summon(promise);

  // The card charges for a moment even if the summon came back instantly.
  await advance(SUMMON_MIN_CHARGE_MS);
  resolve({ id: "bot-1" });
  await flush();

  expect(view.getByRole("dialog").dataset.phase).toBe("reveal");
  expect(view.getByRole("status").textContent).toBe("召唤成功");
  expect(view.getByRole("img", { name: "小熊会计" }).getAttribute("src")).toBe(
    "/assets/accountant.png",
  );
  view.getByText("财务专员");
  expect(onDone).not.toHaveBeenCalled();

  expect(SUMMON_REVEAL_MS).toBeGreaterThanOrEqual(1500);
  expect(SUMMON_REVEAL_MS).toBeLessThanOrEqual(2500);
  await advance(SUMMON_REVEAL_MS - 1);
  expect(onDone).not.toHaveBeenCalled();
  await advance(1);
  expect(onDone).toHaveBeenCalledTimes(1);

  await advance(10_000);
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("a summon that lands instantly still charges briefly before the flip", async () => {
  jest.useFakeTimers();
  const { view, onDone } = summon(Promise.resolve({ id: "bot-1" }));
  await flush();
  expect(view.getByRole("dialog").dataset.phase).toBe("charging");
  expect(view.queryByText("召唤成功")).toBeNull();

  await advance(SUMMON_MIN_CHARGE_MS);
  expect(view.getByRole("dialog").dataset.phase).toBe("reveal");
  view.getByText("召唤成功");

  await advance(SUMMON_REVEAL_MS);
  expect(onDone).toHaveBeenCalledTimes(1);
  // Under three seconds from start to hand-over.
  expect(SUMMON_MIN_CHARGE_MS + SUMMON_REVEAL_MS).toBeLessThanOrEqual(3000);
});

test("a failed summon never reveals or says 召唤成功; onFail gets the error and onDone is never called", async () => {
  jest.useFakeTimers();
  const { promise, reject } = Promise.withResolvers<unknown>();
  const { view, onDone, onFail } = summon(promise);
  const error = new Error("名额已满");

  await advance(SUMMON_MIN_CHARGE_MS);
  reject(error);
  await flush();

  expect(onFail).toHaveBeenCalledTimes(1);
  expect(onFail.mock.calls[0]?.[0]).toBe(error);
  expect(view.queryByText("召唤成功")).toBeNull();

  await advance(10_000);
  expect(view.queryByText("召唤成功")).toBeNull();
  expect(onDone).not.toHaveBeenCalled();
  expect(onFail).toHaveBeenCalledTimes(1);
});

test("a click after it lands hands over at once, and only once", async () => {
  jest.useFakeTimers();
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const { view, onDone } = summon(promise);

  await advance(SUMMON_MIN_CHARGE_MS);
  resolve(undefined);
  await flush();
  fireEvent.click(view.getByRole("dialog"));
  expect(onDone).toHaveBeenCalledTimes(1);

  await advance(10_000);
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("a click during the instant-result charge hands over at once", async () => {
  jest.useFakeTimers();
  const { view, onDone } = summon(Promise.resolve("ok"));
  await flush();
  fireEvent.click(view.getByRole("dialog"));
  expect(onDone).toHaveBeenCalledTimes(1);
  await advance(10_000);
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("a click before it lands only skips the effects; it hands over the moment the summon lands", async () => {
  jest.useFakeTimers();
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const { view, onDone } = summon(promise);

  fireEvent.click(view.getByRole("dialog"));
  expect(onDone).not.toHaveBeenCalled();
  expect(view.getByRole("dialog").dataset.motion).toBe("skipped");

  resolve("ok");
  await flush();
  expect(onDone).toHaveBeenCalledTimes(1);
  await advance(10_000);
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("a skipped summon that fails still reports the failure, not success", async () => {
  jest.useFakeTimers();
  const { promise, reject } = Promise.withResolvers<unknown>();
  const { view, onDone, onFail } = summon(promise);
  fireEvent.click(view.getByRole("dialog"));
  reject(new Error("x"));
  await flush();
  expect(onFail).toHaveBeenCalledTimes(1);
  expect(onDone).not.toHaveBeenCalled();
  expect(view.queryByText("召唤成功")).toBeNull();
});

test("Escape or Enter skips the same way a click does", async () => {
  jest.useFakeTimers();
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const { view, onDone } = summon(promise);
  await advance(SUMMON_MIN_CHARGE_MS);
  resolve("ok");
  await flush();
  fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("with reduced motion it shows the result card without animating and hands over as soon as it lands", async () => {
  const restore = withReducedMotion(true);
  try {
    jest.useFakeTimers();
    const { promise, resolve } = Promise.withResolvers<unknown>();
    const { view, onDone } = summon(promise);

    const dialog = view.getByRole("dialog");
    expect(dialog.dataset.motion).toBe("reduced");
    // The result card is up from the start: no card back to flip.
    view.getByRole("img", { name: "小熊会计" });
    view.getByText("财务专员");
    expect(view.queryByText("召唤成功")).toBeNull();

    resolve("ok");
    await flush();
    view.getByText("召唤成功");
    expect(onDone).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(onDone).toHaveBeenCalledTimes(1);
  } finally {
    restore();
  }
});

test("the overlay is a labelled modal dialog whose status line is announced", () => {
  const { view } = summon(new Promise(() => {}));
  const dialog = view.getByRole("dialog");
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.getAttribute("aria-label")).toBe("召唤员工");
  expect(view.getByRole("status").getAttribute("aria-live")).toBe("polite");
});

test("a click on the overlay does not reach whatever summoned it", async () => {
  const outer = mock(() => {});
  const onDone = mock(() => {});
  const view = render(
    // biome-ignore lint/a11y/noStaticElementInteractions: 只为接住冒泡上来的点击。
    // biome-ignore lint/a11y/useKeyWithClickEvents: 同上。
    <div onClick={outer}>
      <SummonCardFlip
        {...employee}
        onDone={onDone}
        onFail={() => {}}
        result={Promise.resolve("ok")}
      />
    </div>,
  );
  await flush();
  fireEvent.click(view.getByRole("dialog"));
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(outer).not.toHaveBeenCalled();
});

test("the card back carries the 熊宝 logo", () => {
  const { view } = summon(new Promise(() => {}));
  const back = view.baseElement.querySelector("[data-face='back'] img");
  expect(back?.getAttribute("src")).toContain("xiongbao-logo-256");
});
