import { appToolName, connectorName, humanise } from "./tool-name";
import { lowerFirst } from "./tool-name-words";

/**
 * What an Activity or Audit row is about, in words: the What column, where the trail's own names
 * (`mcp.tools_discovered`, `computer_write_file`) used to show as they are stored.
 *
 * Every phrase is what was asked for, not what came of it (「保存文件」, not 「保存了文件」),
 * because the Decision beside it says what came of it, and an action that was blocked or failed
 * must not read as done. That is why a computer's actions have their own words here rather than
 * the conversation's past-tense step labels. An app's tool keeps the words a conversation gives it
 * (`appToolName`), which are already the action itself.
 *
 * The stored names are not lost: the CSV export carries them unchanged, the search box finds a row
 * by them, and Admin shows one on hover.
 */

/** A computer's or this computer's actions, by the tool name an action row records. */
const ACTIONS: Readonly<Record<string, string>> = {
  computer_navigate: "打开页面",
  computer_read: "读取页面",
  computer_snapshot: "查看页面结构",
  computer_click: "点击页面",
  computer_type: "填写字段",
  computer_key: "按下按键",
  computer_scroll: "滚动页面",
  computer_screenshot: "截屏",
  computer_list_files: "列出文件",
  computer_read_file: "读取文件",
  computer_write_file: "保存文件",
  computer_run_command: "执行命令",
  computer_download_file: "下载文件",
  computer_handoff: "把电脑交给人操作",
  computer_request_help: "请人帮忙",
  computer_request_secret: "请人填写字段",
  computer_request_sign_in: "请人登录",
  host_list_folders: "查看你的文件夹",
  host_list_files: "列出文件",
  host_read_file: "读取文件",
  host_write_file: "保存文件",
  host_run_command: "执行命令",
  "bot/message_bot": "询问另一位员工",
  "openbot/share_private_information": "分享私密信息",
};

/**
 * Every event the trail records, by the type it is stored under. `server/tests/audit-words.test.ts`
 * fails on a type the server registers without words here, so a new one cannot reach the screen as
 * its stored name.
 */
