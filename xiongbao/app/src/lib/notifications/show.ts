/** A notification XiongBao raises, and the page of XiongBao a click on it opens. */
export type Notice = {
  title: string;
  body: string;
  /** Two tabs raising the same notice show it once. */
  tag: string;
  /** An XiongBao path: `/channel/c-1`, `/bots/expenses`. */
  path: string;
  /** What a click does. */
  onClick?: () => void;
};

/**
 * The tag of every notice about one conversation, whether it replied or needs the person: a browser
 * and Windows replace a notice with the next of the same tag, so one conversation's moment is one
 * notice however it was raised.
 */
export function conversationTag(channelId: string): string {
  return `xiongbao-${channelId}`;
}

/** Whether the person can see XiongBao now, in which case what is on screen says it all. */
export function inSight(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** Raises `notice`, if notifications may be shown (the caller asks `notificationsAllowed` first). */
export function showNotice(notice: Notice): void {
  const options: NotificationOptions & { extra: { path: string } } = {
    body: notice.body,
    tag: notice.tag,
    extra: { path: notice.path },
  };
  try {
    const shown = new Notification(notice.title, options);
    if (notice.onClick) {
      const open = notice.onClick;
      shown.onclick = () => {
        window.focus();
        open();
        shown.close?.();
      };
    }
  } catch {
    // A browser that refuses the constructor still has the badge.
  }
}
