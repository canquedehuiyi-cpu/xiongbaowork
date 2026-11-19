import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { BunSQLSession, BunSQLTransaction } from "drizzle-orm/bun-sql/session";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  type AuditEventInput,
  type AuditTapEvent,
  addAuditTap,
  commitOwnerAssembly,
} from "../src/audit";
import type { Database } from "../src/db/client";
import * as schema from "../src/db/schema";

// Unit only: real typed Drizzle builders, intercepted before SQL execution.
// The lazy client is never connected; unsafe/connect and network entry points fail closed.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const event: AuditEventInput = {
  eventType: "configuration.changed",
  targetType: "skill",
  targetId: "unit-skill",
  actorUserId: "unit-owner",
  payload: {
    change: "owner_plugin_granted",
    apiKey: "unit-secret",
    safe: "kept",
  },
};

function fixture(
  failure?: "insert" | "commit" | "unknown",
  holdCommit = false,
) {
  const order: string[] = [];
  let releaseCommit = () => {};
  const commitGate = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  let reachedCommit = () => {};
  const atCommit = new Promise<void>((resolve) => {
    reachedCommit = resolve;
  });
  const client = new SQL({
    hostname: "127.0.0.1",
    port: 1,
    username: "unit",
    database: "unit",
    max: 1,
  });
  const connect = spyOn(client, "connect").mockImplementation(() => {
    throw new Error("UNIT_SQL_NETWORK_FORBIDDEN");
  });
  const unsafe = spyOn(client, "unsafe").mockImplementation(() => {
    throw new Error("UNIT_SQL_EXECUTION_FORBIDDEN");
  });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      () => {
        throw new Error("UNIT_FETCH_FORBIDDEN");
      },
      {
        preconnect: () => {
          throw new Error("UNIT_FETCH_FORBIDDEN");
        },
      },
    ),
  );
  const dialect = new PgDialect();
  const session = new BunSQLSession<
    SQL,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >(client, dialect, undefined);
  const transaction = new BunSQLTransaction<
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >(dialect, session, undefined);
  const database: Database = drizzle({ client, schema });
  const originalInsert = transaction.insert.bind(transaction);
  const insert = spyOn(transaction, "insert").mockImplementation((table) => {
    order.push("insert");
    return originalInsert(table);
  });
  const originalPrepare = session.prepareQuery.bind(session);
  const prepare = spyOn(session, "prepareQuery").mockImplementation(
    (...args) => {
      const query = originalPrepare(...args);
      expect(JSON.stringify(args[0].params)).not.toContain("unit-secret");
      spyOn(query, "execute").mockImplementation(async () => {
        order.push("audit");
        if (failure === "insert") throw new Error("INSERT_FAILED");
        return [];
      });
      return query;
    },
  );
  const transact = spyOn(database, "transaction").mockImplementation(
    async (work) => {
      order.push("begin");
      const result = await work(transaction);
      order.push("commit");
      reachedCommit();
      if (holdCommit) await commitGate;
      if (failure === "commit") throw new Error("COMMIT_FAILED");
      if (failure === "unknown") throw new Error("COMMIT_OUTCOME_UNKNOWN");
      order.push("resolved");
      return result;
    },
  );
  const observed: AuditTapEvent[] = [];
  const stopTap = addAuditTap((row) => {
    order.push("tap");
    observed.push(row);
  });
  cleanups.push(async () => {
    stopTap();
    transact.mockRestore();
    insert.mockRestore();
    prepare.mockRestore();
    fetch.mockRestore();
    expect(connect).not.toHaveBeenCalled();
    expect(unsafe).not.toHaveBeenCalled();
    connect.mockRestore();
    unsafe.mockRestore();
    await client.close();
  });
  return {
    database,
    transaction,
    order,
    observed,
    insert,
    releaseCommit,
    atCommit,
  };
}

