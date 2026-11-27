import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  checkDatabaseCredential,
  checkServerReadiness,
  createRoleWriterLifecycle,
  createStartupLifecycle,
  type ReadinessDiagnostic,
  resolveRlsEnforcementMode,
  usesPublicDefaultDatabasePassword,
} from "../src/auth/role-writer-lifecycle";

function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const ordinary = [{ role: "xiongbao_app", super: false, bypass: false }];

function fixture(
  options: {
    read?: () => Promise<unknown>;
    mode?: string;
    drain?: () => Promise<void>;
    writerClose?: () => Promise<void>;
    databaseClose?: () => Promise<void>;
    producerClose?: () => Promise<void>;
    initialize?: () => Promise<void>;
  } = {},
) {
  const events: string[] = [];
  const diagnostics: ReadinessDiagnostic[] = [];
  const application = { kind: "application" };
  const restricted = { kind: "restricted" };
  const writer = createRoleWriterLifecycle({
    application,
    url: "unit-only-restricted://not-a-real-connection",
    create: () => {
      events.push("writer-create");
      return restricted;
    },
    initialize: async () => {
      await options.initialize?.();
      events.push("writer-ready");
    },
    stop: async () => {
      events.push("writer-seal");
      await options.drain?.();
      events.push("writer-drained");
    },
    close: async () => {
      events.push("writer-close");
      await options.writerClose?.();
    },
  });
  const lifecycle = createStartupLifecycle({ seal: () => writer.stop() });
  lifecycle.final(async () => {
    events.push("database-close");
    await options.databaseClose?.();
  });
  const start = () =>
    lifecycle.run(async (startup) => {
      await startup.step(() => writer.start());
      await startup.step(() =>
        checkServerReadiness({
          read: async () => {
            events.push("readiness-read");
            return options.read ? options.read() : ordinary;
          },
          mode: options.mode ?? "refuse",
          report: (event) => {
            diagnostics.push(event);
          },
        }),
      );
      events.push("consumer");
      startup.acquireSync(
        () => {
          events.push("producer");
          return {};
        },
        async () => {
          events.push("producer-close");
          await options.producerClose?.();
        },
      );
      startup.acquireSync(
        () => {
          events.push("serve");
          return {};
        },
        () => {
          events.push("serve-close");
        },
      );
    });
  return { events, diagnostics, start, lifecycle };
}

function noConsumers(events: string[]) {
  expect(events).not.toContain("consumer");
  expect(events).not.toContain("producer");
  expect(events).not.toContain("serve");
}