export const AUDIT_EVENT_WORDS: Readonly<Record<string, string>> = {
  "configuration.changed": "修改设置",
  "credential.created": "保存凭据",
  "credential.rotated": "更换凭据",
  "credential.rotation_refused": "更换凭据",
  "credential.revoked": "删除凭据",
  "channel.routed": "为消息选择员工",
  "channel.deleted": "删除对话",
  "delivery.received": "接收消息",
  "delivery.sent": "发送消息",
  "delivery.opted_out": "不再接收消息",
  "delivery.failed": "发送消息",
  "delivery.linked": "连接消息应用",
  "delivery.unlinked": "断开消息应用",
  "agent.dial_refused": "联系员工",
  "agent.stream_stalled": "回复",
  "agent.tool_limit_refused": "开始回复",
  "agent.handoff_offered": "把工作转交给另一位员工",
  "agent.handoff_refused": "把工作转交给另一位员工",
  "agent.handoff_delivered": "把工作转交给另一位员工",
  "agent.handoff_failed": "把工作转交给另一位员工",
  "agent.handoff_retried": "把工作转交给另一位员工",
  "agent.escalated": "把工作交给人",
  "agent.escalation_failed": "把工作交给人",
  "mcp.tools_discovered": "为一次运行挑选工具",
  "mcp.call_succeeded": "使用应用",
  "mcp.call_rejected": "使用应用",
  "mcp.call_failed": "使用应用",
  "mcp.callback_refused": "使用应用",
  // Said as what it is for: an app's sign-in, set up or read back. Admin hovers for the stored name.
<<<<<<< 9772fc7e2b1ae57f9300ef67de28e9fefd5ee29e
  "mcp.oauth_client_registered": "设置应用的登录",
  "mcp.oauth_client_read_failed": "检查应用的登录",
  "mcp.connection_verified": "检查连接",
  "mcp.account_connected": "连接账号",
  "mcp.authorization_unreconciled": "完成账号连接",
  "mcp.account_disconnected": "断开账号",
  "mcp.authorization_cancelled": "取消连接账号",
  "mcp.cancelled_grant_left_live": "取消连接账号",
  // M3: no shared use / account modes in this fork, so no words for their events.
  "app_access.requested": "申请应用",
  "app_access.cancelled": "取消应用申请",
  "app_access.approved": "批准应用申请",
  "app_access.dismissed": "忽略应用申请",
  "app_access.refused": "申请应用",
  "computer.action_allowed": "使用电脑",
  "computer.action_refused": "使用电脑",
  "computer.action_failed": "使用电脑",
  "computer.action_stopped": "使用电脑",
  "computer.help_requested": "请人帮忙",
  "computer.help_cancelled": "取消求助",
  "computer.control_taken": "接管电脑",
  "computer.control_released": "交还电脑",
  "computer.secret_requested": "请人填写字段",
  "computer.secret_supplied": "替员工填写字段",
  "computer.sign_in_requested": "请人登录",
  "computer.sign_in_code_requested": "索要登录验证码",
  "computer.sign_in_completed": "在电脑上登录",
  "computer.sign_in_failed": "在电脑上登录",
  "computer.sign_in_cancelled": "取消登录",
  "computer.stopped": "停止电脑",
  "computer.reset": "重置电脑",
  "computer.browser_cleared": "清空浏览器",
  "computer.updated": "更新电脑",
  "computer.policy_loaded": "启动电脑",
  "computer.isolation_loaded": "启动电脑",
  "computer.terminated": "关闭电脑",
  "computer.terminated_inactive": "关闭闲置的电脑",
  "password.saved": "保存登录信息",
  "password.deleted": "删除登录信息",
  "bot.declined": "拒绝请求",
  "bot.created": "创建员工",
  "bot.updated": "修改员工",
  "bot.duplicated": "复制员工",
  "bot.hidden": "隐藏员工",
  "bot.unhidden": "显示员工",
  "bot.pinned": "置顶员工",
  "bot.unpinned": "取消置顶员工",
  "bot.deleted": "删除员工",
  "bot.callback_token_issued": "签发员工的回调令牌",
  "bot.callback_token_revoked": "吊销员工的回调令牌",
  "bot.isolation_refused": "给员工一台独立的电脑",
  "bot.paused": "暂停员工",
  "bot.resumed": "恢复员工",
  "bot.reset": "重置员工",
  "bot.notifications_changed": "修改员工的通知",
  "bot.follow_up_scheduled": "安排跟进",
  "bot.follow_up_cancelled": "取消跟进",
  "bot.handoff_stopped": "停止转交工作",
  "component.granted": "把组件交给员工",
  "component.revoked": "从员工收回组件",
  "component.published": "发布组件",
  "component.unpublished": "取消发布组件",
  "component.draft_saved": "保存组件草稿",
  "component.description_updated": "更新组件说明",
  "component.refused": "展示组件",
  "component.function_granted": "允许组件读取数据",
  "component.function_revoked": "不再允许组件读取数据",
  "component.function_called": "为组件读取数据",
  "component.function_refused": "为组件读取数据",
  "component.function_failed": "为组件读取数据",
  "person.role_changed": "修改成员的角色",
  "person.access_revoked": "撤销成员的访问权限",
  "person.access_restored": "恢复成员的访问权限",
  "platform.tenant_suspended": "停用工作区",
  "platform.tenant_restored": "恢复工作区",
  "plan.changed": "更改工作区的套餐",
  "person.admin_by_configuration": "设为管理员",
  "person.provisioned": "添加成员",
  "person.deprovisioned": "移除成员",
  "person.reprovisioned": "重新添加成员",
  "audit.exported": "导出事件",
  "session.signed_in": "登录",
  "session.refused": "登录",
  "session.break_glass": "使用紧急登录",
  "auth.sessions_revoked": "让成员在所有设备上退出登录",
  "identity_provider.registered": "添加身份提供方",
  "identity_provider.removed": "删除身份提供方",
  "identity.linked": "关联账号",
  "identity.unlinked": "取消关联账号",
  "identity.link_retired": "停用已关联的账号",
  "routines.dispatch_refused": "执行定时任务",
  "routines.run_requested": "执行定时任务",
  "routine.created": "创建定时任务",
  "routine.updated": "修改定时任务",
  "routine.deleted": "删除定时任务",
  "routine.enabled_changed": "开启或关闭定时任务",
  "responsibility.triggered": "推进目标",
  "automation.triggered": "运行自动化",
  "approval.evaluated": "检查动作",
  "approval.person_decided": "决定是否执行动作",
  "approval.withdrawn": "撤回请求",
  "approval.rule_changed": "修改审批规则",
  "approval.settings_changed": "修改审批设置",
  "capability.changed": "修改权限",
  "enterprise.setting_changed": "修改组织设置",
  "network_policy.changed": "修改网络策略",
  "network_policy.removed": "删除网络策略",
  "model.refused": "使用模型",
  "knowledge.notebook_created": "创建知识库",
  "knowledge.notebook_updated": "修改知识库",
  "knowledge.notebook_deleted": "删除知识库",
  "knowledge.source_added": "向知识库添加来源",
  "knowledge.source_updated": "修改知识库的来源",
  "knowledge.source_removed": "从知识库删除来源",
  "knowledge.binding_granted": "允许员工读取知识库",
  "knowledge.binding_revoked": "不再允许员工读取知识库",
  "recorder.bearer_refused": "使用录制器",
  "recorder.connected": "连接录制器",
  "recorder.connect_refused": "连接录制器",
  "recorder.revoked": "断开录制器",
  "recorder.sign_out_failed": "让录制器退出登录",
  "recorder.trajectory_refused": "保存录制",
  "learning.sharing_changed": "修改用于学习的共享内容",
  "learning.skill_opened": "打开技能以供审核",
  "learning.skill_closed": "结束技能审核",
  "learning.sharing_requested": "申请共享学到的技能",
  "learning.sharing_decided": "答复共享学到的技能的申请",
  "learning.local_candidate_reviewed": "审核从对话中学到的技能草案",
=======
  "mcp.oauth_client_registered": "Set up an app's sign-in",
  "mcp.oauth_client_read_failed": "Check an app's sign-in",
  "mcp.connection_verified": "Check a connection",
  "mcp.account_connected": "Connect an account",
  "mcp.authorization_unreconciled": "Finish connecting an account",
  "mcp.account_disconnected": "Disconnect an account",
  "mcp.authorization_cancelled": "Cancel connecting an account",
  "mcp.cancelled_grant_left_live": "Cancel connecting an account",
  "mcp.account_mode_changed": "Change whose account an app uses",
  "shared_use.requested": "Ask to use a shared account",
  "shared_use.approved": "Approve a shared account",
  "shared_use.declined": "Decline a shared account",
  "shared_use.owner_approved": "Approve a shared account",
  "shared_use.owner_withdrawn": "Withdraw a shared account",
  "app_access.requested": "Ask for an app",
  "app_access.cancelled": "Cancel a request for an app",
  "app_access.approved": "Approve a request for an app",
  "app_access.dismissed": "Dismiss a request for an app",
  "app_access.refused": "Ask for an app",
  "app_access.owner_granted": "Share an app",
  "app_access.owner_revoked": "Stop sharing an app",
  "plugin.grants_translated": "Choose a Bot's actions from a description",
  "plugin.grants_changed": "Change a Bot's actions in an app",
  "computer.action_allowed": "Use the computer",
  "computer.action_refused": "Use the computer",
  "computer.action_failed": "Use the computer",
  "computer.action_stopped": "Use the computer",
  "computer.help_requested": "Ask a person for help",
  "computer.help_cancelled": "Cancel a request for help",
  "computer.control_taken": "Take control of the computer",
  "computer.control_released": "Hand the computer back",
  "computer.secret_requested": "Ask a person to fill in a field",
  "computer.secret_supplied": "Fill in a field for a Bot",
  "computer.sign_in_requested": "Ask a person to sign in",
  "computer.sign_in_code_requested": "Ask for a sign-in code",
  "computer.sign_in_completed": "Sign in on the computer",
  "computer.sign_in_failed": "Sign in on the computer",
  "computer.sign_in_cancelled": "Cancel a sign-in",
  "computer.stopped": "Stop the computer",
  "computer.reset": "Reset the computer",
  "computer.browser_cleared": "Clear the browser",
  "computer.updated": "Update the computer",
  "computer.policy_loaded": "Start the computer",
  "computer.policy_changed": "Change the boundaries",
  "computer.policy_translated": "Write a boundary from a description",
  "computer.isolation_loaded": "Start the computer",
  "computer.terminated": "Shut down a computer",
  "computer.terminated_inactive": "Shut down an idle computer",
  "password.saved": "Save a login",
  "password.deleted": "Delete a login",
  "bot.declined": "Decline a request",
  "bot.created": "Create a Bot",
  "bot.updated": "Change a Bot",
  "bot.duplicated": "Duplicate a Bot",
  "bot.hidden": "Hide a Bot",
  "bot.unhidden": "Show a Bot",
  "bot.pinned": "Pin a Bot",
  "bot.unpinned": "Unpin a Bot",
  "bot.deleted": "Delete a Bot",
  "bot.callback_token_issued": "Issue a Bot's callback token",
  "bot.callback_token_revoked": "Revoke a Bot's callback token",
  "bot.isolation_refused": "Give a Bot its own computer",
  "bot.paused": "Pause a Bot",
  "bot.resumed": "Resume a Bot",
  "bot.reset": "Reset a Bot",
  "bot.notifications_changed": "Change a Bot's notifications",
  "bot.follow_up_scheduled": "Schedule a follow-up",
  "bot.follow_up_cancelled": "Cancel a follow-up",
  "bot.handoff_stopped": "Stop handing work on",
  "component.granted": "Give a component to a Bot",
  "component.revoked": "Take a component from a Bot",
  "component.published": "Publish a component",
  "component.unpublished": "Unpublish a component",
  "component.draft_saved": "Save a component draft",
  "component.description_updated": "Update a component's description",
  "component.refused": "Show a component",
  "component.function_granted": "Let a component read data",
  "component.function_revoked": "Stop a component reading data",
  "component.function_called": "Read data for a component",
  "component.function_refused": "Read data for a component",
  "component.function_failed": "Read data for a component",
  "person.role_changed": "Change a person's role",
  "person.access_revoked": "Remove a person's access",
  "person.access_restored": "Restore a person's access",
  "person.admin_by_configuration": "Make a person an admin",
  "person.provisioned": "Add a person",
  "person.deprovisioned": "Remove a person",
  "person.reprovisioned": "Add a person back",
  "audit.exported": "Export events",
  "audit.asked": "Ask the audit trail",
  "what_if.asked": "Ask what would happen",
  "what_if.checked": "Check what would happen",
  "session.signed_in": "Sign in",
  "session.refused": "Sign in",
  "session.break_glass": "Use emergency sign-in",
  "auth.sessions_revoked": "Sign a person out everywhere",
  "identity_provider.registered": "Add an identity provider",
  "identity_provider.removed": "Remove an identity provider",
  "identity.linked": "Link an account",
  "identity.unlinked": "Unlink an account",
  "identity.link_retired": "Retire a linked account",
  "routines.dispatch_refused": "Run a routine",
  "routines.run_requested": "Run a routine",
  "routine.created": "Create a routine",
  "routine.updated": "Change a routine",
  "routine.deleted": "Delete a routine",
  "routine.enabled_changed": "Turn a routine on or off",
  "responsibility.triggered": "Work on a goal",
  "approval.evaluated": "Check an action",
  "approval.person_decided": "Decide on an action",
  "approval.withdrawn": "Withdraw a request",
  "approval.rule_changed": "Change an approval rule",
  "approval.rules_translated": "Write approval rules from a description",
  "approval.guidance_changed": "Change guidance for auto-review",
  "approval.settings_changed": "Change approval settings",
  "capability.changed": "Change a permission",
  "capability.changes_translated":
    "Write permission changes from a description",
  "enterprise.setting_changed": "Change an organization setting",
  "network_policy.changed": "Change the network policy",
  "network_policy.removed": "Remove a network policy",
  "network_policy.translated": "Write a network allowlist from a description",
  "model.refused": "Use a model",
  "recorder.bearer_refused": "Use the Recorder",
  "recorder.connected": "Connect the Recorder",
  "recorder.connect_refused": "Connect the Recorder",
  "recorder.revoked": "Disconnect the Recorder",
  "recorder.sign_out_failed": "Sign the Recorder out",
  "recorder.trajectory_refused": "Save a recording",
  "learning.sharing_changed": "Change what is shared for learning",
  "learning.skill_opened": "Open a skill for review",
  "learning.skill_closed": "Close a skill review",
  "learning.sharing_requested": "Ask to share a learned skill",
  "learning.sharing_decided": "Answer a request to share a learned skill",
>>>>>>> e4f4ac8578f5545794cad028b21ac396fa6c816b
};

