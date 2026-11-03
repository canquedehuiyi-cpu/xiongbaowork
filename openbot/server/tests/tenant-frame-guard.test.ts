import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import {
  asPlatform,
  assertPersonTenant,
  currentTenant,
  isPersonTenant,
  isTenantFramed,
  requireTenant,
  runAsClaimedTenant,
  runAsTenant,
  TenantContextError,
} from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { expectUnframedRefused, UNFRAMED_REFUSAL } from "./support/frame-guard";

/*
 * G01-E P16: there is no answer outside a tenant frame. `currentTenant()` used to fall back to the
 * legacy `system` frame, and `OPENBOT_TENANT_FRAME_GUARD` (`off` / `report` / `throw`) decided
 * whether that was silent, written to stderr as a `tenant-unframed-access` line, or refused. The
 * fallback and the guard are gone: an unframed read is a `TenantContextError` whatever the
 * environment says, nothing is written about it, and a framed read is never affected.
 *
 * The variable is still set below, to every value it ever had, to prove that it no longer matters.
 */
const saved = process.env.OPENBOT_TENANT_FRAME_GUARD;
afterEach(() => {
  if (saved === undefined) delete process.env.OPENBOT_TENANT_FRAME_GUARD;
  else process.env.OPENBOT_TENANT_FRAME_GUARD = saved;
});

/*
 * A statement built at module scope, the moment this file is imported and before any frame exists:
 * the client asks for the tenant before drizzle sees the call, so it is refused here rather than
 * left to run later as whoever awaits it, or as nobody. Creating the client makes no connection.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
afterAll(async () => {
  await database.$client.close();
});
function refusalOf(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}
const builtAtModuleScope = refusalOf(() =>
  database.select({ id: users.id }).from(users),
);

describe("no tenant frame", () => {
  test("currentTenant() outside every frame throws whatever the environment says, and writes nothing", () => {
    const lines: string[] = [];
    const written = spyOn(process.stderr, "write").mockImplementation(
      (chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      },
    );
    try {
      for (const guard of [undefined, "off", "report", "throw", "yes"]) {
        if (guard === undefined) delete process.env.OPENBOT_TENANT_FRAME_GUARD;
        else process.env.OPENBOT_TENANT_FRAME_GUARD = guard;
        // One call site reached twice, which `report` used to write once.
        for (let read = 0; read < 2; read += 1)
          expect(() => currentTenant()).toThrow(
            new TenantContextError(UNFRAMED_REFUSAL),
          );
        expect(() => requireTenant()).toThrow(
          new TenantContextError(UNFRAMED_REFUSAL),
        );
        expect(isTenantFramed()).toBe(false);
      }
    } finally {
      written.mockRestore();
    }
    expect(
      lines.filter((line) => line.includes("tenant-unframed-access")),
    ).toEqual([]);
    expect(lines).toEqual([]);
  });

  test("an empty frame names nobody, the same as none", () => {
    expect(() => runAsTenant("", () => currentTenant())).toThrow(
      new TenantContextError(UNFRAMED_REFUSAL),
    );
    expect(runAsTenant("", () => isTenantFramed())).toBe(false);
  });

  test("a framed read is untouched, and the explicit system frame is a frame like any other", async () => {
    expect(runAsTenant("user-1", () => currentTenant())).toBe("user-1");
    expect(runAsTenant("user-1", () => requireTenant())).toBe("user-1");
    expect(runAsTenant("user-1", () => isTenantFramed())).toBe(true);
    expect(runAsTenant("platform", () => currentTenant())).toBe("platform");
    // The explicit escape for the catalogue rows every tenant reads: named, never a fallback.
    expect(runAsTenant("system", () => currentTenant())).toBe("system");
    expect(
      await runAsTenant("user-2", async () => {
        await Promise.resolve();
        return currentTenant();
      }),
    ).toBe("user-2");
    // The frame closes with its work.
    expect(() => currentTenant()).toThrow(TenantContextError);
  });

  test("a module-scope builder is refused when it is built, so there is nothing to await later", async () => {
    expect(builtAtModuleScope).toBeInstanceOf(TenantContextError);
    expect((builtAtModuleScope as Error).message).toBe(UNFRAMED_REFUSAL);
    // The same from a test body outside every frame, for a builder, a transaction and a raw statement.
    await expectUnframedRefused(() =>
      database.select({ id: users.id }).from(users),
    );
    await expectUnframedRefused(() =>
      database.transaction(async () => undefined),
    );
    await expectUnframedRefused(() => database.execute("select 1"));
  });
});

/*
 * G01-E: rows shared by the whole team are stamped `team`, and `team` belongs to nobody. It is a
 * stamp a row carries, never a frame anybody acts in, so it is refused everywhere a frame is opened.
 */
