import { afterEach, describe, expect, mock, test } from "bun:test";
import type { EnterpriseDeps } from "../src/admin/controls";
import { createStartupLifecycle } from "../src/auth/role-writer-lifecycle";
import type { Database } from "../src/db/client";
import type { EventExporter } from "../src/telemetry/otel";

type Tap = Parameters<typeof import("../src/audit").addAuditTap>[0];
type Fixture = {
  events: string[];
  callbacks: (() => void)[];
  taps: Tap[];
  timers: ReturnType<typeof setInterval>[];
  emits: number;
  reads: number;
  end?: () => Promise<void>;
  exporterClose?: () => Promise<void>;
  connectFailure?: boolean;
  timerFailure?: number;
  tapFailure?: number;
  clearFailure?: number;
  reenter?: () => void;
};
let current: Fixture;
const audit = await import("../src/audit");
const settings = await import("../src/admin/settings-store");
mock.module("../src/audit", () => ({
  ...audit,
  addAuditTap: (tap: Tap) => {
    const owner = current;
    const index = owner.taps.push(tap);
    return () => {
      owner.events.push("tap-remove");
      if (owner.tapFailure === index)
        throw new Error("unit-driver-secret://tap");
    };
  },
}));
mock.module("../src/admin/settings-store", () => ({
  ...settings,
  createEnterpriseStore: () => {
    const owner = current;
    return {
      capabilityRows: async () => {
        owner.reads += 1;
        return [];
      },
      adminIds: async () => new Set<string>(),
      settings: async () => settings.DEFAULT_ENTERPRISE_SETTINGS,
      networkPolicies: async () => [],
      groupMembers: async () => new Map<string, string[]>(),
    };
  },
}));
mock.module("postgres", () => ({
  default: () => {
    const owner = current;
    owner.events.push("connect");
    if (owner.connectFailure) throw new Error("unit-driver-secret://connect");
    return {
      listen: async () => {
        owner.events.push("listen");
      },
      end: () => {
        owner.events.push("end");
        return owner.end?.() ?? Promise.resolve();
      },
    };
  },
}));
mock.module("../src/telemetry/otel", () => ({
  createOtelEventExporter: (): EventExporter => {
    const owner = current;
    owner.events.push("exporter");
    return {
      emit: () => {
        owner.emits += 1;
      },
      shutdown: () => {
        owner.events.push("exporter-close");
        return owner.exporterClose?.() ?? Promise.resolve();
      },
    };
  },
}));
const { enterpriseControls, installEnterpriseControls } = await import(
  "../src/admin/controls"
);
const originalInterval = globalThis.setInterval;
const originalClear = globalThis.clearInterval;
afterEach(async () => {
  await enterpriseControls()
    ?.stop()
    .catch(() => {});
  for (const timer of current?.timers ?? []) originalClear(timer);
});

function fixture(options: Partial<Fixture> = {}) {
  current = {
    events: [],
    callbacks: [],
    taps: [],
    timers: [],
    emits: 0,
    reads: 0,
    ...options,
  };
  const owner = current;
  let acquisitions = 0;
  let clears = 0;
  const clock: NonNullable<EnterpriseDeps["clock"]> = {
    scheduleInterval: (handler, delay) => {
      if (++acquisitions === owner.timerFailure)
        throw new Error("unit-driver-secret://timer");
      owner.callbacks.push(handler);
      const timer = originalInterval(handler, delay);
      owner.timers.push(timer);
      return timer;
    },
    cancelInterval: (timer) => {
      const reenter = owner.reenter;
      owner.reenter = undefined;
      reenter?.();
      owner.events.push("timer-clear");
      if (++clears === owner.clearFailure)
        throw new Error("unit-driver-secret://clear");
      originalClear(timer);
    },
  };
  // Unreachable DB double: this lifecycle unit never claims to execute database statements.
  const database = new Proxy(
    {},
    {
      get() {
        throw new Error("UNIT_DATABASE_FORBIDDEN");
      },
    },
  ) as Database;
  const deps = {
    database,
    clock,
    databaseUrl: "unit-driver-secret://not-a-real-database",
    auditStore: { insert: async () => {} },
    env: {},
  };
  return { owner, install: () => installEnterpriseControls(deps) };
}