/**
 * An action as a row names it: a computer's or this computer's (`computer_write_file`,
 * `host/write_file`, the bare `click` one older row records), an app's tool (`gmail/send_email`),
 * one of OpenBot's own (`bot/message_bot`), or an app's whole account (`gmail/*`). A name this has
 * no words for is split into words, never shown as stored.
 */
export function auditActionWords(action: string): string {
  const known = [
    action,
    action.replace(/^host\//, "host_"),
    `computer_${action}`,
  ].find((name) => Object.hasOwn(ACTIONS, name));
  if (known && ACTIONS[known]) return ACTIONS[known];
  const slash = action.indexOf("/");
  const app = action.slice(0, slash);
  const tool = action.slice(slash + 1);
  if (slash <= 0 || !tool)
    return humanise(action.replace(/^(computer|host)_/, ""));
  return tool === "*"
    ? `使用 ${connectorName(app)}`
    : appToolName(app, tool).label;
}

/**
 * A configuration row's change in words, read from the `change` its payload names: the plugin
 * store's own changes, which OpenBot makes by itself as well as a person does (it gives every Bot
 * Routines' tools at every start, and in the personal edition every app's tools). Any other change
 * answers nothing, and the row keeps "修改设置".
 */
export function auditChangeWords(
  payload: Record<string, unknown>,
): string | undefined {
  const { change, kind } = payload;
  if (change === "plugin_granted") {
    if (kind === "skill") return "给员工一项技能";
    if (kind === "bot") return "允许员工询问另一位员工";
    // One row names every tool a Bot was given at once; see `grantTools` on the server.
    return Array.isArray(payload.refs) && payload.refs.length > 1
      ? "给员工多个工具"
      : "给员工一个工具";
  }
  if (change === "plugin_revoked") {
    if (kind === "skill") return "从员工收回技能";
    if (kind === "bot") return "不再允许员工询问另一位员工";
    return "从员工收回工具";
  }
  return typeof change === "string" && Object.hasOwn(CHANGES, change)
    ? CHANGES[change]
    : undefined;
}

const CHANGES: Readonly<Record<string, string>> = {
  mcp_server_added: "开启应用",
  mcp_server_removed: "关闭应用",
  skill_installed: "保存技能",
  skill_uninstalled: "删除技能",
  // A person's folders on their own computer, from Settings > Computer; see host-access/routes.ts.
  host_folder_granted: "给员工一个文件夹",
  host_folder_revoked: "从员工收回文件夹",
  host_access_stopped: "停止文件夹访问",
  // OpenBot choosing the Learning space every Bot learns into, at its first start.
  default_container_assigned_automatically: "设置学习",
};

/**
 * What each of a component's data functions reads, in a person's words. `server/tests/audit-words.test.ts`
 * fails on a function the server ships without words here.
 */
export const DATA_FUNCTION_WORDS: Readonly<Record<string, string>> = {
  botActivity: "你的员工的活动",
  recentRefusals: "被拒绝的内容",
};

/**
 * The data a component was given or read, in words: 「你的员工的活动和被拒绝的内容」.
 * A function with no words of its own is split into words, never shown as stored.
 */
export function dataWords(functions: readonly string[]): string {
  const words = functions.map((name) =>
    Object.hasOwn(DATA_FUNCTION_WORDS, name)
      ? (DATA_FUNCTION_WORDS[name] as string)
      : humanise(name).toLowerCase(),
  );
  return listWords(words);
}

/** CJK characters and full-width forms: what needs no space beside other Chinese text. */
const CJK = /[　-鿿＀-￯]/;

/**
 * Two pieces of text side by side, with the half-width space the copy rules put between Chinese and
 * English, a number or a path (`shared/tool-name.ts`, above `approvalWords`), and none between two
 * Chinese pieces.
 */
function joined(left: string, right: string): string {
  if (!left || !right) return left + right;
  const spaced = CJK.test(left.at(-1) ?? "") !== CJK.test(right.charAt(0));
  return spaced ? `${left} ${right}` : left + right;
}

/** 「甲」「甲和乙」「甲、乙和丙」. */
function listWords(words: readonly string[]): string {
  if (words.length < 2) return words[0] ?? "";
  return joined(
    joined(words.slice(0, -1).join("、"), "和"),
    words.at(-1) ?? "",
  );
}

/** How many of an app's tools a row names one by one before it says how many more. */
const TOOLS_NAMED = 2;

/**
 * An app's tools, by their `app/tool` refs, in words with the app, by the rules above
 * `approvalWords` in `shared/tool-name.ts`: an English action is 「Send email（Gmail）」 and
 * 「Complete goal、create goal 及另外 5 个工具（Routines）」, a Chinese one 「在 Parallel 上搜索网页」.
 * What a row gave or took, for a page anybody can open, where the refs themselves are never shown.
 */
export function appToolsWords(refs: readonly string[]): string {
  const first = refs[0] ?? "";
  const app = first.slice(0, Math.max(first.indexOf("/"), 0)) || first;
  const named = refs
    .slice(0, refs.length > TOOLS_NAMED + 1 ? TOOLS_NAMED : refs.length)
    .map((ref, index) => {
      const words = auditActionWords(ref);
      return index === 0 ? words : lowerFirst(words);
    });
  const more = refs.length - named.length;
  const list =
    more > 0
      ? joined(named.join("、"), `及另外 ${more} 个工具`)
      : listWords(named);
  const place = connectorName(app);
  // Rule 1 and 2 there: Chinese reads 「在 {地点} 上{动作}」, English 「{动作}（{地点}）」.
  return CJK.test(list.charAt(0))
    ? `在 ${place} 上${list}`
    : `${list}（${place}）`;
}

/**
 * An event in words: its own entry above, or, for a type older rows carry that no longer has one,
 * its stored name split into words. Never the stored name as it is.
 */
export function auditEventWords(eventType: string): string {
  return Object.hasOwn(AUDIT_EVENT_WORDS, eventType)
    ? (AUDIT_EVENT_WORDS[eventType] as string)
    : humanise(
        eventType
          .replace(/^mcp\./, "app.")
          .replace(/^agent\./, "bot.")
          .replace(/\./g, " "),
      );
}

/**
 * The rows an admin filters for most often, in the words the Audit page's views use: "Computer
 * actions" and "App calls", then how they ended. The event words above say what a
 * row was for a person reading one row ("Use the computer"); a filter is about a kind of row.
 */
const TYPE_WORDS: Record<string, string> = {
  "computer.action_allowed": "Computer actions, allowed",
  "computer.action_refused": "Computer actions, blocked",
  "computer.action_failed": "Computer actions, failed",
  "computer.action_stopped": "Computer actions, stopped",
  "mcp.call_succeeded": "App calls, done",
  "mcp.call_rejected": "App calls, blocked",
  "mcp.call_failed": "App calls, failed",
};

/** One event type as a filter names it: a kind of row, then how it ended where that matters. */
export function auditTypeWords(type: string): string {
  return TYPE_WORDS[type] ?? auditEventWords(type);
}
