import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import {
  assertPersonTenant,
  asPlatform,
  currentTenant,
  forgetReportedUnframedSites,
  isPersonTenant,
  runAsClaimedTenant,
  runAsTenant,
  TenantContextError,
  tenantFrameGuard,
} from "../src/tenant/context";
import { expectUnframedRefused, UNFRAMED_REFUSAL } from "./support/frame-guard";

/*
 * G01-D, step one: `OPENBOT_TENANT_FRAME_GUARD` decides what an unframed read of the tenant does,
 * so the remaining offenders can be found (`report`, which CI's server shards run) or proven gone
 * (`throw`) before the legacy `system` fallback is removed. A framed read is never affected.
 */
const saved = process.env.OPENBOT_TENANT_FRAME_GUARD;
afterEach(() => {
  if (saved === undefined) delete process.env.OPENBOT_TENANT_FRAME_GUARD;
  else process.env.OPENBOT_TENANT_FRAME_GUARD = saved;
});

describe("tenant frame guard", () => {
  test("only report and throw switch it on, and anything else is the legacy fallback", () => {
    expect(tenantFrameGuard({})).toBe("off");
    expect(tenantFrameGuard({ OPENBOT_TENANT_FRAME_GUARD: "off" })).toBe("off");
    expect(tenantFrameGuard({ OPENBOT_TENANT_FRAME_GUARD: "yes" })).toBe("off");
    expect(tenantFrameGuard({ OPENBOT_TENANT_FRAME_GUARD: " Report " })).toBe(
      "report",
    );
    expect(tenantFrameGuard({ OPENBOT_TENANT_FRAME_GUARD: "THROW" })).toBe(
      "throw",
    );
  });

  test("off: an unframed read is still the legacy system answer, and says nothing", () => {
    process.env.OPENBOT_TENANT_FRAME_GUARD = "off";
    const written = spyOn(process.stderr, "write");
    try {
      expect(currentTenant()).toBe("system");
      expect(written).not.toHaveBeenCalled();
    } finally {
      written.mockRestore();
    }
  });

  test("report: still system, but each call site is written once with who forgot the frame", () => {
    process.env.OPENBOT_TENANT_FRAME_GUARD = "report";
    // Under CI's own `report`, other files in this shard may already have filled the cap.
    forgetReportedUnframedSites();
    const lines: string[] = [];
    const written = spyOn(process.stderr, "write").mockImplementation(
      (chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      },
    );
    try {
      // One call site, reached twice: reported once.
      for (let read = 0; read < 2; read += 1)
        expect(currentTenant()).toBe("system");
    } finally {
      written.mockRestore();
    }
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0] ?? "{}") as {
      type: string;
      site: string;
      stack: string[];
    };
    expect(report.type).toBe("tenant-unframed-access");
    expect(report.site).toContain("tenant-frame-guard.test.ts");
    expect(report.site).not.toContain("tenant/context.ts");
  });

  test("throw: an unframed read is a TenantContextError, a framed one is untouched", async () => {
    process.env.OPENBOT_TENANT_FRAME_GUARD = "throw";
    expect(() => currentTenant()).toThrow(TenantContextError);
    expect(runAsTenant("user-1", () => currentTenant())).toBe("user-1");
    expect(runAsTenant("platform", () => currentTenant())).toBe("platform");
    // The explicit escape for the catalogue rows every tenant reads: named, never a fallback.
    expect(runAsTenant("system", () => currentTenant())).toBe("system");
    expect(
      await runAsTenant("user-2", async () => {
        await Promise.resolve();
        return currentTenant();
      }),
    ).toBe("user-2");
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
    process.env.OPENBOT_TENANT_FRAME_GUARD = "throw";
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
    process.env.OPENBOT_TENANT_FRAME_GUARD = "throw";
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

  test("puts the guard back as it found it", async () => {
    process.env.OPENBOT_TENANT_FRAME_GUARD = "report";
    await expectUnframedRefused(() => currentTenant());
    expect(process.env.OPENBOT_TENANT_FRAME_GUARD).toBe("report");
  });
});
