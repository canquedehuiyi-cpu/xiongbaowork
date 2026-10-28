import { describe, expect, test } from "bun:test";
import {
  createRoleWriterLifecycle,
  createStartupLifecycle,
} from "../src/auth/role-writer-lifecycle";
import { loadConfig } from "../src/config";

function barrier() {
  let resolve = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("whole startup coordination (injected CPU only)", () => {
  test("stop during a later startup await prevents consumers/serve and joins writer before the final connection", async () => {
    const entered = barrier();
    const held = barrier();
    const writerDrain = barrier();
    const resourceClosed = barrier();
    const writer = fixture({ drain: () => writerDrain.promise });
    const events: string[] = [];
    let consumers = 0;
    let serves = 0;
    const lifecycle = createStartupLifecycle({
      seal: () => writer.lifecycle.stop(),
    });
    lifecycle.final(() => {
      events.push("database-close");
    });
    const starting = lifecycle.run(async (startup) => {
      await startup.step(() => writer.lifecycle.start());
      startup.acquireSync(
        () => ({}),
        () => {
          events.push("producer-close");
          resourceClosed.resolve();
        },
      );
      entered.resolve();
      await startup.step(() => held.promise);
      consumers += 1;
      startup.acquireSync(
        () => {
          serves += 1;
          return {};
        },
        () => {},
      );
    });
    const observed = starting.catch((error: unknown) => error);
    await entered.promise;
    const stopping = lifecycle.stop();
    expect(writer.isSealed()).toBe(true);
    expect(lifecycle.stop()).toBe(stopping);
    held.resolve();
    await resourceClosed.promise;
    expect(consumers).toBe(0);
    expect(serves).toBe(0);
    expect(events).not.toContain("database-close");
    expect(writer.events).not.toContain("close");
    writerDrain.resolve();
    await stopping;
    expect(String(await observed)).toContain("sealed");
    expect(events).toEqual(["producer-close", "database-close"]);
    expect(writer.events.slice(-3)).toEqual(["seal", "drained", "close"]);
  });

  test("a listener acquired after stop is registered and closed, never exposed to later code", async () => {
    const entered = barrier();
    const held = barrier();
    const events: string[] = [];
    const lifecycle = createStartupLifecycle({
      seal: async () => {
        events.push("seal");
      },
    });
    lifecycle.final(() => {
      events.push("database-close");
    });
    const starting = lifecycle.run(async (startup) => {
      await startup.acquire(
        async () => {
          entered.resolve();
          await held.promise;
          return {};
        },
        () => {
          events.push("listener-close");
        },
      );
      events.push("consumer");
      startup.acquireSync(
        () => {
          events.push("serve");
          return {};
        },
        () => {},
      );
    });
    const observed = starting.catch((error: unknown) => error);
    await entered.promise;
    const stopping = lifecycle.stop();
    expect(events).toEqual(["seal"]);
    held.resolve();
    await stopping;
    expect(String(await observed)).toContain("sealed");
    expect(events).toEqual(["seal", "listener-close", "database-close"]);
  });

  test("a synchronous first producer stop cannot skip later producers or individual delivery sweeps", async () => {
    const events: string[] = [];
    const lifecycle = createStartupLifecycle({
      seal: async () => {
        events.push("seal");
      },
    });
    lifecycle.final(() => {
      events.push("database-close");
    });
    await lifecycle.run(async (startup) => {
      for (const name of ["first", "second", "delivery-1", "delivery-2"]) {
        startup.acquireSync(
          () => name,
          (value) => {
            events.push(value);
            if (value === "first")
              throw new Error("unit first producer failed");
          },
        );
      }
    });
    const stopping = lifecycle.stop();
    await expect(stopping).rejects.toBeInstanceOf(AggregateError);
    expect(events).toEqual([
      "seal",
      "first",
      "second",
      "delivery-1",
      "delivery-2",
      "database-close",
    ]);
    expect(lifecycle.stop()).toBe(stopping);
  });

  test("a later bootstrap failure automatically cleans every acquired resource and stays failed", async () => {
    const events: string[] = [];
    const lifecycle = createStartupLifecycle({
      seal: async () => {
        events.push("seal");
      },
    });
    lifecycle.final(() => {
      events.push("database-close");
    });
    await expect(
      lifecycle.run(async (startup) => {
        startup.acquireSync(
          () => "producer",
          (value) => {
            events.push(value);
          },
        );
        await startup.acquire(
          async () => "listener",
          (value) => {
            events.push(value);
          },
        );
        await startup.step(async () => {
          throw new Error("unit later bootstrap failed");
        });
        events.push("serve");
      }),
    ).rejects.toThrow("lifecycle failed");
    expect(events).toEqual(["seal", "producer", "listener", "database-close"]);
    await expect(lifecycle.stop()).rejects.toThrow("lifecycle failed");
  });

  test("serve is an owned resource on normal startup and is stopped exactly once", async () => {
    let serves = 0;
    let closes = 0;
    const lifecycle = createStartupLifecycle({ seal: async () => {} });
    await lifecycle.run(async (startup) => {
      startup.acquireSync(
        () => {
          serves += 1;
          return {};
        },
        () => {
          closes += 1;
        },
      );
    });
    await lifecycle.stop();
    await lifecycle.stop();
    expect(serves).toBe(1);
    expect(closes).toBe(1);
  });

  test("stop before run never invokes the bootstrap factory", async () => {
    let calls = 0;
    const lifecycle = createStartupLifecycle({ seal: async () => {} });
    await lifecycle.stop();
    await expect(
      lifecycle.run(async () => {
        calls += 1;
      }),
    ).rejects.toThrow("sealed");
    expect(calls).toBe(0);
  });

  test("synchronous bootstrap failure cleans previously acquired resources", async () => {
    let closes = 0;
    const lifecycle = createStartupLifecycle({ seal: async () => {} });
    await expect(
      lifecycle.run(async (startup) => {
        startup.acquireSync(
          () => ({}),
          () => {
            closes += 1;
          },
        );
        throw new Error("unit synchronous startup failure");
      }),
    ).rejects.toThrow("lifecycle failed");
    expect(closes).toBe(1);
  });

  test("seal and final connection failures are both retained as failed cleanup", async () => {
    const lifecycle = createStartupLifecycle({
      seal: async () => {
        throw new Error("unit drain UNKNOWN");
      },
    });
    lifecycle.final(() => {
      throw new Error("unit final close failed");
    });
    await lifecycle.run(async () => {});
    const failure: unknown = await lifecycle
      .stop()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (failure instanceof AggregateError)
      expect(failure.errors).toHaveLength(2);
  });
});

function fixture(
  options: {
    url?: string;
    create?: () => Promise<void>;
    initialize?: () => Promise<void>;
    drain?: () => Promise<void>;
    close?: () => Promise<void>;
  } = {},
) {
  const events: string[] = [];
  const application = { name: "application" };
  const writer = { name: "writer" };
  let sealed = false;
  const lifecycle = createRoleWriterLifecycle({
    application,
    url: options.url ?? "unit-only-secret://restricted",
    create: async () => {
      events.push("create");
      await options.create?.();
      return writer;
    },
    initialize: async (app, restricted) => {
      expect(app).toBe(application);
      expect(restricted).toBe(writer);
      expect(app).not.toBe(restricted);
      events.push("initialize");
      await options.initialize?.();
      events.push("bound");
    },
    stop: async () => {
      sealed = true;
      events.push("seal");
      await options.drain?.();
      events.push("drained");
    },
    close: async (restricted) => {
      expect(restricted).toBe(writer);
      events.push("close");
      await options.close?.();
    },
  });
  return { lifecycle, events, isSealed: () => sealed };
}

describe("restricted role writer lifecycle (injected CPU unit)", () => {
  test("initializes a distinct writer before a consumer and drains before close", async () => {
    const { lifecycle, events } = fixture();
    await lifecycle.start();
    events.push("consumer");
    await lifecycle.stop();
    expect(events).toEqual([
      "create",
      "initialize",
      "bound",
      "consumer",
      "seal",
      "drained",
      "close",
    ]);
  });

  test("repeated start shares initialization and repeated stop shares cleanup", async () => {
    const { lifecycle, events } = fixture();
    const first = lifecycle.start();
    expect(lifecycle.start()).toBe(first);
    await first;
    const stop = lifecycle.stop();
    expect(lifecycle.stop()).toBe(stop);
    await stop;
    expect(events.filter((event) => event === "create")).toHaveLength(1);
    expect(events.filter((event) => event === "close")).toHaveLength(1);
  });

  test("seal is synchronous and the pool remains open while a transaction is pending", async () => {
    const held = barrier();
    const { lifecycle, events, isSealed } = fixture({
      drain: () => held.promise,
    });
    await lifecycle.start();
    const stopping = lifecycle.stop();
    expect(isSealed()).toBe(true);
    await Promise.resolve();
    expect(events).not.toContain("close");
    held.resolve();
    await stopping;
    expect(events.slice(-3)).toEqual(["seal", "drained", "close"]);
  });

  test("stop during connection creation waits, prevents readiness, and closes once", async () => {
    const held = barrier();
    const { lifecycle, events } = fixture({ create: () => held.promise });
    const starting = lifecycle.start();
    const rejected = starting.catch((error: unknown) => error);
    const stopping = lifecycle.stop();
    expect(events).toEqual(["create"]);
    held.resolve();
    await stopping;
    expect(String(await rejected)).toContain("stopped during startup");
    expect(events).toEqual([
      "create",
      "initialize",
      "bound",
      "seal",
      "drained",
      "close",
    ]);
  });

  test("stop during identity inspection waits for inspection before sealing and closing", async () => {
    const entered = barrier();
    const held = barrier();
    const { lifecycle, events } = fixture({
      initialize: async () => {
        entered.resolve();
        await held.promise;
      },
    });
    const starting = lifecycle.start();
    const rejected = starting.catch((error: unknown) => error);
    await entered.promise;
    const stopping = lifecycle.stop();
    expect(events).not.toContain("close");
    held.resolve();
    await stopping;
    expect(String(await rejected)).toContain("stopped during startup");
    expect(events.slice(-4)).toEqual(["bound", "seal", "drained", "close"]);
  });

  test("a failed inspection closes its unbound pool and rejects startup without exposing the URL", async () => {
    const { lifecycle, events } = fixture({
      initialize: async () => {
        throw new Error("unit-only-secret://restricted");
      },
    });
    await expect(lifecycle.start()).rejects.toThrow("initialization failed");
    await expect(lifecycle.stop()).rejects.toThrow("initialization failed");
    expect(events).toEqual(["create", "initialize", "close"]);
  });

  test("a rejected factory has no pool to close and never falls back to the application", async () => {
    const { lifecycle, events } = fixture({
      create: async () => {
        throw new Error("unit-only-secret://restricted");
      },
    });
    await expect(lifecycle.start()).rejects.toThrow("initialization failed");
    expect(events).toEqual(["create"]);
  });

  test.each([undefined, "", "   "])(
    "missing URL %p refuses before opening a pool",
    async (url) => {
      let calls = 0;
      const application = {};
      const lifecycle = createRoleWriterLifecycle({
        application,
        url,
        create: () => {
          calls += 1;
          return {};
        },
        initialize: async () => {},
        stop: async () => {},
        close: async () => {},
      });
      await expect(lifecycle.start()).rejects.toThrow("initialization failed");
      expect(calls).toBe(0);
    },
  );

  test("stop before start seals startup without acquiring a connection", async () => {
    const { lifecycle, events } = fixture();
    await lifecycle.stop();
    await expect(lifecycle.start()).rejects.toThrow("sealed");
    expect(events).toEqual([]);
  });

  test.each(["transaction rejected", "COMMIT outcome UNKNOWN"])(
    "%s is a failed drain, never a successful shutdown",
    async (message) => {
      const held = barrier();
      const { lifecycle, events } = fixture({ drain: () => held.promise });
      await lifecycle.start();
      const stopping = lifecycle.stop();
      const check = stopping.catch((error: unknown) => error);
      expect(events).not.toContain("close");
      held.reject(new Error(message));
      expect(String(await check)).toContain("cleanup is unconfirmed");
      expect(events.slice(-2)).toEqual(["seal", "close"]);
      await expect(lifecycle.stop()).rejects.toThrow("cleanup is unconfirmed");
    },
  );

  test("failed close is retained and never retried as a successful double stop", async () => {
    const { lifecycle, events } = fixture({
      close: async () => {
        throw new Error("driver secret");
      },
    });
    await lifecycle.start();
    await expect(lifecycle.stop()).rejects.toThrow("cleanup is unconfirmed");
    await expect(lifecycle.stop()).rejects.toThrow("cleanup is unconfirmed");
    expect(events.filter((event) => event === "close")).toHaveLength(1);
  });

  test("inspection failure plus close failure preserve failure without raw driver text", async () => {
    const { lifecycle } = fixture({
      initialize: async () => {
        throw new Error("unit-only-secret://restricted");
      },
      close: async () => {
        throw new Error("unit-only-secret://restricted");
      },
    });
    try {
      await lifecycle.start();
      throw new Error("unexpected success");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(String(error)).toContain("cleanup is unconfirmed");
      expect(String(error)).not.toContain("unit-only-secret");
      if (error instanceof AggregateError) {
        expect(error.errors.map(String).join(" ")).not.toContain(
          "unit-only-secret",
        );
      }
    }
  });
});

describe("dedicated writer configuration (synthetic environment only)", () => {
  const environment = {
    DATABASE_URL: "postgres://unit-application@127.0.0.1/unit",
    KEY_ENCRYPTION_KEY: "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=",
    OPENBOT_SINGLE_USER: "true",
  };
  test("reads only the dedicated setting and trims it", () => {
    expect(
      loadConfig({
        ...environment,
        ROLE_WRITER_DATABASE_URL: "  postgres://unit-writer@127.0.0.1/unit  ",
      }).roleWriterDatabaseUrl,
    ).toBe("postgres://unit-writer@127.0.0.1/unit");
  });
  test("application URL is never used as the dedicated fallback", () => {
    expect(loadConfig(environment).roleWriterDatabaseUrl).toBeUndefined();
    expect(
      loadConfig({ ...environment, ROLE_WRITER_DATABASE_URL: "   " })
        .roleWriterDatabaseUrl,
    ).toBeUndefined();
  });
  test("a stopped lifecycle cannot announce readiness again", async () => {
    const { lifecycle } = fixture();
    await lifecycle.start();
    await lifecycle.stop();
    await expect(lifecycle.start()).rejects.toThrow("sealed");
  });
});
