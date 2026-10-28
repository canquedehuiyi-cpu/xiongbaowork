import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  applyConfiguredAdmin,
  initializeRoleWriter,
  isConfiguredAdmin,
  roleForEmail,
  seedRole,
  setRole,
  stopRoleWriter,
} from "../src/auth/roles";
import type { Database } from "../src/db/client";

describe("roleForEmail", () => {
  test("assigns an admin role to allowlisted addresses without case sensitivity", () => {
    expect(roleForEmail("Admin@OpenBot.test", ["admin@openbot.test"])).toBe(
      "admin",
    );
  });

  test("assigns the user role to addresses outside the initial admin allowlist", () => {
    expect(roleForEmail("member@openbot.test", ["admin@openbot.test"])).toBe(
      "user",
    );
  });
});

/**
 * Bringing a role in line with the administrator list, on a fake that records the statements.
 *
 * A real database would test Drizzle. What matters here is the shape of the write: `user_roles` is
 * a set with a `(user_id, role)` primary key and the guard takes `admin` if any row says so, so
 * reconciling has to remove the rows that should not be there rather than only adding one. Insert
 * alone is what the old create-time hook did, and it could promote but never demote.
 */
type Statement = { kind: "delete" | "insert"; role: string };

/** These rows are unit doubles only; real PG permission assertions live in the integration suite. */
const unitRoleFacts = {
  role: "openbot_app",
  session_role: "openbot_app",
  login_role: "openbot_app",
  can_login: true,
  database: "unit",
  database_oid: "1",
  server_address: "127.0.0.1",
  server_port: 5432,
  super: false,
  bypass: false,
  create_role: false,
  create_database: false,
  owns_authority_table: false,
  owns_public_relation: false,
  owns_database: false,
  owns_public_schema: false,
  owns_authority_function: false,
  owns_public_function: false,
  inherits: false,
  member_of_role: false,
  reads_roles: true,
  role_column_writes: false,
  other_role_column_rights: false,
  inserts_roles: false,
  deletes_roles: false,
  other_role_rights: false,
  creates_public: false,
  other_public_rights: false,
  role_grant_options: false,
  role_column_grant_options: false,
  other_role_grant_options: false,
  other_role_column_grant_options: false,
  schema_grant_options: false,
  database_grant_options: false,
  other_public_grant_options: false,
  writer_member: false,
};

async function initializeRecordingRoleWriter(
  database: Database,
): Promise<void> {
  const writer = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "execute")
        return async () => [
          {
            ...unitRoleFacts,
            role: "openbot_role_writer",
            session_role: "openbot_role_writer",
            login_role: "openbot_role_writer",
            inserts_roles: true,
            deletes_roles: true,
            role_column_writes: true,
          },
        ];
      return Reflect.get(target, property, receiver);
    },
  });
  await initializeRoleWriter(database, writer);
}

function recordingDatabase(beforeInsert: Promise<void> = Promise.resolve()): {
  database: Database;
  statements: Statement[];
  operations: string[];
} {
  const statements: Statement[] = [];
  const operations: string[] = [];
  const tx = {
    execute: async (statement: SQL) => {
      const query = new PgDialect().sqlToQuery(statement);
      expect(query.sql).toContain("pg_advisory_xact_lock");
      expect(query.params).toEqual(["openbot.role-authority:u1"]);
      operations.push("lock");
      return [];
    },
    delete: () => ({
      where: (condition: unknown) => {
        // The condition carries the role being kept; what is asserted is that a delete happened at
        // all and that the insert which follows names the same role.
        void condition;
        operations.push("delete");
        statements.push({ kind: "delete", role: "" });
        return Promise.resolve();
      },
    }),
    insert: () => ({
      values: (row: { role: string }) => ({
        onConflictDoNothing: async () => {
          await beforeInsert;
          operations.push("insert");
          statements.push({ kind: "insert", role: row.role });
          return Promise.resolve();
        },
      }),
    }),
  };

  const database = {
    execute: async () => [unitRoleFacts],
    transaction: async (run: (t: typeof tx) => Promise<void>) => {
      await run(tx);
    },
  } as unknown as Database;

  return { database, statements, operations };
}

