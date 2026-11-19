/**
 * `request_app_access` 的回答格式，服务端写、对话记录读，两边共用这一份声明。
 *
 * 服务端执行的工具到了对话记录里只是一段给模型看的文字，所以卡片要的字段放在第一行的标记后面，用 JSON
 * 写；后面的句子才是模型读的。改这里会同时改服务端和对话记录，不会出现一边改了另一边没改。
 */

/** 工具名，也是对话记录认出这张卡片的依据。 */
export const REQUEST_APP_ACCESS_TOOL = "request_app_access";

/** 回答第一行的开头，后面紧跟卡片的 JSON。 */
export const APP_ACCESS_REQUEST_MARKER = "<<openbot:app-access-request>>";

export type AppAccessRequestCard = {
  requestId: string;
  /** 应用的标识（目录键，或没有目录键时是应用行自己的 id）。 */
  appKey: string;
  /** 应用名，卡片上显示的就是它。 */
  title: string;
  /** `enable`：应用还没上架；`grant`：已上架，但这位员工没被授予。 */
  kind: "enable" | "grant";
  /** `created`：这次新建的申请；`existing`：已有一条待处理的，没有重复提交。 */
  status: "created" | "existing";
};

export function writeAppAccessRequestAnswer(
  card: AppAccessRequestCard,
  sentence: string,
): string {
  return `${APP_ACCESS_REQUEST_MARKER}${JSON.stringify(card)}\n${sentence}`;
}

/** 从工具回答里读出卡片和句子；不是这种回答（或字段不全）时为 null。 */
export function readAppAccessRequestAnswer(
  text: string,
): { card: AppAccessRequestCard; sentence: string } | null {
  if (!text.startsWith(APP_ACCESS_REQUEST_MARKER)) return null;
  const rest = text.slice(APP_ACCESS_REQUEST_MARKER.length);
  const newline = rest.indexOf("\n");
  const json = newline === -1 ? rest : rest.slice(0, newline);
  const sentence = newline === -1 ? "" : rest.slice(newline + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const card = parsed as Record<string, unknown>;
  if (
    typeof card.requestId !== "string" ||
    typeof card.appKey !== "string" ||
    typeof card.title !== "string" ||
    (card.kind !== "enable" && card.kind !== "grant") ||
    (card.status !== "created" && card.status !== "existing")
  )
    return null;
  return {
    card: {
      requestId: card.requestId,
      appKey: card.appKey,
      title: card.title,
      kind: card.kind,
      status: card.status,
    },
    sentence,
  };
}
