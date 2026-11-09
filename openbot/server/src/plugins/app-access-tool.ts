import { z } from "zod";
import {
  type AppAccessRequestCard,
  REQUEST_APP_ACCESS_TOOL,
  writeAppAccessRequestAnswer,
} from "../../../shared/app-access-request";
import type { AppAccessRequestKind } from "../db/schema/app-access-requests";
import type { PluginStore } from "./store";
import { type GrantedTool, REFUSAL_MARKER } from "./tools";

/** 这个工具的 ref，SEC1 规则和后台只读边界都按它认。 */
export const REQUEST_APP_ACCESS_REF = `app-access/${REQUEST_APP_ACCESS_TOOL}`;

/**
 * 一个人同时最多有几条申请在等管理员。真人只会问一个问题用到的那几个应用；再多就是在填满收件箱，
 * 每多一条都要管理员手动处理。
 */
export const MAX_PENDING_APP_ACCESS_REQUESTS = 20;

/**
 * 每位员工都持有的「申请访问」工具（上游 #814 的申请部分，fork 版）。
 *
 * 为什么是工具而不是一句话：员工遇到自己没被授予的应用，以前只会说"管理员可以授予"，正确但没用，对方
 * 拿到的只是一个角色的名字，没有办法去找。这个工具替对方把申请直接放进管理员的收件箱，对话里留一张卡片
 * 说明这件事，对方还可以撤回。
 *
 * 类型由服务端定，不由模型定：员工已持有这个应用的工具，就是已就绪，不建申请；应用已上架（D08）但没给这
 * 位员工，申请 `grant`；还没上架，申请 `enable`。批准时走 fork 现有的上架和授予接口，这里不授予任何东西。
 *
 * 归为写：它会在本租户里建一条申请，所以后台只读的主动研究拿不到它（`proactive/restriction.ts` 只放行
 * 认定为读的 ref）。但它只写这一条申请，不碰任何应用，也不出本租户，所以不走审批卡片。
 */
export function appAccessTools(options: {
  store: Pick<
    PluginStore,
    | "findAppForRequest"
    | "listForAgent"
    | "isInstallListed"
    | "fileAppAccessRequest"
  >;
  botId: string;
  actorId: string;
}): GrantedTool[] {
  const parameters = z
    .object({
      app: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("应用名（例如 Notion、Gmail）或说明里写的应用标识。"),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("一句话说明为什么需要它，管理员在收件箱里会看到。"),
    })
    .strict();
  return [
    {
      name: REQUEST_APP_ACCESS_TOOL,
      ref: REQUEST_APP_ACCESS_REF,
      description:
        "Ask an administrator, on behalf of the person you are talking to, to let you use one work app you hold no tools for. Call it when a question needs such an app, instead of only saying it is missing or browsing to the app's website. The server decides whether the app must first be listed or only granted to you; if you can already use the app, nothing is filed and you are told so. The person sees a card in the conversation and can withdraw the request.",
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success)
          return `${REFUSAL_MARKER} 请写明要申请的应用，以及一句申请理由。`;
        if (!options.actorId)
          return `${REFUSAL_MARKER} 这次对话没有可以代为申请的人。`;
        const { app, reason } = parsed.data;
        const found = await options.store.findAppForRequest(app);
        if (!found)
          return `这个部署还没有叫「${app}」的应用，没有可以申请的。请如实告诉对方；不要改用浏览器去打开它的网站，也不要让对方去那里登录。`;
        // 自己添加的应用不归管理员管：申请只会让管理员看到一个在他的帧里不存在的应用，永远批不了。
        if (found.own)
          return `「${found.title}」是你自己添加的应用，不需要向管理员申请。请在插件页自己把它装到这位员工上。`;
        const held = await options.store.listForAgent(options.botId);
        if (held.tools.some((tool) => tool.ref.startsWith(`${found.appKey}/`)))
          return `「${found.title}」已经可以使用了，不需要申请。请直接调用它的工具。`;
        const kind: AppAccessRequestKind = (await options.store.isInstallListed(
          "mcp",
          found.appKey,
        ))
          ? "grant"
          : "enable";
        const filed = await options.store.fileAppAccessRequest({
          serverId: found.serverId,
          botId: options.botId,
          requesterUserId: options.actorId,
          kind,
          note: reason,
          maxPending: MAX_PENDING_APP_ACCESS_REQUESTS,
        });
        if (filed.outcome === "limited")
          return `${REFUSAL_MARKER} 对方已经有 ${MAX_PENDING_APP_ACCESS_REQUESTS} 条申请在等管理员处理，先撤回一条或等它们处理完，再申请「${found.title}」。`;
        const card: AppAccessRequestCard = {
          requestId: filed.request.id,
          appKey: found.appKey,
          title: found.title,
          kind,
          status: filed.outcome,
        };
        return writeAppAccessRequestAnswer(card, toldTheModel(card));
      },
    },
  ];
}

/**
 * 模型读到的话：发生了什么，以及对方眼前的卡片上实际有什么（上游 #1135：告诉模型卡片上真正显示的按钮），
 * 好让回复只是一句话，而不是重复卡片已经写明的步骤。
 */
function toldTheModel(card: AppAccessRequestCard): string {
  const asked =
    card.kind === "enable"
      ? `请管理员上架「${card.title}」`
      : `请管理员把「${card.title}」授予你`;
  const what =
    card.status === "created"
      ? `已向管理员申请访问：${asked}。`
      : `「${card.title}」已有待处理的申请（${asked}），没有重复提交。`;
  // 上架之后还要员工的主人在装配页安装（D08），员工才真正能用；先说清楚，免得对方以为批准就能用了。
  const after =
    card.kind === "enable"
      ? "管理员上架之后，还需要员工的主人在装配页把它装到这位员工上，员工才能使用。"
      : "";
  return `${what}${after}对方的对话里有一张卡片，写着「${card.title}」和「${card.status === "created" ? "已向管理员申请访问" : "已有待处理的申请"}」，并有一个「撤回申请」按钮；卡片上没有别的按钮。用一句话告诉对方在等管理员处理即可，不要重复卡片上的内容。管理员处理之前，不要改用浏览器去打开它的网站，也不要让对方去那里登录。`;
}
