import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RELIST_RETRY_MS, startBrokeredRelist } from "../src/plugins/relist";

/**
 * 启动时重新列 broker 应用的那个后台循环（上游 #1185 的 `startBrokeredRelist`）。
 *
 * 不阻塞启动；还有应用落后就按退避的间隔再试；离线或没有出口时不能刷屏：同一个应用只报一次，
 * 整轮抛错也只报一次。
 */

const warnings: string[] = [];
const realWarn = console.warn;

let stop: (() => void) | undefined;

// 只在每个用例里替换，结束就恢复：CI 分片在同一个进程里跑多个文件。
beforeEach(() => {
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  stop?.();
  stop = undefined;
  console.warn = realWarn;
  warnings.length = 0;
});

const until = async (condition: () => boolean) => {
  for (let tries = 0; tries < 200 && !condition(); tries += 1)
    await Bun.sleep(5);
};

describe("relisting broker apps at start", () => {
  test("does not hold up the start: the first attempt runs after the call returns", async () => {
    let attempts = 0;
    stop = startBrokeredRelist({
      relistOutdatedBrokeredApps: async () => {
        attempts += 1;
        return [];
      },
    });
    const right = attempts;
    await until(() => attempts > 0);

    expect(right).toBe(0);
    expect(attempts).toBe(1);
    expect(warnings).toEqual([]);
  });

  test("retries while an app is behind, and stops once none is", async () => {
    const answers = [["gmail"], ["gmail"], []];
    let attempts = 0;
    stop = startBrokeredRelist(
      {
        relistOutdatedBrokeredApps: async () => answers[attempts++] ?? [],
      },
      [1, 1],
    );
    await until(() => attempts >= 3);
    await Bun.sleep(30);

    expect(attempts).toBe(3);
  });

  test("says once about an app that keeps failing, not at every attempt", async () => {
    let attempts = 0;
    stop = startBrokeredRelist(
      {
        relistOutdatedBrokeredApps: async () => {
          attempts += 1;
          return attempts < 3 ? ["gmail"] : ["gmail", "slack"];
        },
      },
      [1],
    );
    await until(() => attempts >= 5);

    expect(warnings.filter((line) => line.includes("gmail"))).toHaveLength(1);
    expect(warnings.filter((line) => line.includes("slack"))).toHaveLength(1);
  });

  test("an attempt that throws is said once and retried", async () => {
    let attempts = 0;
    stop = startBrokeredRelist(
      {
        relistOutdatedBrokeredApps: async () => {
          attempts += 1;
          if (attempts < 4) throw new Error("connection refused");
          return [];
        },
      },
      [1],
    );
    await until(() => attempts >= 4);
    await Bun.sleep(20);

    expect(attempts).toBe(4);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("connection refused");
  });

  test("backs off: each wait is the next in the list, and the last one repeats", async () => {
    const at: number[] = [];
    stop = startBrokeredRelist(
      {
        relistOutdatedBrokeredApps: async () => {
          at.push(performance.now());
          return ["gmail"];
        },
      },
      [5, 40],
    );
    await until(() => at.length >= 4);
    const gaps = at.slice(1).map((time, index) => time - (at[index] ?? 0));

    expect(gaps[0]).toBeLessThan(35);
    expect(gaps[1]).toBeGreaterThanOrEqual(35);
    expect(gaps[2]).toBeGreaterThanOrEqual(35);
  });

  test("stopping cancels the retry that was waiting", async () => {
    let attempts = 0;
    const halt = startBrokeredRelist(
      {
        relistOutdatedBrokeredApps: async () => {
          attempts += 1;
          return ["gmail"];
        },
      },
      [20],
    );
    await until(() => attempts > 0);
    halt();
    await Bun.sleep(60);

    expect(attempts).toBe(1);
  });
});

/**
 * 假时钟：记下每次排的等待时长，由测试一步步推进，不真的等。
 */
function fakeClock() {
  const delays: number[] = [];
  let pending: (() => void) | undefined;
  return {
    delays,
    timers: {
      set: (run: () => void, ms: number) => {
        delays.push(ms);
        pending = run;
        return delays.length;
      },
      clear: () => {
        pending = undefined;
      },
    },
    /** 触发排着的那一次，等它那一轮做完。没有排着的就回答 false。 */
    async tick(): Promise<boolean> {
      const run = pending;
      pending = undefined;
      if (!run) return false;
      run();
      for (let spin = 0; spin < 20; spin += 1) await Promise.resolve();
      return true;
    },
  };
}

describe("giving up only after the longest wait (N1)", () => {
  test("walks every step of the backoff before any failure counts, then gives up after three at the longest", async () => {
    const clock = fakeClock();
    const counted: boolean[] = [];
    let countedFailures = 0;
    stop = startBrokeredRelist(
      {
        // 像 store 那样：只有要求计数的失败才算，算满 3 次就不再报落后。
        relistOutdatedBrokeredApps: async ({ countFailures }) => {
          counted.push(countFailures);
          if (countedFailures >= 3) return [];
          if (countFailures) countedFailures += 1;
          return countedFailures >= 3 ? [] : ["gmail"];
        },
      },
      RELIST_RETRY_MS,
      clock.timers,
    );

    while (await clock.tick()) {}

    const longest = RELIST_RETRY_MS.at(-1);
    if (longest === undefined) throw new Error("RELIST_RETRY_MS is empty");
    // 第一次排在 0（不阻塞启动），之后每一档都走到，最长一档重复到放弃为止。
    expect(clock.delays).toEqual([0, ...RELIST_RETRY_MS, longest, longest]);
    // 等过最长一档之后的尝试才计数，连续 3 次后循环停止。
    expect(counted).toEqual([false, false, false, false, true, true, true]);
  });

  test("an app that catches up before the longest step never counts a failure", async () => {
    const clock = fakeClock();
    const counted: boolean[] = [];
    stop = startBrokeredRelist(
      {
        relistOutdatedBrokeredApps: async ({ countFailures }) => {
          counted.push(countFailures);
          return counted.length < 3 ? ["gmail"] : [];
        },
      },
      RELIST_RETRY_MS,
      clock.timers,
    );

    while (await clock.tick()) {}

    expect(counted).toEqual([false, false, false]);
    expect(clock.delays).toEqual([0, 30_000, 60_000]);
  });
});
