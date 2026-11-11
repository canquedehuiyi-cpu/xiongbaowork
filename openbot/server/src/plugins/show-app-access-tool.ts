import { z } from "zod";
import {
  connectAppRefusal,
  SHOW_APP_ACCESS_TOOL,
} from "../../../shared/connect-prompt";
import { currentEdition } from "../edition";
import type { AppAccess, AppAccessState } from "./app-access";
import type { AppDirectory } from "./app-access-store";
import type { PluginStore } from "./store";
import type { GrantedTool } from "./tools";

/** 这个工具的 ref。 */
export const SHOW_APP_ACCESS_REF = `app-access/${SHOW_APP_ACCESS_TOOL}`;

/**
 * 每位员工都持有的「看应用权限」工具（上游 `app-access-tool.ts` 的 `show_app_access`，按 fork 改写，X2）。
 *
 * 为什么是工具而不是一句话：员工遇到一个自己没有工具的应用，从来不会去调用它，所以没有被拒绝的调用，也就
 * 没有卡片可画。这个调用就是那张卡片：回答带的是拒绝用的同一个标记（`reason: "access"`），对话记录用同一
 * 张卡片画，卡片画出来时再问服务端这个应用对这个人、这位员工是什么，不信这里写的（那只是模型问的那一刻）。
 *
 * 只读，永远只读：这里不打开、不授予、不建申请。卡片上按「申请」才建，那是人在按，走员工页同一条路由，由
 * 服务端定申请什么。所以这个工具可以给每位员工：模型最多只能给人看一张关于别的应用的、准确的卡片。
 *
 * fork 的 `request_app_access`（替对方直接建申请）照旧保留，两者并存：这个画状态，那个在对话里代为申请。
 */
export function showAppAccessTools(options: {
  /** 由 store 自己调用（`this` 是 store）；测试给一个只回答这一个问题的替身。 */
  store: {
    inspectApp(
      input: Parameters<PluginStore["inspectApp"]>[0],
    ): ReturnType<PluginStore["inspectApp"]>;
  };
  botId: string;
  actorId: string;
  composioConfigured: boolean;
  /** 叫出一个这里还没有行的 broker 应用。没有 broker 的 key 时没有。 */
  directory?: AppDirectory;
}): GrantedTool[] {
  const parameters = z
    .object({
      app: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe(
          "The app's name (Gmail, Slack, Google Drive) or its id as your instructions list it.",
        ),
    })
    .strict();
  return [
    {
      name: SHOW_APP_ACCESS_TOOL,
      ref: SHOW_APP_ACCESS_REF,
      description:
        currentEdition() === "personal"
          ? "Show the person a card saying whether they can use one work app through you, and the one thing that would let them: connecting it, or setting it up. Call it whenever a question needs an app you hold no tools for or one that needs connecting, instead of only saying it is missing."
          : "Show the person a card saying whether they can use one work app through you, and the one thing that would let them: connecting their own account, or asking an administrator to switch the app on or grant it to you. Call it whenever a question needs an app you hold no tools for, instead of only saying it is missing.",
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success) return "请写明要查看的应用。";
        const { app } = parsed.data;
        const inspected = await options.store.inspectApp({
          app,
          agentId: options.botId,
          userId: options.actorId || null,
          composioConfigured: options.composioConfigured,
          ...(options.directory ? { directory: options.directory } : {}),
        });
        // 叫不出来的应用不画卡片：卡片没有可问的，也没有可给的；照实告诉模型。
        if (!inspected)
          return `这个部署没有叫「${app}」的应用，没有可以展示的。请如实告诉对方；不要改用浏览器去打开它的网站。`;
        const { access } = inspected;
        return connectAppRefusal({
          serverId: access.key,
          title: access.displayName,
          agentId: options.botId,
          reason: "access",
          // 让后来画出的卡片分得清「之后才好的」和「本来就好的」。
          blocked: access.state !== "ready",
          message: toldTheModel(access),
        });
      },
    },
  ];
}

/** 模型读到的：状态用一句话说，以及卡片上已经给了下一步，回复只要一句话。 */
function toldTheModel(access: AppAccess): string {
  const name = access.displayName;
  const owners = access.accountHolder === "owner";
  const said: Record<AppAccessState, string> = {
    ready: access.asksFirst
      ? `「${name}」对方可以通过你使用，用的是对方自己的账号；第一次调用会先问对方是否允许。请直接用它的工具，不要再展示卡片。`
      : `「${name}」对方已经可以通过你使用。请直接用它的工具，不要再展示卡片。`,
    not_connected: `「${name}」已授予你，但对方还没有连接自己的账号。对方面前的卡片上有「连接」，请对方连接后再试一次。`,
    reconnect: owners
      ? `「${name}」已授予你，用的是你主人的账号，那个连接需要重新连接。只有你的主人能重新连接，对方面前的卡片会说明。`
      : `「${name}」已授予你，但对方的连接需要重新连接。对方面前的卡片上有「重新连接」，请对方重连后再试一次。`,
    shared_not_connected: `「${name}」在这个部署用一个共享的团队账号，管理员还没有连接它。对方面前的卡片会说明要等管理员连接。`,
    shared_not_approved: `「${name}」用的是一个共享的团队账号，管理员还没有批准你使用它，所以调用会被拒绝。对方面前的卡片会说明。`,
    disabled: `「${name}」在这个部署还没有打开。对方面前的卡片可以向管理员申请打开它。`,
    not_granted: `「${name}」已经打开，但没有授予你。对方面前的卡片可以向管理员申请授予你。`,
    owner_grantable: `「${name}」已经打开，但还没有给你。对方是你的主人，可以自己给你：对方面前的卡片会问是否让你用他的「${name}」。请对方处理后再试一次。`,
  };
  // 个人版没有管理员：卡片自己给出那一步，不让模型叫人去找管理员，并告诉它卡片上画的按钮。
  if (
    currentEdition() === "personal" &&
    (access.state === "disabled" || access.state === "not_granted")
  )
    said[access.state] = personalStep(access);
  return `${said[access.state]}不要改用浏览器去打开它的网站，也不要让对方去那里登录。`;
}

/** 个人版里一个还没打开的应用，卡片上那个按钮的话。 */
function personalStep(access: AppAccess): string {
  const name = access.displayName;
  const oneStep =
    access.state === "not_granted" ||
    access.unavailable === null ||
    access.unavailable === "absent";
  if (!oneStep)
    return `「${name}」还没有设置好。对方面前的卡片上有「去设置」，会打开完成设置的页面；请对方设置好后再试一次。`;
  if (access.connect === "key")
    return `「${name}」还没有连接。对方面前的卡片上有「设置」，会打开填写密钥的页面；请对方填好后再试一次。`;
  if (access.connect === "oauth" || access.connect === "consent")
    return `「${name}」还没有连接。对方面前的卡片上有「连接」，一按就打开并连接它；请对方连接后再试一次。`;
  return `「${name}」还没有连接。对方面前的卡片上有「打开」；如果卡片接着出现「连接」，请对方再按「连接」连上自己的账号。请对方处理后再试一次。`;
}
