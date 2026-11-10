import type { ApprovalPolicyStore } from "../approvals/types";
import { type AuditStore, recordAuditEvent } from "../audit";
import { withoutStatement } from "../db/query-failure";
import { schemeKind } from "./broker";
import { type BrokerProvider, toolkitOfFor } from "./access";
import {
  type AccountMode,
  type Holder,
  mintDeploymentVendorUserId,
} from "./shared-accounts";
import type { PluginStore } from "./store";

export type AccountModePreview = {
  mode: AccountMode;
  current: AccountMode | null;
  wouldRevoke: { holder: Holder; count: number };
};
export type AccountModeResult =
  | { changed: false; preview: AccountModePreview }
  | { changed: true; revoked: number }
  | { changed: false; failures: { account: string; error: string }[] };

/** 切换被拒绝：不是 broker 应用、不需要账号、部署没有 id。给管理员看的句子。 */
export class AccountModeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountModeRefusedError";
  }
}

/**
 * Personal ⇄ Shared，管理员做一次的决定（上游 `account-mode.ts`，#757，按 fork 改写）。
 *
 * 旧账号在 vendor 处全部撤销成功之前，什么都不变。切到一半的切换会让人们的邮箱挂在一个不再用到它们的应用
 * 上，或者让团队账号挂在一个不再用它的应用上——屏幕上没有任何东西说明的常设授权。所以一次撤销失败就保留
 * 原模式；已经撤销成功的账号的行照常删掉，因为声称一个 vendor 已不再持有的账号，是另一种说谎。
 *
 * 与上游的差异：
 * - 上游切到 Shared 时为每个持有该应用的员工写「共享使用批准」；那张表在 X3 并入。在那之前共享账号闸门对
 *   每个员工都用最严的一档（`./shared-use` 的 `STRICTEST_APPROVAL`：只有员工主人和管理员），所以这里
 *   不写批准、预览里也没有员工列表。
 * - 应用的「写之前先问」团队规则照上游写（`botId: *`、`toolRef: <app>/*`、`effect: write`、`ask`）。
 * - 撤销其他人的连接要跨租户：走 store 里 `removeServer` 的同一道门（`reachEveryPersonOn`），之前先要
 *   管理员能力（`requireServerWriter`）；应用行与团队规则在管理员自己的帧里写。
 * - 审计用 `configuration.changed`（`change: account_mode`），不新增事件类型。
 */
