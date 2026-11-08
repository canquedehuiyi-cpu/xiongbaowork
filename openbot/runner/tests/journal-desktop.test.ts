import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActionJournal } from "../src/journal";

/*
 * The action journal exists to answer a replayed action id. A desktop screenshot is the one thing in
 * it that is large and sensitive and never needed again, so it is not kept: the live answer carries
 * the image, the stored one does not.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function snapshotOutcome() {
  return {
    ok: true as const,
    output: {
      snapshotId: "abc123-1",
      window: { windowId: "w1-2", title: "t", process: "p" },
      elements: [{ ref: "abc123-1:0", type: "Document", name: "x", depth: 0 }],
      image: { base64: "QUJDREVG", width: 2, height: 2 },
    },
  };
}

function open() {
  const dir = mkdtempSync(join(tmpdir(), "journal-desktop-"));
  dirs.push(dir);
  const file = join(dir, "actions.sqlite");
  return { file, journal: createActionJournal(file) };
}

function stored(file: string): string[] {
  const database = new Database(file, { readonly: true });
  try {
    return database
      .query<{ outcome: string }, []>("SELECT outcome FROM actions")
      .all()
      .map((row) => row.outcome);
  } finally {
    database.close();
  }
}

test("a desktop result is journaled without its image bytes, but the live answer keeps them", async () => {
  const { file, journal } = open();
  const live = await journal.execute(
    "scope",
    "k1",
    { action: "desktop.snapshot", payload: { windowId: "w1-2" } },
    async () => snapshotOutcome(),
  );
  expect(JSON.stringify(live)).toContain("QUJDREVG");
  const rows = stored(file);
  expect(rows).toHaveLength(1);
  expect(rows[0]).not.toContain("QUJDREVG");
  expect(rows[0]).not.toContain("base64");
  const kept = JSON.parse(rows[0] ?? "{}");
  expect(kept.output.snapshotId).toBe("abc123-1");
  expect(kept.output.elements).toHaveLength(1);
  expect(kept.output.image).toEqual({ width: 2, height: 2 });
  journal.close();
});

test("other actions keep their results as they were", async () => {
  const { file, journal } = open();
  await journal.execute(
    "scope",
    "k2",
    { action: "files.read", payload: { path: "a" } },
    async () => ({ ok: true, output: { image: { base64: "KEEP" } } }),
  );
  expect(stored(file)[0]).toContain("KEEP");
  journal.close();
});
