import { expect, test } from "bun:test";
import { bundledRuntime, toBundledArgs } from "../src/bundled-runtime";

/*
 * npm-style local apps run through the Bun the device brings with it, so the owner needs neither
 * Node nor Bun installed.
 */

test("npx -y, npx --yes, bunx and bun x rewrite to the package and its args; npx -p x y and node script.js do not", () => {
  expect(toBundledArgs({ command: "npx", args: ["-y", "pkg", "a"] })).toEqual([
    "pkg",
    "a",
  ]);
  expect(toBundledArgs({ command: "npx", args: ["--yes", "pkg"] })).toEqual([
    "pkg",
  ]);
  expect(toBundledArgs({ command: "bunx", args: ["pkg", "--flag"] })).toEqual([
    "pkg",
    "--flag",
  ]);
  expect(toBundledArgs({ command: "bun", args: ["x", "pkg", "b"] })).toEqual([
    "pkg",
    "b",
  ]);
  expect(
    toBundledArgs({ command: "npx", args: ["-p", "x", "y"] }),
  ).toBeUndefined();
  expect(
    toBundledArgs({ command: "bunx", args: ["--bun", "pkg"] }),
  ).toBeUndefined();
  expect(
    toBundledArgs({ command: "bun", args: ["run", "pkg"] }),
  ).toBeUndefined();
  expect(toBundledArgs({ command: "npx", args: [] })).toBeUndefined();
  expect(
    toBundledArgs({ command: "node", args: ["script.js"] }),
  ).toBeUndefined();
});

test("bundledRuntime: the runner itself with BUN_BE_BUN=1", () => {
  expect(
    bundledRuntime({
      execPath: "C:\\Device\\openbot-runner.exe",
      platform: "win32",
      exists: () => false,
    }),
  ).toEqual({
    command: "C:\\Device\\openbot-runner.exe",
    prefix: ["x", "--bun"],
    env: { BUN_BE_BUN: "1" },
  });
});

test("bundledRuntime: the bun beside the runner, and none when it is missing", () => {
  // Hosted by Node rather than a compiled runner or bun: only a bun beside it will do.
  const host = { execPath: "/opt/host/node", platform: "linux" as const };
  expect(
    bundledRuntime({ ...host, exists: (p) => p === "/opt/host/bun" }),
  ).toEqual({ command: "/opt/host/bun", prefix: ["x", "--bun"], env: {} });
  expect(bundledRuntime({ ...host, exists: () => false })).toBeUndefined();
  expect(
    bundledRuntime({
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
      exists: (p) => p === "C:\\Program Files\\nodejs\\bun.exe",
    }),
  ).toEqual({
    command: "C:\\Program Files\\nodejs\\bun.exe",
    prefix: ["x", "--bun"],
    env: {},
  });
});
