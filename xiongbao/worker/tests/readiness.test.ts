import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  checkRlsReadiness,
  type ReadinessDiagnostic,
} from "../../server/src/auth/role-writer-lifecycle";

/**
 * The worker runs the server's tenant-isolation preflight before its first tick (audit #633 C1).
 *
 * Two halves. The gate itself, over a database that answers what PostgreSQL would: the same facts and
 * the same RLS_ENFORCE/NODE_ENV rule the server reads. And the entry point, started as the
 * compose file and `scripts/start.sh` start it, against a database that cannot be reached: the role
 * facts are then unknown, so the worker must stop before the loop under `refuse`, and say so, and
 * carry on to its first tick only when `warn` was written down. No database is needed for either.
 */

const facts = (role: string, superuser: boolean, bypass: boolean) => [
  { role, super: superuser, bypass },
];

function database(rows: unknown) {
  const queries: unknown[] = [];
  return {
    queries,
    database: {
      async execute(query: unknown) {
        queries.push(query);
        if (rows instanceof Error) throw rows;
        return rows;
      },
    },
  };
}

describe("the worker's readiness gate", () => {
  test("the application role passes under refuse, having asked the database once", async () => {
    const diagnostics: ReadinessDiagnostic[] = [];
    const { database: db, queries } = database(
      facts("openbot_app", false, false),
    );
    await checkRlsReadiness({
      database: db,
      environment: { NODE_ENV: "production" },
      report: (event) => diagnostics.push(event),
    });
    expect(queries).toHaveLength(1);
    expect(diagnostics).toEqual([]);
  });

  test.each([
    ["a superuser", facts("openbot", true, false), "openbot is a superuser"],
    [
      "a BYPASSRLS role",
      facts("fixture", false, true),
      "fixture holds BYPASSRLS",
    ],
  ])("%s is refused when nothing says warn", async (_name, rows, because) => {
    const diagnostics: ReadinessDiagnostic[] = [];
    await expect(
      checkRlsReadiness({
        database: database(rows).database,
        environment: { NODE_ENV: "production" },
        report: (event) => diagnostics.push(event),
      }),
    ).rejects.toThrow("Tenant isolation preflight refused startup.");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ type: "rls-not-enforced" });
    expect(JSON.stringify(diagnostics[0])).toContain(because);
  });

  test("an unset NODE_ENV refuses too, as the server's does", async () => {
    await expect(
      checkRlsReadiness({
        database: database(facts("openbot", true, false)).database,
        environment: {},
        report: () => {},
      }),
    ).rejects.toThrow("Tenant isolation preflight refused startup.");
  });

  test("a written-down warn reports the superuser and lets the worker run", async () => {
    const diagnostics: ReadinessDiagnostic[] = [];
    await checkRlsReadiness({
      database: database(facts("openbot", true, false)).database,
      environment: { NODE_ENV: "production", XIONGBAO_RLS_ENFORCE: "warn" },
      report: (event) => diagnostics.push(event),
    });
    expect(diagnostics.map((event) => event.type)).toEqual([
      "rls-not-enforced",
    ]);
  });

  test("facts that cannot be read are unconfirmed, and refused", async () => {
    const diagnostics: ReadinessDiagnostic[] = [];
    await expect(
      checkRlsReadiness({
        database: database(new Error("connection refused")).database,
        environment: { NODE_ENV: "production" },
        report: (event) => diagnostics.push(event),
      }),
    ).rejects.toThrow("Tenant isolation preflight is unconfirmed.");
    expect(diagnostics.map((event) => event.type)).toEqual([
      "rls-role-check-unavailable",
    ]);
  });

  test("a mode that is neither word stops the worker before it asks anything", async () => {
    const { database: db, queries } = database(
      facts("openbot_app", false, false),
    );
    await expect(
      checkRlsReadiness({
        database: db,
        environment: { XIONGBAO_RLS_ENFORCE: "off" },
        report: () => {},
      }),
    ).rejects.toThrow('must be "refuse" or "warn"');
    expect(queries).toEqual([]);
  });
});

const ROOT = join(import.meta.dir, "..", "..");

/** The worker's entry point, as compose and `scripts/start.sh` run it, with only what is given here. */
function startWorker(environment: Record<string, string>) {
  return Bun.spawn(["bun", "worker/src/index.ts"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      // Port 1 answers nothing, so the role facts cannot be read.
      DATABASE_URL: "postgres://unit:unit@127.0.0.1:1/unreachable",
      SERVER_INTERNAL_URL: "http://127.0.0.1:1",
      WORKER_SHARED_SECRET: "unit-worker-secret",
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("the worker's entry point", () => {
  test("stops before its first tick when the role facts are unconfirmed", async () => {
    const worker = startWorker({ NODE_ENV: "production" });
    const exitCode = await worker.exited;
    const stdout = await new Response(worker.stdout).text();
    const stderr = await new Response(worker.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain(
      '{"type":"rls-role-check-unavailable"',
    );
    expect(stderr).toContain("Tenant isolation preflight is unconfirmed.");
    expect(`${stdout}${stderr}`).not.toContain("routine-sweep");
  }, 20_000);

  test("goes on to its first tick only after the gate, when warn is written down", async () => {
    // The current spelling; the worker's first import copies it onto the name the gate reads.
    const worker = startWorker({
      NODE_ENV: "production",
      XIONGBAO_RLS_ENFORCE: "warn",
    });
    let output = "";
    const decoder = new TextDecoder();
    const read = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) output += decoder.decode(chunk);
    };
    const reading = Promise.all([read(worker.stdout), read(worker.stderr)]);
    const deadline = Date.now() + 15_000;
    while (!output.includes("routine-sweep-tick-failed")) {
      if (Date.now() > deadline) break;
      await Bun.sleep(50);
    }
    worker.kill();
    await worker.exited;
    await reading;
    const gate = output.indexOf('{"type":"rls-role-check-unavailable"');
    const tick = output.indexOf("routine-sweep-tick-failed");
    expect(gate).toBeGreaterThan(-1);
    expect(tick).toBeGreaterThan(gate);
  }, 20_000);
});
