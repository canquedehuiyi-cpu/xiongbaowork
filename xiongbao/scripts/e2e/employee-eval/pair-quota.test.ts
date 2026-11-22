import { expect, test } from "bun:test";
import { isLastRunOfPair, pairEmployees } from "./pair-quota";

const run = (key: string, pairKey?: string) => ({ key, pairKey });

test("the last run of a pair is the control when there is one, else the second", () => {
  const works = [
    run("a-p1-first", "a-p1"),
    run("a-p1-second", "a-p1"),
    run("a-p1-control", "a-p1"),
    run("a-p2-first", "a-p2"),
    run("a-p2-second", "a-p2"),
  ];
  expect(works.map((_, at) => isLastRunOfPair(works, at))).toEqual([
    false,
    false,
    true,
    false,
    true,
  ]);
});

test("a plain task is never the end of a pair", () => {
  const works = [run("office"), run("a-first", "a"), run("a-second", "a")];
  expect(works.map((_, at) => isLastRunOfPair(works, at))).toEqual([
    false,
    false,
    true,
  ]);
  expect(isLastRunOfPair(works, 9)).toBe(false);
});

test("only the employees that were actually created are released, and only this pair's", () => {
  const agents = new Map([
    ["a-p1", "agent-1"],
    ["a-p1-control", "agent-1c"],
    ["a-p2", "agent-2"],
    ["a-p12", "agent-12"],
  ]);
  expect(pairEmployees("a-p1", agents)).toEqual([
    { group: "a-p1", agentId: "agent-1" },
    { group: "a-p1-control", agentId: "agent-1c" },
  ]);
  expect(pairEmployees("a-p2", agents)).toEqual([
    { group: "a-p2", agentId: "agent-2" },
  ]);
  expect(pairEmployees("a-p3", agents)).toEqual([]);
});
