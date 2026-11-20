import type { Message } from "@ag-ui/client";

/**
 * 工具结果里夹着的二进制数据（电脑截图的 `base64`、网页里内嵌的 data URI），和发给模型之前把它拿掉。
 *
 * 为什么：电脑的截图工具把一张 PNG 的 base64 放在结果的文字里，一张 1280×800 的截图约 40 万个字符。界面要它
 * （把它画出来），模型读不了它：文字模型看不见图，只是一长串字符，提供方却照字数收 token。评测里单聊和看板的
 * 一道调研题，每次截图之后连着四步每步多发十几万 token，就是它。
 *
 * 做法：只改发给模型的那一份。存起来的对话和界面上的截图一个字不动；发给模型的历史里，这一段换成一句说明，
 * 说清楚图在哪、要看内容用什么。没有二进制数据时，历史原样返回（同一个数组）。每一步都从存起来的历史重新算，
 * 同一条消息永远换成同一句话，所以提供方的缓存前缀不会因此改变。
 */

/** 一连串不间断的 base64 字符，至少这么长才算二进制数据；更短的是普通文字里的 token、哈希、短图标。 */
export const BLOB_MIN_CHARS = 4_096;
/**
 * 二进制数据的字符估成多少 token：base64 的字符近乎随机，提供方的分词器大约一个半字符一个 token，不是 ASCII
 * 文字的 3.5。按 3.5 估会把一张截图少算一半以上，折叠的越线判断就慢了。
 */
export const BLOB_CHARS_PER_TOKEN = 1.5;

const BLOB_RUN = new RegExp(`[A-Za-z0-9+/]{${BLOB_MIN_CHARS},}={0,2}`, "g");
const BLOB_SAMPLE = 1_024;
const BLOB_MIN_DISTINCT = 32;

/**
 * 这一段是不是二进制数据：够长，而且字符五花八门。压缩过的图片编出来的 base64 前面一千个字符里几乎六十四种
 * 字符都出现；一长串重复的字（`xxxx…`、`0000…`、分隔线）不是，它们是普通文字，照原样估、照原样折。
 */
export function isBlob(run: string): boolean {
  return new Set(run.slice(0, BLOB_SAMPLE)).size >= BLOB_MIN_DISTINCT;
}

/** 文字里的二进制数据一共多少字符。没有就是 0。 */
export function blobChars(text: string): number {
  if (text.length < BLOB_MIN_CHARS) return 0;
  let total = 0;
  for (const found of text.matchAll(BLOB_RUN))
    if (isBlob(found[0])) total += found[0].length;
  return total;
}

/** 折叠摘要里二进制数据的说明。 */
export const blobNote = (chars: number) => `[二进制数据 ${chars} 字符，已省略]`;

/** 截图（`"base64":"…"`）发给模型时的说明：图在界面上，模型要内容就去读页面。 */
export const screenshotNote = (chars: number) =>
  `[截图 ${chars} 字符的图片数据已省略：它显示在用户的界面上，没有发给模型。要看页面里的文字用 computer_read，要看能点的元素用 computer_snapshot]`;

const SCREENSHOT_KEY = '"base64":"';

/**
 * 把文字里的二进制数据换成一句说明，别的字原样；没有二进制数据就是同一个字符串。
 * `note` 给每一段二进制数据换成什么（默认 {@link blobNote}）。
 */
export function withoutBlobs(
  text: string,
  note: (chars: number, key: boolean) => string = (chars) => blobNote(chars),
): string {
  if (blobChars(text) === 0) return text;
  return text.replace(BLOB_RUN, (run, offset: number, whole: string) =>
    isBlob(run)
      ? note(
          run.length,
          whole.slice(Math.max(0, offset - SCREENSHOT_KEY.length), offset) ===
            SCREENSHOT_KEY,
        )
      : run,
  );
}

/**
 * 发给模型的历史：每条工具结果里的二进制数据换成说明。截图（紧跟在 `"base64":"` 后面的）说它在界面上、
 * 怎么读页面；别的二进制数据说「已省略」。没有要改的消息，返回同一个数组；要改的消息换成新对象，别的原样。
 */
export function withoutToolBlobs<T extends Message>(
  messages: readonly T[],
): T[] {
  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== "tool" || typeof message.content !== "string")
      return message;
    const content = withoutBlobs(message.content, (chars, key) =>
      key ? screenshotNote(chars) : blobNote(chars),
    );
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? result : (messages as T[]);
}
