import { and, eq, like } from "drizzle-orm";
import { STAFFING_TOOL_NAMES } from "../../../shared/staffing-proposal";
import type { Database } from "../db/client";
import { agents } from "../db/schema/core";
import { pluginGrants } from "../db/schema/plugins";
import { currentTenant } from "../tenant/context";
import { avatarAgentId } from "../tenant/provisioning";

/**
 * 小管家（`avatar-<人>`）默认会招人、组群：「招聘与组群」的六个工具默认授予它，不用人去插件页逐个勾。
 *
 * 这个默认只给小管家，不给别的员工：别的员工要不要有，由招它的人在提议里写（`staffingTools`）。
 * 授予只改「它持有什么」；起草本身只写提议表，真正建员工、建群要本人在卡片上确认，所以默认授予不改
 * 任何一道门。
 */
export const STAFFING_DEFAULT_BY = "openbot:staffing-default";

/** 授予 ref 的前缀；与 `executor.ts` 给新员工授予时同一个形状。 */
const STAFFING_REF_PREFIX = "staffing/";

/** 六个工具的授予 ref，如 `staffing/propose_employee`。 */
export const STAFFING_REFS: readonly string[] = STAFFING_TOOL_NAMES.map(
  (tool) => `${STAFFING_REF_PREFIX}${tool}`,
);

/**
 * 新开通分身时与分身一起写下的授予行。开通在这个人自己的帧里写（`provisionTenant`），所以只用行，不经
 * 插件库；已有的行不动（`ON CONFLICT DO NOTHING`）。
 */
export function staffingGrantRows(avatarId: string, tenantId: string) {
  return STAFFING_REFS.map((ref) => ({
    tenantId,
    kind: "mcp" as const,
    ref,
    agentId: avatarId,
    grantedBy: STAFFING_DEFAULT_BY,
    grantedAs: "owner" as const,
  }));
}

type GrantStore = {
  grant(
    kind: "mcp" | "skill",
    ref: string,
    agentId: string,
    by: string,
    options?: { as?: "admin" | "owner" },
  ): Promise<void>;
};

/**
 * 把六个工具给一位分身。同一个工具已有授予时不动它（主人的授予不覆盖管理员的，也不重复进轨迹），所以
 * 重复调用不会多出行。
 */
export async function grantStaffingToAvatar(
  store: GrantStore,
  avatarId: string,
): Promise<void> {
  for (const ref of STAFFING_REFS)
    await store.grant("mcp", ref, avatarId, STAFFING_DEFAULT_BY, {
      as: "owner",
    });
}

export type StaffingBackfillDeps = {
  store: GrantStore;
  /** 这一帧里看得见、可以补授的分身：只有这个人自己的那一位。 */
  avatars(): Promise<string[]>;
  /** 这位分身已持有的 `staffing/*` 授予行数，不论谁授予的。 */
  held(avatarId: string): Promise<number>;
  /** 这位分身上被 SEC1 禁用的工具（`approvalService.disabledTools`）。 */
  disabled(avatarId: string): Promise<(toolRef: string) => boolean>;
  /** 在这个人自己的帧里做；不给时在调用方当前的帧里做。 */
  asPerson?: <T>(work: () => Promise<T>) => Promise<T>;
};

/**
 * 升级时给已有的分身补授。逐人在他自己的帧里做（沿用 `ensureAlwaysOnApp` 已有的循环与帧，不开新的出帧门）。
 *
 * 已经持有任何 `staffing/*` 行的不动：那是人或管理员已经做过决定。本人用「禁用」关掉过其中任何一个的
 * 也不动：关掉的开关一直优先。
 *
 * @returns 这次补授了几位分身
 */
export async function backfillStaffingForAvatars(
  deps: StaffingBackfillDeps,
): Promise<number> {
  const work = async () => {
    let granted = 0;
    for (const avatarId of await deps.avatars()) {
      if ((await deps.held(avatarId)) > 0) continue;
      const disabled = await deps.disabled(avatarId);
      if (STAFFING_REFS.some((ref) => disabled(ref))) continue;
      await grantStaffingToAvatar(deps.store, avatarId);
      granted += 1;
    }
    return granted;
  };
  return deps.asPerson ? deps.asPerson(work) : work();
}

/** 读库的那几件：分身是这一帧的人自己的那一位，持有数读 `plugin_grants`。 */
export function staffingBackfillDeps(
  database: Pick<Database, "select">,
  input: Pick<StaffingBackfillDeps, "store" | "disabled" | "asPerson">,
): StaffingBackfillDeps {
  return {
    ...input,
    avatars: async () => {
      const id = avatarAgentId(currentTenant());
      const rows = await database
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, id));
      return rows.map((row) => row.id);
    },
    held: async (avatarId) =>
      (
        await database
          .select({ ref: pluginGrants.ref })
          .from(pluginGrants)
          .where(
            and(
              eq(pluginGrants.kind, "mcp"),
              eq(pluginGrants.agentId, avatarId),
              like(pluginGrants.ref, `${STAFFING_REF_PREFIX}%`),
            ),
          )
      ).length,
  };
}
