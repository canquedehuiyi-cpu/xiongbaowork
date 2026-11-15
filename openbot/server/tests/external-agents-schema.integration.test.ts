import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  acpTurns,
  agents,
  devicePairCodes,
  registeredDevices,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 外部员工（迁移 0215）：`device_acp` 员工类型、设备认主两列、ACP 轮次表 `acp_turns`。
 * 真库；每个用例用自己的租户，互不依赖先后。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = `ext-${randomUUID().slice(0, 8)}`;
const people: string[] = [];
const agentIds: string[] = [];

afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(acpTurns).where(inArray(acpTurns.tenantId, people));
    await database
      .delete(registeredDevices)
      .where(inArray(registeredDevices.tenantId, people));
    await database.delete(agents).where(inArray(agents.id, agentIds));
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});

async function person(): Promise<string> {
  const id = `${suite}-user-${randomUUID()}`;
  people.push(id);
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "External Test" }),
  );
  return id;
}

describe("external agents schema (0215)", () => {
  test("agent_type accepts device_acp", async () => {
    const owner = await person();
    const id = `${suite}-agent-${randomUUID()}`;
    agentIds.push(id);
    await runAsTenant(owner, () =>
      database.insert(agents).values({
        id,
        tenantId: owner,
        name: "Codex on my laptop",
        type: "device_acp",
        configuration: {},
      }),
    );
    const [row] = await runAsTenant(owner, () =>
      database.select().from(agents).where(eq(agents.id, id)),
    );
    expect(row?.type).toBe("device_acp");
  });

  test("acp_turns is tenant-isolated", async () => {
    const a = await person();
    const b = await person();
    const turnId = `turn-${randomUUID()}`;
    await runAsTenant(a, () =>
      database.insert(acpTurns).values({
        tenantId: a,
        agentId: "agent-1",
        threadId: "thread-1",
        deviceId: "device-1",
        turnId,
        status: "queued",
        prompt: [{ type: "text", text: "hi" }],
      }),
    );
    const seenByA = await runAsTenant(a, () =>
      database.select().from(acpTurns).where(eq(acpTurns.turnId, turnId)),
    );
    const seenByB = await runAsTenant(b, () =>
      database.select().from(acpTurns).where(eq(acpTurns.turnId, turnId)),
    );
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]?.lastSeq).toBe(0);
    expect(seenByB).toHaveLength(0);
  });

  test("acp_turns rejects an unknown status", async () => {
    const a = await person();
    await expect(
      (async () =>
        await runAsTenant(a, () =>
          database.insert(acpTurns).values({
            tenantId: a,
            agentId: "agent-1",
            threadId: "thread-1",
            deviceId: "device-1",
            turnId: `turn-${randomUUID()}`,
            status: "bogus",
            prompt: [],
          }),
        ))(),
    ).rejects.toThrow();
  });

  /*
   * 回填在迁移条件下跑：registered_devices 是 FORCE RLS，迁移者带着空的 app.tenant_id 进来、
   * 不一定有 BYPASSRLS。这里以本测试的 NOBYPASSRLS 角色、空租户帧，在一个最后回滚的事务里
   * 执行迁移文件里的那条回填语句，回滚是为了不动别的用例的行。
   */
  test("personal tenants backfill paired_by_user_id under migration conditions", async () => {
    const owner = await person();
    const other = await person();
    const team = `${suite}-team-${randomUUID()}`;
    const sqlText = await readFile(
      join(
        import.meta.dir,
        "../recovery/recovery-20261018-v1/sql/0215_external_agents.sql",
      ),
      "utf8",
    );
    const backfill = sqlText
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .find((s) =>
        /"paired_by_user_id"\s*=\s*"(registered_devices"\.")?tenant_id"/.test(
          s,
        ),
      );
    expect(backfill).toBeDefined();
    const devices = {
      mine: `${suite}-dev-${randomUUID()}`,
      team: `${suite}-dev-${randomUUID()}`,
      claimed: `${suite}-dev-${randomUUID()}`,
    };
    const rollback = new Error("rollback the migration fixture");
    let seen: { frame: unknown; rows: unknown[] } | undefined;
    await expect(
      database.$client.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', 'platform', true)`;
        await tx`insert into registered_devices (tenant_id, device_id, name, token_hash) values (${owner}, ${devices.mine}, 'laptop', 'hash')`;
        await tx`insert into registered_devices (tenant_id, device_id, name, token_hash) values (${team}, ${devices.team}, 'shared', 'hash')`;
        await tx`insert into registered_devices (tenant_id, device_id, name, token_hash, paired_by_user_id) values (${owner}, ${devices.claimed}, 'desk', 'hash', ${other})`;
        // The frame a migrator arrives with.
        await tx`select set_config('app.tenant_id', '', true)`;
        await tx.unsafe(backfill as string);
        const [frame] =
          await tx`select current_setting('app.tenant_id', true) as tenant`;
        await tx`select set_config('app.tenant_id', 'platform', true)`;
        const rows =
          await tx`select device_id, paired_by_user_id from registered_devices where device_id in (${devices.mine}, ${devices.team}, ${devices.claimed}) order by device_id`;
        seen = {
          frame: (frame as { tenant: unknown }).tenant,
          rows: Array.from(rows as ArrayLike<unknown>),
        };
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    // The frame it found is the frame it leaves: a later migration does not inherit `platform`.
    expect(seen?.frame).toBe("");
    const expected = [
      { device_id: devices.mine, paired_by_user_id: owner },
      { device_id: devices.team, paired_by_user_id: null },
      { device_id: devices.claimed, paired_by_user_id: other },
    ].sort((a, b) => a.device_id.localeCompare(b.device_id));
    const rows = [...((seen?.rows ?? []) as Array<{ device_id: string }>)].sort(
      (a, b) => a.device_id.localeCompare(b.device_id),
    );
    expect(rows).toEqual(expected);
  });

  test("device_pair_codes has a nullable minted_by_user_id", async () => {
    const owner = await person();
    const code = `${suite}-${randomUUID().slice(0, 8)}`;
    await runAsTenant(owner, () =>
      database.insert(devicePairCodes).values({
        code,
        tenantId: owner,
        expiresAt: new Date(Date.now() + 60_000),
        mintedByUserId: owner,
      }),
    );
    const [row] = await runAsTenant(owner, () =>
      database
        .select()
        .from(devicePairCodes)
        .where(eq(devicePairCodes.code, code)),
    );
    expect(row?.mintedByUserId).toBe(owner);
    await runAsTenant("platform", () =>
      database.delete(devicePairCodes).where(eq(devicePairCodes.code, code)),
    );
  });
});