describe("team is nobody", () => {
  test("it is not a person tenant", () => {
    expect(TEAM_TENANT).toBe("team");
    expect(isPersonTenant("team")).toBe(false);
    expect(isPersonTenant("user-1")).toBe(true);
  });

  test("background work stamped team has nobody to run as", () => {
    expect(() => assertPersonTenant("team")).toThrow("untrusted tenant");
    expect(() => assertPersonTenant("team", "team")).toThrow(
      TenantContextError,
    );
  });

  test("a claimed item stamped team never runs", async () => {
    let called = false;
    const outcome = await runAsClaimedTenant(
      { tenantId: "team" },
      "team",
      async () => {
        called = true;
      },
    );
    expect(outcome).toEqual({ ran: false, reason: "untrusted tenant" });
    expect(called).toBe(false);
  });

  test("no frame can be opened as team, and the work is never called", () => {
    let called = false;
    expect(() =>
      runAsTenant("team", () => {
        called = true;
      }),
    ).toThrow(TenantContextError);
    expect(() => runAsTenant(TEAM_TENANT, () => undefined)).toThrow(
      "'team' is a stamp, never a frame",
    );
    expect(called).toBe(false);
    // Nor from inside the platform's frame, which may otherwise open any tenant's.
    expect(() =>
      asPlatform(() => runAsTenant("team", () => undefined)),
    ).toThrow(TenantContextError);
  });

  test("asPlatform opens the platform frame for exactly its own work", async () => {
    expect(asPlatform(() => currentTenant())).toBe("platform");
    expect(
      await asPlatform(async () => {
        await Promise.resolve();
        return currentTenant();
      }),
    ).toBe("platform");
    expect(() => currentTenant()).toThrow(TenantContextError);
  });
});

/*
 * The probe the decision tests ask with (`tests/support/frame-guard.ts`). It has to answer one
 * question — "was this refused FOR HAVING NO FRAME?" — so it is asked here about work that is
 * unframed, work that was framed after all, and work refused by a different `TenantContextError`.
 */
describe("the unframed-refusal probe", () => {
  test("pins the refusal currentTenant() makes outside every frame, word for word", () => {
    expect(() => currentTenant()).toThrow(
      new TenantContextError(UNFRAMED_REFUSAL),
    );
  });

  test("passes for unframed work, synchronous or not", async () => {
    await expectUnframedRefused(() => currentTenant());
    await expectUnframedRefused(async () => {
      await Promise.resolve();
      return currentTenant();
    });
  });

  test("fails for work that runs framed", async () => {
    let probe: unknown;
    try {
      await expectUnframedRefused(() => runAsTenant("person-a", currentTenant));
    } catch (error) {
      probe = error;
    }
    expect(probe).toBeInstanceOf(Error);
  });

  test("fails for work refused by a TenantContextError that is not the missing frame", async () => {
    for (const work of [
      () => runAsTenant(TEAM_TENANT, currentTenant),
      () => assertPersonTenant("person-a", "person-b"),
      () => runAsTenant("person-a", () => assertPersonTenant("person-b")),
    ]) {
      let probe: unknown;
      try {
        await expectUnframedRefused(work);
      } catch (error) {
        probe = error;
      }
      expect(probe).toBeInstanceOf(Error);
      // The probe's own failure, not the refusal it was handed passed through as a pass.
      expect(probe).not.toBeInstanceOf(TenantContextError);
    }
  });

  test("passes whatever the old guard variable says, and leaves the environment as it found it", async () => {
    process.env.OPENBOT_TENANT_FRAME_GUARD = "off";
    await expectUnframedRefused(() => currentTenant());
    expect(process.env.OPENBOT_TENANT_FRAME_GUARD).toBe("off");
  });
});