function safeFailure(error: unknown, count: number) {
  expect(error).toBeInstanceOf(AggregateError);
  expect(String(error)).not.toContain("unit-driver-secret");
  if (error instanceof AggregateError) {
    expect(error.errors).toHaveLength(count);
    expect(error.errors.map(String).join(" ")).not.toContain(
      "unit-driver-secret",
    );
  }
}

describe("real enterprise controls stop entry (injected CPU ports)", () => {
  test("seals callbacks, clears timers and taps before closes, and double stop shares one result", async () => {
    const { owner, install } = fixture();
    const controls = await install();
    const first = controls.stop();
    expect(controls.stop()).toBe(first);
    expect(enterpriseControls()).toBeUndefined();
    expect(owner.events.slice(-5)).toEqual([
      "timer-clear",
      "timer-clear",
      "timer-clear",
      "tap-remove",
      "tap-remove",
    ]);
    const reads = owner.reads;
    for (const callback of owner.callbacks) callback();
    for (const tap of owner.taps)
      tap({
        eventType: "configuration.changed",
        targetType: "unit",
        payload: {},
        initiatorKind: "deployment",
        initiatorId: null,
      });
    expect(owner.reads).toBe(reads);
    expect(owner.emits).toBe(0);
    await first;
    await controls.stop();
    expect(owner.events.filter((event) => event === "end")).toHaveLength(1);
    expect(
      owner.events.filter((event) => event === "exporter-close"),
    ).toHaveLength(1);
  });

  test.each(["end", "exporter"])(
    "%s rejection propagates as one sanitized failed stage",
    async (side) => {
      const fail = () =>
        Promise.reject(new Error("unit-driver-secret://rejected"));
      const { owner, install } = fixture(
        side === "end" ? { end: fail } : { exporterClose: fail },
      );
      const controls = await install();
      const stopping = controls.stop();
      safeFailure(await stopping.catch((error: unknown) => error), 1);
      expect(controls.stop()).toBe(stopping);
      expect(owner.events.slice(-2)).toEqual(["end", "exporter-close"]);
    },
  );

  test("both rejected closes are attempted and retained", async () => {
    const fail = () => Promise.reject(new Error("unit-driver-secret://both"));
    const { owner, install } = fixture({ end: fail, exporterClose: fail });
    safeFailure(
      await (await install()).stop().catch((error: unknown) => error),
      2,
    );
    expect(owner.events.slice(-2)).toEqual(["end", "exporter-close"]);
  });

  test.each(["end", "exporter"])(
    "synchronous %s throw cannot skip the other close",
    async (side) => {
      const fail = (): Promise<void> => {
        throw new Error("unit-driver-secret://sync");
      };
      const { owner, install } = fixture(
        side === "end" ? { end: fail } : { exporterClose: fail },
      );
      safeFailure(
        await (await install()).stop().catch((error: unknown) => error),
        1,
      );
      expect(owner.events.slice(-2)).toEqual(["end", "exporter-close"]);
    },
  );

  test("one rejected close does not settle shutdown before the other held close", async () => {
    let release = () => {};
    let entered = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const atClose = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { install } = fixture({
      end: () => {
        entered();
        return held;
      },
      exporterClose: () =>
        Promise.reject(new Error("unit-driver-secret://held")),
    });
    const controls = await install();
    let settled = false;
    const observed = controls.stop().then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await atClose;
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    safeFailure(await observed, 1);
  });

  test("connection construction failure cleans the acquired exporter and taps", async () => {
    const { owner, install } = fixture({ connectFailure: true });
    const error: unknown = await install().catch((failure: unknown) => failure);
    expect(String(error)).toContain("initialization failed");
    expect(String(error)).not.toContain("unit-driver-secret");
    expect(owner.events.filter((event) => event === "tap-remove")).toHaveLength(
      2,
    );
    expect(
      owner.events.filter((event) => event === "exporter-close"),
    ).toHaveLength(1);
    expect(enterpriseControls()).toBeUndefined();
  });

  test("second timer construction failure retains and clears the first acquired timer", async () => {
    const { owner, install } = fixture({ timerFailure: 2 });
    await expect(install()).rejects.toThrow("initialization failed");
    expect(owner.timers).toHaveLength(1);
    expect(
      owner.events.filter((event) => event === "timer-clear"),
    ).toHaveLength(1);
    expect(owner.events.slice(-2)).toEqual(["end", "exporter-close"]);
    expect(enterpriseControls()).toBeUndefined();
  });

  test.each(["tap", "timer"])(
    "a synchronous %s seal failure still attempts all resources",
    async (side) => {
      const { owner, install } = fixture(
        side === "tap" ? { tapFailure: 1 } : { clearFailure: 1 },
      );
      safeFailure(
        await (await install()).stop().catch((error: unknown) => error),
        1,
      );
      expect(
        owner.events.filter((event) => event === "timer-clear"),
      ).toHaveLength(3);
      expect(
        owner.events.filter((event) => event === "tap-remove"),
      ).toHaveLength(2);
      expect(owner.events.slice(-2)).toEqual(["end", "exporter-close"]);
    },
  );

  test("concurrent installation shares initialization instead of acquiring duplicate pools", async () => {
    const { owner, install } = fixture();
    const first = install();
    expect(install()).toBe(first);
    const controls = await first;
    expect(owner.events.filter((event) => event === "connect")).toHaveLength(1);
    await controls.stop();
  });
  test("initialization plus cleanup failure retain sanitized nested failed stages", async () => {
    const { owner, install } = fixture({
      connectFailure: true,
      exporterClose: () =>
        Promise.reject(new Error("unit-driver-secret://init-close")),
    });
    const failure: unknown = await install().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (failure instanceof AggregateError) {
      expect(failure.errors).toHaveLength(2);
      safeFailure(failure.errors[1], 1);
    }
    expect(String(failure)).not.toContain("unit-driver-secret");
    expect(owner.events.filter((event) => event === "tap-remove")).toHaveLength(
      2,
    );
    expect(
      owner.events.filter((event) => event === "exporter-close"),
    ).toHaveLength(1);
  });
  test("real controls stop rejection reaches the startup coordinator and still closes its final connection", async () => {
    const { owner, install } = fixture({
      end: () => Promise.reject(new Error("unit-driver-secret://coordinated")),
    });
    const lifecycle = createStartupLifecycle({
      seal: async () => {
        owner.events.push("writer-seal");
      },
    });
    lifecycle.final(() => {
      owner.events.push("application-close");
    });
    await lifecycle.run(async (startup) => {
      await startup.acquire(install, (controls) => controls.stop());
    });
    const stopping = lifecycle.stop();
    const failure: unknown = await stopping.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(String(failure)).not.toContain("unit-driver-secret");
    expect(lifecycle.stop()).toBe(stopping);
    expect(owner.events.slice(-3)).toEqual([
      "end",
      "exporter-close",
      "application-close",
    ]);
    expect(owner.events.filter((event) => event === "end")).toHaveLength(1);
  });
  test("reentry during synchronous seal shares the already-cached promise and cannot repeat cleanup", async () => {
    const { owner, install } = fixture();
    const controls = await install();
    let reentered: Promise<void> | undefined;
    owner.reenter = () => {
      reentered = controls.stop();
    };
    const stopping = controls.stop();
    expect(reentered).toBe(stopping);
    await stopping;
    expect(
      owner.events.filter((event) => event === "timer-clear"),
    ).toHaveLength(3);
    expect(owner.events.filter((event) => event === "tap-remove")).toHaveLength(
      2,
    );
    expect(owner.events.filter((event) => event === "end")).toHaveLength(1);
    expect(
      owner.events.filter((event) => event === "exporter-close"),
    ).toHaveLength(1);
  });
});