describe("setRole", () => {
  test("replaces the set rather than adding to it", async () => {
    const { database, statements } = recordingDatabase();
    await initializeRecordingRoleWriter(database);

    const role = await setRole(database, "u1", "admin");

    expect(role).toBe("admin");
    expect(statements).toEqual([
      { kind: "delete", role: "" },
      { kind: "insert", role: "admin" },
    ]);
  });

  /**
   * Demotion has to remove the `admin` row, because the guard reads the set and one leftover row
   * keeps somebody an administrator for ever.
   */
  test("removes the admin row when setting somebody back to user", async () => {
    const { database, statements } = recordingDatabase();
    await initializeRecordingRoleWriter(database);

    const role = await setRole(database, "u1", "user");

    expect(role).toBe("user");
    expect(statements).toEqual([
      { kind: "delete", role: "" },
      { kind: "insert", role: "user" },
    ]);
  });

  // Both statements together or neither: between them a request on another process would find no
  // row and be refused with a 403 that reads as a permissions bug rather than a race.
  test("writes both statements inside one transaction", async () => {
    let transactions = 0;
    const database = {
      execute: async () => [unitRoleFacts],
      transaction: async (run: (t: unknown) => Promise<void>) => {
        transactions += 1;
        await run({
          execute: async () => [],
          delete: () => ({ where: () => Promise.resolve() }),
          insert: () => ({
            values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
          }),
        });
      },
    } as unknown as Database;

    await initializeRecordingRoleWriter(database);
    await setRole(database, "u1", "admin");

    expect(transactions).toBe(1);
  });
});

/**
 * The configured floor, applied at every sign-in.
 *
 * This is the half that has to coexist with an admin screen. `INITIAL_ADMIN_EMAILS` guarantees a way
 * back in, so an address it names is promoted whenever they sign in; everybody else's role belongs
 * to whoever administers the deployment, and a sign-in that rewrote it would make that screen lie
 * the moment they came back.
 */
function databaseWithUser(
  email: string | null,
  /**
   * Whether this person is already an administrator.
   *
   * `applyConfiguredAdmin` reads it so it can answer whether this sign-in is what granted the role.
   * The caller writes an audit row when it did, and a returning administrator must not produce one
   * on every sign-in.
   */
  alreadyAdmin = false,
): {
  database: Database;
  written: string[];
} {
  const written: string[] = [];
  const database = {
    execute: async () => [unitRoleFacts],
    // Two different reads go through here: the user's address, and whether they already hold the
    // role. Told apart by the projection, because that is the only thing the double can see.
    select: (projection?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (projection && "role" in projection) {
              return alreadyAdmin ? [{ role: "admin" }] : [];
            }
            return email === null ? [] : [{ email }];
          },
        }),
      }),
    }),
    transaction: async (run: (t: unknown) => Promise<void>) => {
      await run({
        execute: async () => [],
        delete: () => ({ where: () => Promise.resolve() }),
        insert: () => ({
          values: (row: { role: string }) => ({
            onConflictDoNothing: () => {
              written.push(row.role);
              return Promise.resolve();
            },
          }),
        }),
      });
    },
  } as unknown as Database;

  return { database, written };
}