describe("real readiness gate before startup admission (injected CPU read)", () => {
  test("passing actual role facts precedes one consumer/producer/server construction", async () => {
    const { events, diagnostics, start, lifecycle } = fixture();
    await start();
    expect(events.slice(0, 6)).toEqual([
      "writer-create",
      "writer-ready",
      "readiness-read",
      "consumer",
      "producer",
      "serve",
    ]);
    expect(diagnostics).toEqual([]);
    await expect(start()).rejects.toThrow("sealed");
    const stopping = lifecycle.stop();
    expect(lifecycle.stop()).toBe(stopping);
    await stopping;
    expect(events.filter((event) => event === "serve")).toHaveLength(1);
    expect(events.filter((event) => event === "writer-close")).toHaveLength(1);
    expect(events.at(-1)).toBe("database-close");
  });

  test.each([
    {
      name: "superuser",
      rows: [{ role: "owner", super: true, bypass: false }],
    },
    {
      name: "BYPASSRLS",
      rows: [{ role: "owner", super: false, bypass: true }],
    },
  ])(
    "strict $name refusal constructs no consumers and closes acquired infrastructure",
    async ({ rows }) => {
      const { events, diagnostics, start } = fixture({
        read: async () => rows,
      });
      await expect(start()).rejects.toThrow("lifecycle failed");
      noConsumers(events);
      expect(diagnostics[0]?.type).toBe("rls-not-enforced");
      expect(events.slice(-4)).toEqual([
        "writer-seal",
        "writer-drained",
        "writer-close",
        "database-close",
      ]);
    },
  );

  test.each([
    { name: "no row", rows: [] },
    { name: "NULL super", rows: [{ role: "app", super: null, bypass: false }] },
    {
      name: "NULL bypass",
      rows: [{ role: "app", super: false, bypass: null }],
    },
    { name: "missing flag", rows: [{ role: "app", super: false }] },
    { name: "unknown role", rows: [{ super: false, bypass: false }] },
    { name: "empty role", rows: [{ role: "", super: false, bypass: false }] },
    {
      name: "invalid booleans",
      rows: [{ role: "app", super: "false", bypass: false }],
    },
    { name: "not rows", rows: {} },
  ])(
    "strict unknown $name cannot become a false privilege flag",
    async ({ rows }) => {
      const { events, diagnostics, start } = fixture({
        read: async () => rows,
      });
      await expect(start()).rejects.toThrow("lifecycle failed");
      noConsumers(events);
      expect(diagnostics[0]?.type).toBe("rls-role-check-unavailable");
      expect(events.at(-1)).toBe("database-close");
    },
  );

  test("query rejection is unknown, strict startup refuses, and diagnostics contain no driver secret", async () => {
    const { events, diagnostics, start } = fixture({
      read: async () => {
        throw new Error("unit-secret://database-url");
      },
    });
    const error: unknown = await start().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).not.toContain("unit-secret");
    expect(JSON.stringify(diagnostics)).not.toContain("unit-secret");
    noConsumers(events);
  });

  test("PG textual false values pass without pre-setting a readiness flag", async () => {
    const { start, lifecycle, events } = fixture({
      read: async () => [{ role: "app", super: "f", bypass: "f" }],
    });
    await start();
    expect(events).toContain("serve");
    await lifecycle.stop();
  });

  test.each([
    {
      name: "unsafe",
      read: async () => [{ role: "owner", super: true, bypass: false }],
      type: "rls-not-enforced",
    },
    {
      name: "unknown",
      read: async () => [],
      type: "rls-role-check-unavailable",
    },
  ])(
    "warn mode preserves $name diagnostics and allows one startup",
    async ({ read, type }) => {
      const { start, lifecycle, events, diagnostics } = fixture({
        mode: "warn",
        read,
      });
      await start();
      expect(diagnostics[0]?.type).toBe(type);
      expect(events.filter((event) => event === "serve")).toHaveLength(1);
      await lifecycle.stop();
    },
  );

  test("stop during a held real readiness read prevents construction and awaits the writer drain", async () => {
    const entered = barrier();
    const held = barrier();
    const drain = barrier();
    const { start, lifecycle, events } = fixture({
      read: async () => {
        entered.resolve();
        await held.promise;
        return ordinary;
      },
      drain: () => drain.promise,
    });
    const observed = start().catch((error: unknown) => error);
    await entered.promise;
    noConsumers(events);
    const stopping = lifecycle.stop();
    expect(events.at(-1)).toBe("writer-seal");
    expect(lifecycle.stop()).toBe(stopping);
    held.resolve();
    await Promise.resolve();
    noConsumers(events);
    expect(events).not.toContain("database-close");
    drain.resolve();
    await stopping;
    expect(String(await observed)).toContain("sealed");
    noConsumers(events);
    expect(events.slice(-3)).toEqual([
      "writer-drained",
      "writer-close",
      "database-close",
    ]);
  });

  test("a signal concurrent with a rejected readiness read cannot hide that failure", async () => {
    const entered = barrier();
    const held = barrier();
    const { start, lifecycle, events } = fixture({
      read: async () => {
        entered.resolve();
        await held.promise;
        throw new Error("unit-secret://reject");
      },
    });
    const observed = start().catch((error: unknown) => error);
    await entered.promise;
    const stopped = lifecycle.stop().catch((error: unknown) => error);
    held.resolve();
    expect(await stopped).toBeInstanceOf(AggregateError);
    expect(await observed).toBeInstanceOf(AggregateError);
    noConsumers(events);
    expect(events.at(-1)).toBe("database-close");
  });

  test("all owned cleanup attempts run and failures remain aggregated", async () => {
    const fail = async () => {
      throw new Error("unit-secret://close");
    };
    const { start, lifecycle, events } = fixture({
      drain: fail,
      writerClose: fail,
      databaseClose: fail,
      producerClose: fail,
    });
    await start();
    const error: unknown = await lifecycle
      .stop()
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    if (error instanceof AggregateError) expect(error.errors).toHaveLength(3);
    for (const event of [
      "writer-close",
      "producer-close",
      "serve-close",
      "database-close",
    ])
      expect(events.filter((item) => item === event)).toHaveLength(1);
    expect(String(error)).not.toContain("unit-secret");
  });

  test("failed writer initialization prevents even the readiness query", async () => {
    const { start, events } = fixture({
      initialize: async () => {
        throw new Error("unit-secret://writer");
      },
    });
    await expect(start()).rejects.toThrow("lifecycle failed");
    expect(events).not.toContain("readiness-read");
    noConsumers(events);
    expect(events).toContain("writer-close");
    expect(events.at(-1)).toBe("database-close");
  });
});

