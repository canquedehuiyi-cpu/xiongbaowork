import { describe, expect, test } from "bun:test";
import {
  checkServerReadiness,
  createRoleWriterLifecycle,
  createStartupLifecycle,
  type ReadinessDiagnostic,
} from "../src/auth/role-writer-lifecycle";

function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const ordinary = [{ role: "openbot_app", super: false, bypass: false }];

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