const failures: Array<"insert" | "commit" | "unknown"> = [
  "insert",
  "commit",
  "unknown",
];

describe("owner assembly audit transaction unit", () => {
  test("work and redacted audit precede resolved commit; tap fires once afterwards", async () => {
    const f = fixture();
    const value = await commitOwnerAssembly(f.database, event, async (tx) => {
      expect(tx).toBe(f.transaction);
      f.order.push("work");
      expect(f.observed).toEqual([]);
      return { value: { revision: "unit-revision" }, changed: true };
    });
    expect(value.revision).toBe("unit-revision");
    expect(f.order).toEqual([
      "begin",
      "work",
      "insert",
      "audit",
      "commit",
      "resolved",
      "tap",
    ]);
    expect(f.observed).toEqual([
      {
        ...event,
        initiatorKind: "person",
        initiatorId: null,
        payload: {
          change: "owner_plugin_granted",
          apiKey: "[REDACTED]",
          safe: "kept",
        },
      },
    ]);
    expect(event.payload.apiKey).toBe("unit-secret");
  });

  test("a pending COMMIT cannot emit a tap before transaction resolution", async () => {
    const f = fixture(undefined, true);
    const pending = commitOwnerAssembly(f.database, event, async () => ({
      value: true,
      changed: true,
    }));
    await f.atCommit;
    expect(f.observed).toEqual([]);
    expect(f.order).not.toContain("resolved");
    f.releaseCommit();
    expect(await pending).toBe(true);
    expect(f.observed).toHaveLength(1);
  });

  test("existing initiator attribution is retained without adding tenant fields", async () => {
    const f = fixture();
    await commitOwnerAssembly(
      f.database,
      { ...event, initiator: { kind: "routine", id: "unit-routine" } },
      async () => ({ value: null, changed: true }),
    );
    expect(f.observed[0]).toMatchObject({
      initiatorKind: "routine",
      initiatorId: "unit-routine",
    });
    expect(f.observed[0]).not.toHaveProperty("initiator");
    expect(f.observed[0]).not.toHaveProperty("subjectTenantId");
  });

  test("unchanged desired state produces neither audit insert nor tap", async () => {
    const f = fixture();
    expect(
      await commitOwnerAssembly(f.database, event, async () => ({
        value: 7,
        changed: false,
      })),
    ).toBe(7);
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.observed).toEqual([]);
  });

  test("work failure never inserts or taps", async () => {
    const f = fixture();
    await expect(
      commitOwnerAssembly(f.database, event, async () => {
        throw new Error("WORK_FAILED");
      }),
    ).rejects.toThrow("WORK_FAILED");
    expect(f.order).toEqual(["begin"]);
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.observed).toEqual([]);
  });

  test.each(failures)(
    "%s failure never announces a committed tap",
    async (failure) => {
      const f = fixture(failure);
      await expect(
        commitOwnerAssembly(f.database, event, async () => ({
          value: "value",
          changed: true,
        })),
      ).rejects.toThrow(
        failure === "insert"
          ? "INSERT_FAILED"
          : failure === "commit"
            ? "COMMIT_FAILED"
            : "COMMIT_OUTCOME_UNKNOWN",
      );
      expect(f.observed).toEqual([]);
      expect(f.order).not.toContain("resolved");
    },
  );

  test("a throwing tap cannot undo success or stop other committed taps", async () => {
    const f = fixture();
    cleanups.push(
      addAuditTap(() => {
        throw new Error("unit tap failure");
      }),
    );
    const later: AuditTapEvent[] = [];
    cleanups.push(addAuditTap((row) => later.push(row)));
    const error = spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => error.mockRestore());
    expect(
      await commitOwnerAssembly(f.database, event, async () => ({
        value: 42,
        changed: true,
      })),
    ).toBe(42);
    expect(f.observed).toHaveLength(1);
    expect(later).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      type: "audit-tap-failed",
      eventType: "configuration.changed",
    });
  });
});
