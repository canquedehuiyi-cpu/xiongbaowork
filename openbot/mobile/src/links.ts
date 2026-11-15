/**
 * Where a tap on a notification goes, read from the link the server put in it. Only known screens,
 * and only an `xiongbao:` link with nothing in it that could point anywhere else. A ping opens
 * the person's Needs you list, and needs no conversation to name. A briefing and a late-card
 * reminder have no native screen: they open the web workbench's `/briefing` and `/tasks/<id>`
 * (spec 2026-11-15-delivery-loop §10), so the answer is a web path for the app to open on its server.
 * A reminder with no usable card id falls back to the briefing; anything unknown answers null.
 */
export type NotificationDestination =
  | {
      pathname: "/conversation" | "/approvals";
      params: { channelId: string; requestId?: string };
    }
  | { pathname: "/needs-you"; params: Record<string, never> }
  | { webPath: string };

const briefing: NotificationDestination = { webPath: "/briefing" };

function taskDestination(id: unknown): NotificationDestination {
  if (typeof id !== "string" || !id || id.length > 200 || /[/?#\\]/.test(id))
    return briefing;
  return { webPath: `/tasks/${encodeURIComponent(id)}` };
}

export function notificationDestination(
  value: unknown,
): NotificationDestination | null {
  if (!value || typeof value !== "object") return null;
  const data = value as { url?: unknown; kind?: unknown; taskId?: unknown };
  const fallback =
    data.kind === "briefing"
      ? briefing
      : data.kind === "overdue"
        ? taskDestination(data.taskId)
        : null;
  if (typeof data.url !== "string") return fallback;
  let url: URL;
  try {
    url = new URL(data.url);
  } catch {
    return fallback;
  }
  if (
    url.protocol !== "xiongbao:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port
  )
    return null;
  if (url.hostname === "tasks") {
    if (url.search) return null;
    let id = "";
    try {
      id = decodeURIComponent(url.pathname.replace(/^\//, ""));
    } catch {}
    return taskDestination(id);
  }
  if (url.pathname && url.pathname !== "/") return null;
  if (url.hostname === "briefing") return url.search ? null : briefing;
  if (url.hostname === "needs-you")
    return url.search ? null : { pathname: "/needs-you", params: {} };
  if (url.hostname !== "conversation" && url.hostname !== "approvals")
    return null;
  const channelId = url.searchParams.get("channelId");
  const requestId = url.searchParams.get("requestId");
  if (!channelId || channelId.length > 200 || (requestId?.length ?? 0) > 200)
    return null;
  return {
    pathname: url.hostname === "conversation" ? "/conversation" : "/approvals",
    params: { channelId, ...(requestId ? { requestId } : {}) },
  };
}
