import { and, eq, like } from "drizzle-orm";
import type { Database } from "../db/client";
import { enterpriseSettings } from "../db/schema/admin";
import { agents } from "../db/schema/core";
import { pluginGrants } from "../db/schema/plugins";
import { currentEdition } from "../edition";
import { currentTenant } from "../tenant/context";
import {
  avatarAgentId,
  STAFFING_DEFAULT_BY,
  STAFFING_REFS,
  staffingDefaultAllowed,
  staffingGivenSetting,
} from "../tenant/provisioning";

export {
  STAFFING_DEFAULT_BY,
  STAFFING_REFS,
  staffingGivenSetting,
  staffingGrantRows,
} from "../tenant/provisioning";

/**
 * 小管家（`avatar-<人>`）默认会招人、组群：「招聘与组群」的六个工具默认授予它，不用人去插件页逐个勾。
 *
 * 这个默认只给小管家，不给别的员工：别的员工要不要有，由招它的人在提议里写（`staffingTools`）。
 * 授予只改「它持有什么」；起草本身只写提议表，真正建员工、建群要本人在卡片上确认，所以默认授予不改
 * 任何一道门。
 *
 * 授予记为主人做的（`owner`）：本人的员工拿到本人的能力，本人可以在权限页收回或禁用。
 */

/** 部署里「招聘与组群」这个应用的目录键。 */
const STAFFING_APP = "staffing";

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
 * 启动时确保部署里有「招聘与组群」这个应用，没有就添加。没有这一行，授予读不到任何工具，调用也找不到服务。
 * 添加应用不授予任何人什么：谁拿到由授予决定。服务器级的事，在调用方的平台帧里做。
 */
/** 部署记得的事：团队版里是否已经添加过一次「招聘与组群」。 */
export type StaffingAppMemory = {
  added(): Promise<boolean>;
  remember(): Promise<void>;
};

/** 记着「已经添加过」的那一行设置；部署的，不属于任何人。 */
export const STAFFING_APP_ADDED_SETTING = "staffing_app_added";

/** 上面的记忆，从数据库来（同 `personalDefaultAppsMemory`）；调用方在平台帧里用它。 */
export function staffingAppMemory(
  database: Pick<Database, "select" | "insert">,
): StaffingAppMemory {
  return {
    async added() {
      const [row] = await database
        .select({ key: enterpriseSettings.key })
        .from(enterpriseSettings)
        .where(eq(enterpriseSettings.key, STAFFING_APP_ADDED_SETTING))
        .limit(1);
      return row !== undefined;
    },
    async remember() {
      await database
        .insert(enterpriseSettings)
        .values({
          key: STAFFING_APP_ADDED_SETTING,
          value: { value: true },
          updatedBy: STAFFING_DEFAULT_BY,
        })
        .onConflictDoNothing();
    },
  };
}

/**
 * 团队版：只在第一次启动时添加，并记下添加过（只在应用行已经在之后才记，写行之前失败的启动下次再试）。
 * 之后管理员删掉它就是删掉了，下一次启动不会加回来——应用开不开是管理员的事（同个人版的默认应用
 * `ensurePersonalDefaultApps`）。个人版没有管理员，它和 Routines 一样一直在。不给记忆的调用方每次都补。
 */
export async function ensureStaffingServer(
  store: {
    serverAddress(serverId: string): Promise<unknown>;
    addServer(input: { key: string; by: string }): Promise<unknown>;
  },
  memory?: StaffingAppMemory,
): Promise<void> {
  const once = memory !== undefined && currentEdition() !== "personal";
  if (once && (await memory.added())) return;
  if (!(await store.serverAddress(STAFFING_APP)))
    await store.addServer({ key: STAFFING_APP, by: STAFFING_DEFAULT_BY });
  if (once) await memory.remember();
}

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
  /** 此刻能不能替这个人给（`staffingDefaultAllowed`）；不能时什么都不做、也不记下处理过。 */
  allowed(): Promise<boolean>;
  /** 这位分身已持有的 `staffing/*` 授予行数，不论谁授予的。 */
  held(avatarId: string): Promise<number>;
  /** 这位分身上被 SEC1 禁用的工具（`approvalService.disabledTools`）。 */
  disabled(avatarId: string): Promise<(toolRef: string) => boolean>;
  /** 这位分身是否已经处理过一次默认授予。 */
  given(avatarId: string): Promise<boolean>;
  /** 记下处理过了，之后本人收回的不再补回来。 */
  remember(avatarId: string): Promise<void>;
  /** 在这个人自己的帧里做；不给时在调用方当前的帧里做。 */
  asPerson?: <T>(work: () => Promise<T>) => Promise<T>;
};

