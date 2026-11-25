import { afterEach, describe, expect, test } from "bun:test";
import {
  type CapabilityRow,
  capabilityRefusal,
  resolveCapability,
} from "../src/admin/capabilities";
import { createEnterpriseStore } from "../src/admin/settings-store";
import type { Database } from "../src/db/client";
import { setEdition } from "../src/edition";

const member = { role: "admin" as const, groups: [] };

/** A database that fails the test if the personal edition reads a stored value at all. */
const untouchable = new Proxy({} as Database, {
  get: (_target, property) => {
    throw new Error(
      `the personal edition read the database (${String(property)})`,
    );
  },
});

afterEach(() => setEdition("team"));

describe("the personal edition's capabilities", () => {
  test("ignores a stored row that widens a capability", () => {
    setEdition("personal");
    const rows: CapabilityRow[] = [
      {
        scopeKind: "organization",
        scopeId: "",
        capability: "slackTeams",
        allowed: true,
      },
    ];
    expect(resolveCapability(rows, member, "slackTeams").allowed).toBe(false);
  });

  test.each(["isolatedComputers", "teamBots", "slackTeams"] as const)(
    "refuses %s",
    (capability) => {
      setEdition("personal");
      expect(resolveCapability([], member, capability).allowed).toBe(false);
    },
  );

  test.each([
    "passwordManager",
    "proactive",
    "useBots",
    "cloudBrowser",
    // Folders on the person's own machine, through XiongBao Desktop. It was refused with "isn't part
    // of XiongBao Personal" on the desktop that offers it.
    "localComputer",
  ] as const)("keeps %s on", (capability) => {
    setEdition("personal");
    expect(resolveCapability([], member, capability).allowed).toBe(true);
  });

  test("a refusal does not blame an admin, because the person is the admin", () => {
    setEdition("personal");
    expect(capabilityRefusal("teamBots")).not.toContain("admin");
  });

  test("its stored capability rows are never read", async () => {
    setEdition("personal");
    expect(await createEnterpriseStore(untouchable).capabilityRows()).toEqual(
      [],
    );
  });
});

describe("what a team deployment left behind", () => {
  test("its network policies are not read", async () => {
    setEdition("personal");
    expect(await createEnterpriseStore(untouchable).networkPolicies()).toEqual(
      [],
    );
  });

  test("never stops a computer and keeps the check-in limit, whatever is stored", async () => {
    setEdition("personal");
    const settings = await createEnterpriseStore(untouchable).settings();
    expect(settings.inactiveComputerDays).toBe(0);
    expect(settings.proactiveDailyRuns).toBe(24);
    expect(settings.ssoRequired).toBe(false);
  });
});

describe("the team edition is unchanged", () => {
  test("a stored row still widens a capability", () => {
    const rows: CapabilityRow[] = [
      {
        scopeKind: "organization",
        scopeId: "",
        capability: "slackTeams",
        allowed: true,
      },
    ];
    expect(resolveCapability(rows, member, "slackTeams").allowed).toBe(true);
    expect(resolveCapability([], member, "isolatedComputers").allowed).toBe(
      true,
    );
  });

  test("the refusal still names the admin", () => {
    expect(capabilityRefusal("teamBots")).toBe(
      'An admin has turned off "Team Bots" for you, so that wasn\'t done.',
    );
  });
});

describe("the team edition's stored settings", () => {
  test("a row left by a setting this build no longer has does not stop the others being read", async () => {
    setEdition("team");
    const rows = [
      // Skill sharing was a setting until its feature was removed; deployments may still hold the row.
      { key: "skill_sharing", value: { value: true } },
      { key: "sso_required", value: { value: true } },
      { key: "inactive_computer_days", value: { value: 7 } },
    ];
    const database = {
      select: () => ({ from: async () => rows }),
    } as unknown as Database;
    const settings = await createEnterpriseStore(database).settings();
    expect(settings.ssoRequired).toBe(true);
    expect(settings.inactiveComputerDays).toBe(7);
    expect(Object.keys(settings)).not.toContain("skillSharing");
  });
});
