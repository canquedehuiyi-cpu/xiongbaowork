import { expect, test } from "bun:test";
import {
  type AllowEntry,
  entryProblems,
} from "../../scripts/brand/guard/allowlist";

const compat: AllowEntry = {
  file: "a.ts",
  text: "openbot",
  reason: "persisted-identifier: x",
  category: "legacy-compat",
  plan: "remove",
  introducedIn: "0.2.9",
  removeIn: "0.2.11",
};
const text = (e: AllowEntry) => entryProblems(e).join("\n");

test("notBefore needs device: true", () => {
  expect(text({ ...compat, notBefore: "0.3.0" })).toContain("device");
  expect(
    entryProblems({ ...compat, notBefore: "0.3.0", device: true }),
  ).toEqual([]);
});

test("removeIn must come after introducedIn, compared by number", () => {
  expect(text({ ...compat, removeIn: "0.2.9" })).toContain("removeIn");
  expect(text({ ...compat, removeIn: "0.2.8" })).toContain("removeIn");
  expect(
    entryProblems({ ...compat, introducedIn: "0.2.9", removeIn: "0.2.10" }),
  ).toEqual([]);
  expect(
    entryProblems({ ...compat, introducedIn: "0.9.0", removeIn: "0.10.0" }),
  ).toEqual([]);
  expect(
    text({ ...compat, introducedIn: "0.10.0", removeIn: "0.9.0" }),
  ).toContain("removeIn");
});