describe("applyConfiguredAdmin", () => {
  test("promotes an address the deployment names", async () => {
    const { database, written } = databaseWithUser("admin@openbot.test");
    await initializeRecordingRoleWriter(database);

    await applyConfiguredAdmin(database, "u1", ["admin@openbot.test"]);

    expect(written).toEqual(["admin"]);
  });

  /*
   * Whether this sign-in is what granted the role.
   *
   * The floor is re-applied silently on every sign-in, which meant anybody who could edit
   * `INITIAL_ADMIN_EMAILS` made themselves an administrator with nothing anywhere recording it. The
   * caller writes the audit row, and it needs to know which sign-in did it, or every sign-in by
   * every administrator would produce one and the row would say nothing.
   */
  test("says so when this sign-in is what granted the role", async () => {
    const { database } = databaseWithUser("admin@openbot.test");
    await initializeRecordingRoleWriter(database);

    expect(
      await applyConfiguredAdmin(database, "u1", ["admin@openbot.test"]),
    ).toBe(true);
  });

  test("says nothing when they were already an administrator", async () => {
    const { database } = databaseWithUser("admin@openbot.test", true);
    await initializeRecordingRoleWriter(database);

    expect(
      await applyConfiguredAdmin(database, "u1", ["admin@openbot.test"]),
    ).toBe(false);
  });

  test("says nothing for somebody the configuration does not name", async () => {
    const { database } = databaseWithUser("member@openbot.test");
    await initializeRecordingRoleWriter(database);

    expect(
      await applyConfiguredAdmin(database, "u1", ["admin@openbot.test"]),
    ).toBe(false);
  });

  test("says nothing when nothing is configured", async () => {
    const { database } = databaseWithUser("admin@openbot.test");
    await initializeRecordingRoleWriter(database);

    expect(await applyConfiguredAdmin(database, "u1", [])).toBe(false);
  });

  /**
   * The reason this is a floor and not the whole answer.
   *
   * Somebody promoted from the admin screen is not on the list, and rewriting their role here would
   * silently undo that promotion the next time they signed in.
   */
  test("leaves everybody else exactly as the admin screen set them", async () => {
    const { database, written } = databaseWithUser("member@openbot.test");
    await initializeRecordingRoleWriter(database);

    await applyConfiguredAdmin(database, "u1", ["admin@openbot.test"]);

    expect(written).toEqual([]);
  });

  test("writes nothing when the deployment names nobody", async () => {
    const { database, written } = databaseWithUser("admin@openbot.test");
    await initializeRecordingRoleWriter(database);

    await applyConfiguredAdmin(database, "u1", []);

    expect(written).toEqual([]);
  });

  test("does nothing for a session whose user is not there", async () => {
    const { database, written } = databaseWithUser(null);
    await initializeRecordingRoleWriter(database);

    await applyConfiguredAdmin(database, "u1", ["admin@openbot.test"]);

    expect(written).toEqual([]);
  });
});

describe("seedRole", () => {
  test("starts an address on the list as an administrator", async () => {
    const { database, written } = databaseWithUser("admin@openbot.test");
    await initializeRecordingRoleWriter(database);

    await seedRole(database, "u1", "admin@openbot.test", [
      "admin@openbot.test",
    ]);

    expect(written).toEqual(["admin"]);
  });

  test("starts everybody else as a user", async () => {
    const { database, written } = databaseWithUser("member@openbot.test");
    await initializeRecordingRoleWriter(database);

    await seedRole(database, "u1", "member@openbot.test", [
      "admin@openbot.test",
    ]);

    expect(written).toEqual(["user"]);
  });
});

describe("isConfiguredAdmin", () => {
  test("ignores case and surrounding space, on both sides", () => {
    expect(
      isConfiguredAdmin("  Admin@OpenBot.test ", [" admin@openbot.TEST "]),
    ).toBe(true);
  });
});

describe("restricted role writer binding", () => {
  test("an uninitialized application cannot write a role", async () => {
    const { database, statements } = recordingDatabase();
    await expect(setRole(database, "u1", "admin")).rejects.toThrow(
      "not initialized",
    );
    expect(statements).toEqual([]);
  });

  test("the application connection cannot register itself as the writer", async () => {
    const { database } = recordingDatabase();
    await expect(initializeRoleWriter(database, database)).rejects.toThrow(
      "distinct role writer",
    );
  });

  test("a registered application cannot replace its role writer", async () => {
    const { database } = recordingDatabase();
    await initializeRecordingRoleWriter(database);
    await expect(initializeRecordingRoleWriter(database)).rejects.toThrow(
      "exactly once",
    );
  });
});

describe("role writer shutdown", () => {
  test("seals new writes and joins the already-admitted transaction", async () => {
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { database, statements } = recordingDatabase(barrier);
    await initializeRecordingRoleWriter(database);
    const work = setRole(database, "u1", "admin");
    let settled = false;
    const finishing = stopRoleWriter(database);
    const observed = finishing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(setRole(database, "u2", "admin")).rejects.toThrow("closing");
    release();
    await work;
    await observed;
    expect(settled).toBe(true);
    expect(
      statements.filter((statement) => statement.kind === "insert"),
    ).toEqual([{ kind: "insert", role: "admin" }]);
    expect(stopRoleWriter(database)).toBe(finishing);
  });

  test("keeps the original write rejection and reports the drain failure", async () => {
    let rejectWrite: (reason: unknown) => void = () => {};
    const barrier = new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    });
    const { database } = recordingDatabase(barrier);
    await initializeRecordingRoleWriter(database);
    const work = setRole(database, "u1", "admin");
    const finishing = stopRoleWriter(database);
    const original = new Error("unit role write refused");
    const checkWrite = work.catch((error: unknown) => error);
    const checkDrain = finishing.catch((error: unknown) => error);
    rejectWrite(original);
    expect(await checkWrite).toBe(original);
    expect(await checkDrain).toBeInstanceOf(AggregateError);
    await expect(setRole(database, "u2", "user")).rejects.toThrow("closing");
  });
});