export function createAccountModeSwitch(deps: {
  store: PluginStore;
  teamRules:
    | Pick<
        ApprovalPolicyStore,
        "createTeamRule" | "teamRules" | "revokeTeamRule"
      >
    | undefined;
  deploymentId: string | undefined;
  audit: AuditStore;
  /** 活动的连接应用提供商（X5）；不给时是 Composio。 */
  provider?: BrokerProvider;
}) {
  const { store, teamRules } = deps;

  async function resolve(serverId: string) {
    const address = await store.serverAddress(serverId);
    const toolkit = address
      ? toolkitOfFor(deps.provider ?? "composio", address.url)
      : null;
    const app = toolkit ? await store.appAccount(toolkit) : null;
    if (!toolkit || !app)
      throw new AccountModeRefusedError(
        "这个应用不是通过代理连接的，没有账号模式可切换。",
      );
    if (schemeKind(app.authScheme) === "none")
      throw new AccountModeRefusedError(
        `${app.title} 不需要账号，所以没有账号模式可切换。`,
      );
    return { toolkit, app };
  }

  async function preview(
    serverId: string,
    mode: AccountMode,
  ): Promise<AccountModePreview> {
    const { toolkit, app } = await resolve(serverId);
    const leaving: Holder = mode === "shared" ? "person" : "deployment";
    const count =
      app.mode === mode
        ? 0
        : leaving === "person"
          ? await store.countPeopleConnectedTo(toolkit)
          : app.shared?.connectedAt
            ? 1
            : 0;
    return {
      mode,
      current: app.mode,
      wouldRevoke: { holder: leaving, count },
    };
  }

  /*
   * 切换写下的那条「写之前先问」规则，而且只认这一条：按切换写它时的每个字段匹配，所以管理员手写的、
   * 覆盖同样工具的别的规则（别的行为、更窄的范围）是他们自己的，不随应用的模式消失。
   */
  type TeamRule = Awaited<
    ReturnType<NonNullable<typeof teamRules>["teamRules"]>
  >[number];
  const isSwitchRule = (rule: TeamRule, appId: string) =>
    rule.revokedAt === null &&
    rule.botId === "*" &&
    rule.toolRef === `${appId}/*` &&
    rule.scope === appId &&
    rule.effect === "write" &&
    rule.behaviour === "ask";

  async function forgetRule(appId: string, by: string): Promise<void> {
    if (!teamRules) return;
    for (const rule of await teamRules.teamRules()) {
      if (isSwitchRule(rule, appId))
        await teamRules.revokeTeamRule(by, rule.id);
    }
  }

  async function ensureRule(appId: string, by: string): Promise<number> {
    if (
      !teamRules ||
      (await teamRules.teamRules()).some((rule) => isSwitchRule(rule, appId))
    )
      return 0;
    await teamRules.createTeamRule(by, {
      botId: "*",
      toolRef: `${appId}/*`,
      effect: "write",
      scope: appId,
      behaviour: "ask",
    });
    return 1;
  }

  async function switchMode(input: {
    serverId: string;
    mode: AccountMode;
    by: string;
    confirm: boolean;
  }): Promise<AccountModeResult> {
    const planned = await preview(input.serverId, input.mode);
    if (!input.confirm) return { changed: false, preview: planned };

    {
      const { toolkit, app } = await resolve(input.serverId);

      /*
       * 已经是这个模式，就是已经切过——但不一定切完了。继续会撤销当前模式并不持有的账号，Shared 应用还会
       * 在团队账号建立时用的身份之上再铸一个新的，所以这里什么都不铸、不撤销；只把这个模式依靠的东西补齐：
       * Shared 应用的「写之前先问」规则，Personal 应用不留切换规则。
       */
      if (app.mode === input.mode) {
        if (input.mode === "shared") {
          const repaired = await ensureRule(app.appId, input.by);
          if (repaired > 0) await audit(app.appId, input, 0, repaired);
        } else {
          await forgetRule(app.appId, input.by);
        }
        return { changed: true, revoked: 0 };
      }

      const failures: { account: string; error: string }[] = [];
      let revoked = 0;
      if (input.mode === "shared") {
        const ended = await store.revokeEveryPersonOn({
          toolkit,
          by: input.by,
        });
        revoked += ended.revoked;
        failures.push(...ended.failures);
      } else if (app.shared?.connectedAt) {
        try {
          await store.disconnectShared({
            toolkit,
            by: input.by,
            reason: "mode_switched",
          });
          revoked += 1;
        } catch (error) {
          failures.push({
            account: "shared",
            error:
              error instanceof Error ? withoutStatement(error) : String(error),
          });
        }
      }
      if (failures.length > 0) return { changed: false, failures };

      /*
       * 按顺序写，所以步骤之间失败也是安全的方向。Shared：先有「写之前先问」规则，再让模式说 shared，
       * 所以不会有团队账号在用而规则还没立的时刻；失败只会留下一个问得比需要多的 Personal 应用，重试补完。
       * Personal：先让模式停止共享使用，再收拾规则，因为先删规则会留下一个不问就写的 Shared 应用。
       */
      if (input.mode === "shared") {
        if (!deps.deploymentId?.trim())
          throw new AccountModeRefusedError(
            "这个部署没有 id，不能持有共享账号。请设置 DEPLOYMENT_ID。",
          );
        await ensureRule(app.appId, input.by);
        await store.setAccountModeColumns(
          app.appId,
          "shared",
          mintDeploymentVendorUserId(deps.deploymentId),
        );
      } else {
        await store.setAccountModeColumns(app.appId, "personal", null);
        await forgetRule(app.appId, input.by);
      }
      await audit(app.appId, input, revoked);
      return { changed: true, revoked };
    }
  }

  async function audit(
    appId: string,
    input: { mode: AccountMode; by: string },
    revoked: number,
    repaired?: number,
  ) {
    await recordAuditEvent(deps.audit, {
      eventType: "configuration.changed",
      targetType: "mcp_server",
      targetId: appId,
      actorUserId: input.by,
      payload: {
        change: "account_mode",
        server: appId,
        mode: input.mode,
        revoked,
        ...(repaired ? { repaired } : {}),
      },
    });
  }

  return { preview, switchMode, forgetRule };
}

export type AccountModeSwitch = ReturnType<typeof createAccountModeSwitch>;
