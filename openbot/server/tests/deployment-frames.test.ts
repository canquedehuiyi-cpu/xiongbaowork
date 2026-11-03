import { describe, expect, test } from "bun:test";
import {
  type AuditStore,
  recordPersonAuditEvent,
  recordPlatformAuditEvent,
} from "../src/audit";
import { Hono } from "hono";
import {
  type AppVariables,
  type AuthService,
  createRequireUser,
} from "../src/auth/guards";
import { checkServerReadiness } from "../src/auth/role-writer-lifecycle";
import {
  currentTenant,
  runAsTenant,
  TenantContextError,
} from "../src/tenant/context";

/*
 * G01-D: work that has no person behind it says whose it is at the call site. An unframed read of
 * the tenant is a `TenantContextError` — the suite's default since G01-E P15, and the only behaviour
 * once P16 removes the `system` fallback — so a call site that forgot its frame fails the test that
 * reaches it instead of quietly answering `system`. Nothing here switches a guard.
 */

/** An audit store that remembers which tenant each row would have been stamped with. */
function recordingStore() {
  const rows: { tenant: string; eventType: string }[] = [];
  const store: AuditStore = {
    insert: async (event) => {
      rows.push({ tenant: currentTenant(), eventType: event.eventType });
    },
  };
  return { store, rows };
}

describe("boot readiness", () => {
  test("reads the role facts as platform, so a boot with no frame is not refused", async () => {
    const seen: string[] = [];
    const reports: string[] = [];
    await checkServerReadiness({
      read: async () => {
        seen.push(currentTenant());
        return [{ role: "openbot_app", super: false, bypass: false }];
      },
      mode: "refuse",
      report: (event) => reports.push(event.type),
    });
    expect(seen).toEqual(["platform"]);
    expect(reports).toEqual([]);
  });
});

describe("audit rows that say whose they are", () => {
  test("a deployment row is platform's even when written with no frame", async () => {
    const { store, rows } = recordingStore();
    await recordPlatformAuditEvent(store, {
      eventType: "computer.policy_loaded",
      targetType: "policy",
      payload: {},
    });
    expect(rows).toEqual([
      { tenant: "platform", eventType: "computer.policy_loaded" },
    ]);
  });

  test("a deployment row is platform's even inside a person's frame", async () => {
    const { store, rows } = recordingStore();
    await runAsTenant("person-a", () =>
      recordPlatformAuditEvent(store, {
        eventType: "session.refused",
        targetType: "person",
        payload: {},
      }),
    );
    expect(rows[0]?.tenant).toBe("platform");
  });

  test("a person's row is filed in their tenant, from a platform frame or none", async () => {
    const { store, rows } = recordingStore();
    await recordPersonAuditEvent(store, "person-a", {
      eventType: "session.signed_in",
      targetType: "person",
      payload: {},
    });
    await runAsTenant("platform", () =>
      recordPersonAuditEvent(store, "person-b", {
        eventType: "session.signed_in",
        targetType: "person",
        payload: {},
      }),
    );
    expect(rows.map((row) => row.tenant)).toEqual(["person-a", "person-b"]);
  });

  test("a row naming nobody, or another person than the frame, is refused and not written", async () => {
    const { store, rows } = recordingStore();
    for (const nobody of ["", "system", "platform", undefined]) {
      await expect(
        recordPersonAuditEvent(store, nobody, {
          eventType: "session.signed_in",
          targetType: "person",
          payload: {},
        }),
      ).rejects.toBeInstanceOf(TenantContextError);
    }
    await expect(
      runAsTenant("person-a", () =>
        recordPersonAuditEvent(store, "person-b", {
          eventType: "session.signed_in",
          targetType: "person",
          payload: {},
        }),
      ),
    ).rejects.toBeInstanceOf(TenantContextError);
    expect(rows).toEqual([]);
  });
});

describe("the request guard", () => {
  test("asks who is calling as platform, then runs the request as that person", async () => {
    const seen: Record<string, string> = {};
    const auth = {
      api: {
        getSession: async () => {
          seen.session = currentTenant();
          return {
            user: {
              id: "person-a",
              email: "a@x.test",
              name: null,
              image: null,
            },
          };
        },
      },
    } as unknown as AuthService;
    const app = new Hono<{ Variables: AppVariables }>();
    app.get(
      "/",
      createRequireUser(auth, {
        rolesForUser: async () => {
          seen.roles = currentTenant();
          return ["user"];
        },
      }),
      (context) => {
        seen.request = currentTenant();
        return context.text("ok");
      },
    );
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(seen).toEqual({
      session: "platform",
      roles: "platform",
      request: "person-a",
    });
  });
});
