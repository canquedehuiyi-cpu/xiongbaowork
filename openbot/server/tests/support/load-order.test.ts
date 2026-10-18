import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { testDatabaseUrl } from "./database";

test("local threads register and pass every test after an earlier pool removes DATABASE_URL", async () => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "test",
      "--preload",
      "./tests/support/clear-database-url.ts",
      "./tests/local-threads.test.ts",
    ],
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl(),
      TEST_DATABASE_URL: testDatabaseUrl(),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const log = stdout + stderr;
  expect({ exitCode, log }).toEqual({ exitCode: 0, log: expect.any(String) });
  expect(log).toMatch(/^\s*5 pass\s*$/m);
  expect(log).toMatch(/^\s*0 fail\s*$/m);
  expect(log).toMatch(/^Ran 5 tests across 1 file\./m);
  expect(log).not.toContain("Unhandled error between tests");
}, 15_000);

test("integration suites obtain database URLs only through the shared test helper", async () => {
  const testRoot = join(import.meta.dir, "..");
  // These tests deliberately exercise the environment deletion itself, rather than selecting a DB.
  const addressTests = new Set([
    "db-client-address.test.ts",
    "test-database-url.integration.test.ts",
  ]);
  const files = readdirSync(testRoot, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".test.ts") && !addressTests.has(file));
  const sources = await Promise.all(
    files.map((file) => readFile(join(testRoot, file), "utf8")),
  );
  const offenders = files.filter((_, index) =>
    /process\.env\.(?:DATABASE_URL|TEST_DATABASE_URL)\b/.test(sources[index]),
  );
  expect(offenders).toEqual([]);
}, 20_000);