/**
 * Audit defect #8: the RLS gate used to default to "warn", so a server misconfigured to connect as a
 * superuser or BYPASSRLS role logged one line and served with row level security doing nothing.
 */
describe("the RLS enforcement mode a deployment runs with", () => {
  test.each([
    { name: "NODE_ENV=production", environment: { NODE_ENV: "production" } },
    {
      name: "NODE_ENV=production with stray whitespace",
      environment: { NODE_ENV: "production " },
    },
    // Unset is what a hand-written server env file looks like, so it is not a development signal.
    { name: "NODE_ENV unset", environment: {} },
    { name: "NODE_ENV=staging", environment: { NODE_ENV: "staging" } },
  ])("defaults to refuse with $name", ({ environment }) => {
    expect(resolveRlsEnforcementMode(environment)).toBe("refuse");
  });

  test.each([
    { name: "development", environment: { NODE_ENV: "development" } },
    { name: "test", environment: { NODE_ENV: "test" } },
  ])("defaults to warn only when NODE_ENV says $name", ({ environment }) => {
    expect(resolveRlsEnforcementMode(environment)).toBe("warn");
  });

  test("an explicit refuse holds in development", () => {
    expect(
      resolveRlsEnforcementMode({
        NODE_ENV: "development",
        XIONGBAO_RLS_ENFORCE: "refuse",
      }),
    ).toBe("refuse");
  });

  test("an explicit warn is the written-down opt-out, honoured as written", () => {
    expect(
      resolveRlsEnforcementMode({
        NODE_ENV: "production",
        XIONGBAO_RLS_ENFORCE: " warn ",
      }),
    ).toBe("warn");
  });

  test.each(["off", "false", "0", "refuze", "warning"])(
    "an unrecognised value %p refuses to start instead of silently warning",
    (value) => {
      expect(() =>
        resolveRlsEnforcementMode({
          NODE_ENV: "development",
          XIONGBAO_RLS_ENFORCE: value,
        }),
      ).toThrow("XIONGBAO_RLS_ENFORCE");
    },
  );

  test("an empty value is the same as unset", () => {
    expect(
      resolveRlsEnforcementMode({
        NODE_ENV: "production",
        XIONGBAO_RLS_ENFORCE: "  ",
      }),
    ).toBe("refuse");
  });

  test("the readiness gate itself refuses when no mode reaches it", async () => {
    const diagnostics: ReadinessDiagnostic[] = [];
    await expect(
      checkServerReadiness({
        read: async () => [{ role: "owner", super: true, bypass: false }],
        mode: undefined,
        report: (event) => diagnostics.push(event),
      }),
    ).rejects.toThrow("refused");
    expect(diagnostics[0]?.type).toBe("rls-not-enforced");
  });
});

/**
 * The baseline migration creates `xiongbao_app` with the password `xiongbao`, printed in this repository,
 * and before v0.2.17 migration 0054 created it with the product's former name as the password. A
 * migration cannot tell whether an operator changed either (PostgreSQL does not hand back passwords), so
 * the server checks the one credential it does hold: its own connection string.
 */
