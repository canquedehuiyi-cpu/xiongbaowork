import { describe, expect, test } from "bun:test";
import { is, SQL } from "drizzle-orm";
import { bigint, getTableConfig, pgTable, PgDialect } from "drizzle-orm/pg-core";
import {
  approvalContinuations,
  approvalContinuationSteps,
} from "../src/db/schema/approvals";

// CPU metadata/driver conversion assertions only. No connection, migration,
// transaction, producer authority, COMMIT or receipt is supplied by this file.
const models = [
  {
    table: approvalContinuations,
    name: "approval_continuations",
    fenceCheck: "approval_continuations_fence_check",
  },
  {
    table: approvalContinuationSteps,
    name: "approval_continuation_steps",
    fenceCheck: "approval_continuation_steps_fence_check",
  },
] as const;

describe("approval fence defaults remain serializable SQL bigint zero", () => {
  for (const { table, name, fenceCheck } of models) {
    test(`${name} compiles its default to literal zero without a bigint parameter`, () => {
      const fence = table.fence;
      expect(fence.getSQLType()).toBe("bigint");
      expect(fence.dataType).toBe("bigint");
      expect(fence.notNull).toBe(true);
      expect(fence.hasDefault).toBe(true);
      expect(fence.defaultFn).toBeUndefined();
      const expression = fence.default;
      expect(is(expression, SQL)).toBe(true);
      if (!is(expression, SQL)) throw new Error("fence default must be SQL");
      const compiled = new PgDialect().sqlToQuery(expression);
      expect(compiled.sql).toBe("0");
      expect(compiled.params).toEqual([]);
      // The Kit SQL-default branch records this SQL text rather than a native
      // bigint. This assertion is not a substitute for running drizzle-kit.
      expect(JSON.stringify({ default: compiled.sql })).toBe('{"default":"0"}');
    });

    test(`${name} still reads exact bigint values beyond Number precision`, () => {
      expect(table.fence.mapFromDriverValue("0")).toBe(0n);
      expect(table.fence.mapFromDriverValue("9007199254740993")).toBe(
        9007199254740993n,
      );
      expect(table.fence.mapFromDriverValue("9223372036854775807")).toBe(
        9223372036854775807n,
      );
    });

    test(`${name} retains its fence check and closed RLS metadata`, () => {
      const config = getTableConfig(table);
      expect(config.name).toBe(name);
      expect(config.enableRLS).toBe(true);
      expect(config.policies).toEqual([]);
      const check = config.checks.find((value) => value.name === fenceCheck);
      expect(check).toBeDefined();
      if (!check) throw new Error("fence nonnegative check missing");
      const compiled = new PgDialect().sqlToQuery(check.value);
      expect(compiled.sql).toContain('"fence" >= 0');
      expect(compiled.params).toEqual([]);
      // Metadata presence is not evidence that a live database enforced RLS or
      // rejected a negative value. PG and migration acceptance remain pending.
    });
  }

  test("a native bigint default reproduces the JSON boundary the SQL default avoids", () => {
    const before = pgTable("approval_fence_default_negative_control", {
      fence: bigint("fence", { mode: "bigint" }).notNull().default(0n),
    });
    expect(typeof before.fence.default).toBe("bigint");
    expect(() => JSON.stringify({ default: before.fence.default })).toThrow(
      TypeError,
    );
  });
});