/**
 * 给还没处理过的分身补授，每位只处理一次。逐人在他自己的帧里做，不开新的出帧门。
 *
 * 已经持有任何 `staffing/*` 行的不给：那是人或管理员已经做过决定。本人用「禁用」关掉过其中任何一个的
 * 也不给：关掉的开关一直优先。这两种也记下处理过了；授予之后同样记下，所以本人之后收回的不会回来。
 *
 * @returns 这次补授了几位分身
 */
export async function backfillStaffingForAvatars(
  deps: StaffingBackfillDeps,
): Promise<number> {
  const work = async () => {
    let granted = 0;
    const avatars: string[] = [];
    for (const avatarId of await deps.avatars())
      if (!(await deps.given(avatarId))) avatars.push(avatarId);
    // 还有没处理过的分身时才问：管理员删掉或收归自己时不给，也不记下，放开之后的下一次读取再补。
    if (avatars.length === 0 || !(await deps.allowed())) return 0;
    for (const avatarId of avatars) {
      const disabled = await deps.disabled(avatarId);
      const keep =
        (await deps.held(avatarId)) > 0 ||
        STAFFING_REFS.some((ref) => disabled(ref));
      if (!keep) {
        await grantStaffingToAvatar(deps.store, avatarId);
        granted += 1;
      }
      await deps.remember(avatarId);
    }
    return granted;
  };
  return deps.asPerson ? deps.asPerson(work) : work();
}

/** 读库的那几件：分身是这一帧的人自己的那一位，持有数读 `plugin_grants`，处理过与否读一行设置。 */
export function staffingBackfillDeps(
  database: Pick<Database, "select" | "insert">,
  input: Pick<StaffingBackfillDeps, "store" | "disabled" | "asPerson">,
): StaffingBackfillDeps {
  return {
    ...input,
    allowed: () => staffingDefaultAllowed(database, currentTenant()),
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
              like(pluginGrants.ref, "staffing/%"),
            ),
          )
      ).length,
    given: async (avatarId) => {
      const [row] = await database
        .select({ key: enterpriseSettings.key })
        .from(enterpriseSettings)
        .where(eq(enterpriseSettings.key, staffingGivenSetting(avatarId)))
        .limit(1);
      return row !== undefined;
    },
    remember: async (avatarId) => {
      await database
        .insert(enterpriseSettings)
        .values({
          key: staffingGivenSetting(avatarId),
          value: { value: true },
          updatedBy: STAFFING_DEFAULT_BY,
        })
        .onConflictDoNothing();
    },
  };
}

/**
 * 小管家第一次被读取授予（每次运行都会）时，在这个人自己的帧里补上默认的招聘能力，两个版本都一样。
 * 已有的分身、单用户安装的分身、升级上来的分身都经过这一刻，不需要跨租户地找谁；只在这一帧的人读自己
 * 的分身时做，别的员工和别的帧什么也不做。
 *
 * 失败只记一条警告，运行照常拿到它已经持有的，下一次再补。
 */
export function withStaffingDefault<
  S extends GrantStore & {
    listForAgent(agentId: string): Promise<unknown>;
  },
>(
  store: S,
  input: Omit<Parameters<typeof staffingBackfillDeps>[1], "store"> & {
    database: Pick<Database, "select" | "insert">;
  },
): S {
  const list = store.listForAgent;
  store.listForAgent = async function (this: S, agentId: string) {
    let own = false;
    try {
      own = agentId === avatarAgentId(currentTenant());
    } catch {
      own = false;
    }
    if (own)
      await backfillStaffingForAvatars(
        staffingBackfillDeps(input.database, {
          store: this,
          disabled: input.disabled,
          ...(input.asPerson ? { asPerson: input.asPerson } : {}),
        }),
      ).catch((error: unknown) =>
        console.warn(
          JSON.stringify({
            type: "staffing-default-grant-failed",
            bot: agentId,
            reason: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          }),
        ),
      );
    return list.call(this, agentId);
  } as S["listForAgent"];
  return store;
}
