import { describe, expect, test } from "bun:test";
import { mergeDeliverables } from "../src/tasks/delivery";

describe("mergeDeliverables: unverifiedFiles", () => {
  test("a later hand-in that checked the path takes it off the unverified list", () => {
    const merged = mergeDeliverables(
      {
        kind: "deliverable",
        workspaceFiles: ["a.md", "b.md"],
        unverifiedFiles: ["a.md", "b.md"],
      },
      { kind: "deliverable", workspaceFiles: ["a.md"] },
    );
    expect(merged.workspaceFiles).toEqual(["a.md", "b.md"]);
    expect(merged.unverifiedFiles).toEqual(["b.md"]);
  });

  test("a path the later hand-in could not check stays unverified", () => {
    const merged = mergeDeliverables(
      { kind: "deliverable", workspaceFiles: ["a.md"] },
      {
        kind: "deliverable",
        workspaceFiles: ["a.md"],
        unverifiedFiles: ["a.md"],
      },
    );
    expect(merged.unverifiedFiles).toEqual(["a.md"]);
  });

  test("every unverified path is still one of the workspace files", () => {
    const merged = mergeDeliverables(
      {
        kind: "deliverable",
        workspaceFiles: ["a.md"],
        unverifiedFiles: ["a.md", "ghost.md"],
      },
      {
        kind: "deliverable",
        workspaceFiles: ["c.md"],
        unverifiedFiles: ["c.md"],
      },
    );
    expect(merged.workspaceFiles).toEqual(["a.md", "c.md"]);
    expect(merged.unverifiedFiles).toEqual(["a.md", "c.md"]);
    for (const path of merged.unverifiedFiles ?? [])
      expect(merged.workspaceFiles).toContain(path);
  });

  test("nothing unverified leaves the field off", () => {
    const merged = mergeDeliverables(undefined, {
      kind: "deliverable",
      workspaceFiles: ["a.md"],
    });
    expect(merged.unverifiedFiles).toBeUndefined();
  });
});