describe("restricted role writer fail-closed facts (CPU only)", () => {
  function withFacts(
    facts: Record<string, unknown> | undefined,
    membership: Record<string, unknown> | null = { writer_member: false },
  ) {
    const { database } = recordingDatabase();
    let reads = 0;
    return new Proxy(database, {
      get(target, property, receiver) {
        if (property === "execute")
          return async () => {
            const row = reads++ === 0 ? facts : membership;
            return row ? [row] : [];
          };
        return Reflect.get(target, property, receiver);
      },
    });
  }
  const writerFacts = {
    ...unitRoleFacts,
    role: "openbot_role_writer",
    session_role: "openbot_role_writer",
    login_role: "openbot_role_writer",
    inserts_roles: true,
    deletes_roles: true,
    role_column_writes: true,
  };
  const invalid: {
    name: string;
    side: "app" | "writer";
    patch: Record<string, unknown>;
  }[] = [
    { name: "app superuser", side: "app", patch: { super: true } },
    { name: "app bypass RLS", side: "app", patch: { bypass: true } },
    { name: "app writes roles", side: "app", patch: { inserts_roles: true } },
    {
      name: "app column write grant",
      side: "app",
      patch: { role_column_writes: true },
    },
    {
      name: "app role membership",
      side: "app",
      patch: { member_of_role: true },
    },
    {
      name: "app authority owner",
      side: "app",
      patch: { owns_authority_table: true },
    },
    { name: "app SET ROLE", side: "app", patch: { session_role: "other" } },
    { name: "writer NOLOGIN", side: "writer", patch: { can_login: false } },
    { name: "writer bypass RLS", side: "writer", patch: { bypass: true } },
    {
      name: "writer other public rights",
      side: "writer",
      patch: { other_public_rights: true },
    },
    {
      name: "writer schema owner",
      side: "writer",
      patch: { owns_public_schema: true },
    },
    {
      name: "writer inherited grants",
      side: "writer",
      patch: { inherits: true },
    },
    {
      name: "writer excess column rights",
      side: "writer",
      patch: { other_role_column_rights: true },
    },
    {
      name: "writer missing DELETE",
      side: "writer",
      patch: { deletes_roles: false },
    },
    {
      name: "different database",
      side: "writer",
      patch: { database_oid: "2" },
    },
    {
      name: "different server",
      side: "writer",
      patch: { server_address: "127.0.0.2" },
    },
    { name: "unknown server", side: "writer", patch: { server_address: null } },
  ];
  test.each(invalid)(
    "rejects $name without installing a binding",
    async ({ side, patch }) => {
      const app = withFacts({
        ...unitRoleFacts,
        ...(side === "app" ? patch : {}),
      });
      const writer = withFacts({
        ...writerFacts,
        ...(side === "writer" ? patch : {}),
      });
      await expect(initializeRoleWriter(app, writer)).rejects.toThrow(
        "restricted authority contract",
      );
      await expect(setRole(app, "u1", "admin")).rejects.toThrow(
        "not initialized",
      );
    },
  );
  test.each([undefined, {}, { writer_member: true }])(
    "unknown or granted membership %p refuses",
    async (membership) => {
      // Explicit undefined must produce a missing row, not the helper's default.
      const app = withFacts({ ...unitRoleFacts }, membership ?? null);
      const writer = withFacts({ ...writerFacts });
      await expect(initializeRoleWriter(app, writer)).rejects.toThrow(
        "must not be a member",
      );
    },
  );
  test("an absent facts row refuses", async () => {
    await expect(
      initializeRoleWriter(withFacts(undefined), withFacts(writerFacts)),
    ).rejects.toThrow("restricted authority contract");
  });
  test("locks before deleting and inserting inside the writer transaction", async () => {
    const { database, operations } = recordingDatabase();
    await initializeRecordingRoleWriter(database);
    await setRole(database, "u1", "user");
    expect(operations).toEqual(["lock", "delete", "insert"]);
  });
  test("concurrent initialization refuses a second binding while facts are pending", async () => {
    const { database } = recordingDatabase();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "execute")
          return async () => {
            await held;
            return [unitRoleFacts];
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const writer = withFacts(writerFacts);
    const first = initializeRoleWriter(app, writer);
    await expect(initializeRoleWriter(app, writer)).rejects.toThrow(
      "exactly once",
    );
    release();
    await first;
  });
  test("an unknown COMMIT preserves the write rejection and keeps shutdown failed", async () => {
    const { database, operations } = recordingDatabase();
    const original = new Error("unit COMMIT outcome UNKNOWN");
    let rejectCommit: (error: unknown) => void = () => {};
    let entered = () => {};
    const atCommit = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const commit = new Promise<void>((_resolve, reject) => {
      rejectCommit = reject;
    });
    const writer = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "execute") return async () => [writerFacts];
        if (property === "transaction")
          return async (...args: Parameters<Database["transaction"]>) => {
            await target.transaction(...args);
            entered();
            await commit;
          };
        return Reflect.get(target, property, receiver);
      },
    });
    await initializeRoleWriter(database, writer);
    const work = setRole(database, "u1", "admin");
    const observedWork = work.catch((error: unknown) => error);
    await atCommit;
    const stopping = stopRoleWriter(database);
    const observedStop = stopping.catch((error: unknown) => error);
    await expect(setRole(database, "u1", "user")).rejects.toThrow("closing");
    rejectCommit(original);
    expect(await observedWork).toBe(original);
    expect(await observedStop).toBeInstanceOf(AggregateError);
    expect(operations).toEqual(["lock", "delete", "insert"]);
  });
  const delegationFields = [
    "role_grant_options",
    "role_column_grant_options",
    "other_role_grant_options",
    "other_role_column_grant_options",
    "schema_grant_options",
    "database_grant_options",
    "other_public_grant_options",
  ];
  const delegationCases = delegationFields.flatMap((field) =>
    ["app", "writer"].flatMap((side) =>
      [true, null, undefined].map((value) => ({ field, side, value })),
    ),
  );
  test.each(delegationCases)(
    "rejects $side $field=$value",
    async ({ field, side, value }) => {
      const app = withFacts({
        ...unitRoleFacts,
        ...(side === "app" ? { [field]: value } : {}),
      });
      const writer = withFacts({
        ...writerFacts,
        ...(side === "writer" ? { [field]: value } : {}),
      });
      await expect(initializeRoleWriter(app, writer)).rejects.toThrow(
        "restricted authority contract",
      );
      await expect(setRole(app, "u1", "admin")).rejects.toThrow(
        "not initialized",
      );
    },
  );
  test.each([
    {
      privilege: "table INSERT WITH GRANT OPTION",
      field: "role_grant_options",
    },
    {
      privilege: "table DELETE WITH GRANT OPTION",
      field: "role_grant_options",
    },
    {
      privilege: "column INSERT WITH GRANT OPTION",
      field: "role_column_grant_options",
    },
    { privilege: "user_roles MAINTAIN", field: "other_role_rights" },
    { privilege: "other public MAINTAIN", field: "other_public_rights" },
  ])("rejects writer $privilege", async ({ field }) => {
    await expect(
      initializeRoleWriter(
        withFacts(unitRoleFacts),
        withFacts({ ...writerFacts, [field]: true }),
      ),
    ).rejects.toThrow("restricted authority contract");
  });
  test("PG17 query includes table/column grant options and MAINTAIN without omitting public object kinds", async () => {
    const { database } = recordingDatabase();
    const app = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "execute")
          return async (statement: SQL) => {
            const query = new PgDialect().sqlToQuery(statement).sql;
            if (query.includes("FROM pg_catalog.pg_roles")) {
              expect(query).toContain(
                "SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,DELETE WITH GRANT OPTION",
              );
              expect(query).toContain(
                "SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION'",
              );
              expect(query).toContain(
                "UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION",
              );
              expect(query).toContain("MAINTAIN WITH GRANT OPTION");
              expect(query).toContain(
                "UPDATE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN",
              );
              for (const inquiry of [
                "has_sequence_privilege",
                "has_function_privilege",
                "has_type_privilege",
                "has_schema_privilege",
                "has_database_privilege",
              ])
                expect(query).toContain(inquiry);
            }
            return [unitRoleFacts];
          };
        return Reflect.get(target, property, receiver);
      },
    });
    await initializeRoleWriter(app, withFacts(writerFacts));
  });
});
