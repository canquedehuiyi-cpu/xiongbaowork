import { describe, expect, test } from "bun:test";
import {
  type FileProbe,
  verifyWorkspaceFiles,
} from "../src/tasks/file-evidence";

const base = { tenantId: "t", agentId: "a" };

describe("verifyWorkspaceFiles", () => {
  test("missing vs empty; device seat unverified", async () => {
    const probe: FileProbe = async ({ path }) =>
      path === "a"
        ? { kind: "file", bytes: 5 }
        : path === "z"
          ? { kind: "file", bytes: 0 }
          : "absent";
    expect(
      (await verifyWorkspaceFiles({ ...base, paths: ["a", "z", "n"], probe }))
        .failures,
    ).toEqual([
      { path: "z", reason: "empty" },
      { path: "n", reason: "missing" },
    ]);
    expect(
      (
        await verifyWorkspaceFiles({
          ...base,
          paths: ["a"],
          probe: async () => null,
        })
      ).unverified,
    ).toEqual(["a"]);
  });

  test("a folder counts as existing even with size zero", async () => {
    const result = await verifyWorkspaceFiles({
      ...base,
      paths: ["site"],
      probe: async () => ({ kind: "folder", bytes: 0 }),
    });
    expect(result).toEqual({ failures: [], unverified: [] });
  });

  test("a probe that throws leaves the path unverified, not failed", async () => {
    const result = await verifyWorkspaceFiles({
      ...base,
      paths: ["a"],
      probe: async () => {
        throw new Error("computer asleep");
      },
    });
    expect(result).toEqual({ failures: [], unverified: ["a"] });
  });

  test("probes at most four at a time", async () => {
    let running = 0;
    let peak = 0;
    const probe: FileProbe = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { kind: "file", bytes: 1 };
    };
    const paths = Array.from({ length: 12 }, (_, index) => `f${index}`);
    await verifyWorkspaceFiles({ ...base, paths, probe });
    expect(peak).toBe(4);
  });
});
