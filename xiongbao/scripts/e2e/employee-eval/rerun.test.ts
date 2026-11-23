import { expect, test } from "bun:test";
import type { EvalRecord } from "./records";
import { withRerun } from "./rerun";

const record = (passed: boolean, error?: string): EvalRecord =>
  ({
    task: "deliv-web",
    title: "交付：静态网页",
    passed,
    checks: [],
    ...(error ? { error } : {}),
  }) as EvalRecord;

const run = (
  first: EvalRecord,
  over: {
    enabled?: boolean;
    fits?: boolean;
    rerun?: () => Promise<EvalRecord>;
  } = {},
) => {
  const notes: string[] = [];
  let calls = 0;
  return {
    notes,
    calls: () => calls,
    result: withRerun(first, {
      enabled: over.enabled ?? true,
      fits: () => over.fits ?? true,
      rerun: () => {
        calls++;
        return (over.rerun ?? (async () => record(true)))();
      },
      note: (line) => notes.push(line),
    }),
  };
};

test("a passing first run is kept and not rerun", async () => {
  const x = run(record(true));
  expect(await x.result).toMatchObject({ passed: true, reruns: 0 });
  expect(x.calls()).toBe(0);
});

test("a failing first run is replaced by a passing rerun", async () => {
  const x = run(record(false));
  expect(await x.result).toMatchObject({ passed: true, reruns: 1 });
  expect(x.calls()).toBe(1);
});

test("a rerun that still fails is a failure with reruns 1", async () => {
  const x = run(record(false), { rerun: async () => record(false) });
  expect(await x.result).toMatchObject({ passed: false, reruns: 1 });
});

test("a rerun that throws keeps the first record and notes why", async () => {
  const x = run(record(false, "first"), {
    rerun: async () => {
      throw new Error("员工名额不够");
    },
  });
  expect(await x.result).toMatchObject({
    passed: false,
    error: "first",
    reruns: 0,
  });
  expect(x.notes).toEqual([
    "deliv-web 首次没过：first",
    "deliv-web 重跑没做：员工名额不够",
  ]);
});

test("no rerun when it is off or the deadline is too close", async () => {
  const off = run(record(false), { enabled: false });
  expect(await off.result).toMatchObject({ reruns: 0 });
  expect(off.calls()).toBe(0);
  const late = run(record(false), { fits: false });
  expect(await late.result).toMatchObject({ passed: false, reruns: 0 });
  expect(late.calls()).toBe(0);
  expect(late.notes).toHaveLength(1);
});
