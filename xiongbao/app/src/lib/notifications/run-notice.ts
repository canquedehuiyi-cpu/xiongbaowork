import { notificationsAllowed } from "./permission";
import { inSight, showNotice } from "./show";

/**
 * 员工一轮跑完、而你不在这段对话的页面上时的系统通知（期九·五）。服务器把它放在花名册 socket 的一条事件里，
 * 只带这一条通知，事件自己的 `channelId` 是空的。页面只在自己也不在视线内时才弹：在看着的页面，屏幕上的
 * 内容已经说明一切。浏览器弹浏览器的通知，桌面版走桌面版自己的通知（`showNotice`）。
 */
export type RunNotice = {
  /** 这段对话；点通知打开它。 */
  channelId: string;
  title: string;
  body: string;
  /** 同一段对话的通知共用一个 tag，新的替换旧的。 */
  tag: string;
  path: string;
};

/** 弹这条通知，或什么都不做：没有授权、或页面正在视线内。 */
export async function showRunNotice(
  runNotice: RunNotice,
  open: (channelId: string) => void,
): Promise<void> {
  if (!(await notificationsAllowed())) return;
  // 等桌面版答复的这一会儿，人可能已经回到页面上，所以授权之后再看一次。
  if (inSight()) return;
  showNotice({ ...runNotice, onClick: () => open(runNotice.channelId) });
}