describe("the public default database password", () => {
  const appUrl = (password: string) =>
    `postgres://xiongbao_app:${password}@db.example.com:5432/xiongbao`;

  test.each([
    appUrl("xiongbao"),
    "postgres://xiongbao:xiongbao@db.example.com:5432/xiongbao",
    "postgresql://xiongbao_app:%78iongbao@db.example.com/xiongbao",
    // The default before v0.2.17, percent-encoded as an operator's URL may carry it.
    "postgresql://xiongbao_app:%6Fpenbot@db.example.com/xiongbao",
  ])("is recognised in %p", (url) => {
    expect(usesPublicDefaultDatabasePassword(url)).toBeTrue();
  });

  test.each([
    appUrl("a-real-secret"),
    appUrl("xiongbao2"),
    "postgres://xiongbao_app@db.example.com/xiongbao",
    "not a url",
    undefined,
  ])("is not claimed for %p", (url) => {
    expect(usesPublicDefaultDatabasePassword(url)).toBeFalse();
  });

  test("production refuses to start on it and never echoes the URL", () => {
    const diagnostics: ReadinessDiagnostic[] = [];
    let thrown: unknown;
    try {
      checkDatabaseCredential({
        url: appUrl("xiongbao"),
        production: true,
        report: (event) => diagnostics.push(event),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(diagnostics.map((event) => event.type)).toEqual([
      "database-password-public-default",
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("db.example.com");
    expect(String(thrown)).not.toContain("db.example.com");
  });

  test("development is told and keeps running", () => {
    const diagnostics: ReadinessDiagnostic[] = [];
    checkDatabaseCredential({
      url: appUrl("xiongbao"),
      production: false,
      report: (event) => diagnostics.push(event),
    });
    expect(diagnostics.map((event) => event.type)).toEqual([
      "database-password-public-default",
    ]);
  });

  test("a changed password says nothing", () => {
    const diagnostics: ReadinessDiagnostic[] = [];
    checkDatabaseCredential({
      url: appUrl("a-real-secret"),
      production: true,
      report: (event) => diagnostics.push(event),
    });
    expect(diagnostics).toEqual([]);
  });
});

/*
 * Audit #633 M1: the compose file gives the role writer the same public word by default, so the
 * server holds that URL to the same rule, and says which setting it was.
 */
describe("the public default role writer password", () => {
  const writerUrl =
    "postgres://xiongbao_role_writer:xiongbao@postgres:5432/xiongbao";

  test("production refuses it, naming the role writer's setting", () => {
    const diagnostics: ReadinessDiagnostic[] = [];
    expect(() =>
      checkDatabaseCredential({
        url: writerUrl,
        production: true,
        variable: "ROLE_WRITER_DATABASE_URL",
        report: (event) => diagnostics.push(event),
      }),
    ).toThrow(
      "ROLE_WRITER_DATABASE_URL uses the public default database password; refusing to start in production.",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      type: "database-password-public-default",
      role: "xiongbao_role_writer",
    });
    expect(JSON.stringify(diagnostics)).toContain("ROLE_WRITER_DATABASE_URL");
    expect(JSON.stringify(diagnostics)).not.toContain("postgres:5432");
  });

  test("anywhere else it is reported and the server keeps starting", () => {
    const diagnostics: ReadinessDiagnostic[] = [];
    checkDatabaseCredential({
      url: writerUrl,
      production: false,
      variable: "ROLE_WRITER_DATABASE_URL",
      report: (event) => diagnostics.push(event),
    });
    expect(diagnostics.map((event) => event.type)).toEqual([
      "database-password-public-default",
    ]);
  });
});

/*
 * Audit #633 C1: the CronJob's sweep runs the same gate before it writes. Started as the chart starts
 * it, against a database that cannot be reached, the role facts are unknown: under `refuse` it stops
 * there and never sweeps. No database needed.
 */
describe("the routines CronJob's preflight", () => {
  test("stops before the sweep when the role facts are unconfirmed", async () => {
    const job = Bun.spawn(["bun", "scripts/fire-routines.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "production",
        DATABASE_URL: "postgres://unit:unit@127.0.0.1:1/unreachable",
        KEY_ENCRYPTION_KEY: "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=",
        WORKER_SHARED_SECRET: "unit-worker-secret",
        SERVER_INTERNAL_URL: "http://127.0.0.1:1",
        XIONGBAO_SINGLE_USER: "true",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await job.exited;
    const output = `${await new Response(job.stdout).text()}${await new Response(job.stderr).text()}`;
    expect(exitCode).not.toBe(0);
    expect(output).toContain('{"type":"rls-role-check-unavailable"');
    expect(output).toContain("Tenant isolation preflight is unconfirmed.");
    expect(output).not.toContain("routine-sweep");
  }, 30_000);
});
