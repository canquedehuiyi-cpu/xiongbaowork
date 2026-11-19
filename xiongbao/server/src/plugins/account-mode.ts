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
 * - 上游切到 Shared 时在这里为管理员在预览里看过的员工写「共享使用批准」。fork 的批准记在员工主人名下，
 *   要进每位主人的帧才写得进去，那道门在路由上（`asBotOwner`），所以这里不写批准、预览里也没有员工
 *   列表：两样都由 `PUT /servers/:id/account-mode` 在切换完成之后加上（`./routes` 的 `sharedBotsOf` 与
 *   `recordSwitchApprovals`）。没有批准时共享闸门对每一次调用都拒绝（与上游「没有批准就拒绝」一致）。
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
          : app.shared
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

  type SwitchInput = {
    serverId: string;
    mode: AccountMode;
    by: string;
    confirm: boolean;
  };

  /** 切换，答案不带别的（原有的形状）。 */
  async function switchMode(input: SwitchInput): Promise<AccountModeResult> {
    return (await switchModeTelling(input)).result;
  }

  /**
   * 切换，并说明这一次有没有真的把模式改掉。`switched` 只在模式确实从另一个改成了这一个时为真；应用本来
   * 就是这个模式（只补齐它依靠的东西）、只是预览、撤销失败，都是 false。
   *
   * 路由要它来决定随切换送来的批准是照写还是只补缺。这件事只有切换自己知道：调用方在切换之前另读一次
   * 模式，读到的可能已经被另一位管理员的切换改掉了。
   */
  async function switchModeTelling(
    input: SwitchInput,
  ): Promise<{ result: AccountModeResult; switched: boolean }> {
    const planned = await preview(input.serverId, input.mode);
    if (!input.confirm)
      return { result: { changed: false, preview: planned }, switched: false };

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
        return { result: { changed: true, revoked: 0 }, switched: false };
      }

      /*
       * 前置条件先于任何撤销（评审 M4）：没有部署 id 就铸不出团队身份，那就一个账号都不该撤。
       */
      const deploymentId = deps.deploymentId?.trim();
      if (input.mode === "shared" && !deploymentId)
        throw new AccountModeRefusedError(
          "这个部署没有 id，不能持有共享账号。请设置 DEPLOYMENT_ID。",
        );
      const failures: { account: string; error: string }[] = [];
      let revoked = 0;
      if (input.mode === "shared") {
        const ended = await store.revokeEveryPersonOn({
          toolkit,
          by: input.by,
        });
        revoked += ended.revoked;
        failures.push(...ended.failures);
      } else if (app.shared) {
        /*
         * 只要有团队身份就撤销，不只看是否已确认（评审 I2）：管理员在 vendor 的同意屏幕上授权了、却没有
         * 回来确认时，vendor 那里已经有一个团队账号，而这里还没有记下。撤销对「没有账号」是幂等的；失败
         * 就不改模式、不清团队身份，这个账号仍然能从这里被撤销。
         */
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
      if (failures.length > 0)
        return { result: { changed: false, failures }, switched: false };

      /*
       * 按顺序写，所以步骤之间失败也是安全的方向。Shared：先有「写之前先问」规则，再让模式说 shared，
       * 所以不会有团队账号在用而规则还没立的时刻；失败只会留下一个问得比需要多的 Personal 应用，重试补完。
       * Personal：先让模式停止共享使用，再收拾规则，因为先删规则会留下一个不问就写的 Shared 应用。
       */
      if (input.mode === "shared") {
        await ensureRule(app.appId, input.by);
        await store.setAccountModeColumns(
          app.appId,
          "shared",
          mintDeploymentVendorUserId(deploymentId as string),
        );
      } else {
        await store.setAccountModeColumns(app.appId, "personal", null);
        await forgetRule(app.appId, input.by);
      }
      await audit(app.appId, input, revoked);
      return { result: { changed: true, revoked }, switched: true };
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

  return { preview, switchMode, switchModeTelling, forgetRule };
}

export type AccountModeSwitch = ReturnType<typeof createAccountModeSwitch>;
