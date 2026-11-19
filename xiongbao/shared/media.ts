/**
 * 员工生成图片、视频，以及在电脑上生成文档类文件：工具名、存下来的文件的站内地址，和只说给持有这些
 * 能力的员工的那段提示词。
 *
 * 工具在服务器上（`server/src/media/tools.ts`）：`generate_image` 出图，`generate_video` 提交视频任务并
 * 等一会儿，没等到就交出任务号，由 `check_video` 稍后再取。生成的文件存在这个部署里
 * （`generated_media` 表），地址是 `/api/media/<id>`，登录的人在浏览器里直接打开。
 *
 * 文档类文件（Word、Excel、PPT、PDF）不走工具：员工在自己的电脑工作区里用镜像装好的 Python 库生成
 * （`docker/docs-toolchain`），生成后打开校验，再按交付规约交付。
 */

export const GENERATE_IMAGE_TOOL = "generate_image";
export const GENERATE_VIDEO_TOOL = "generate_video";
export const CHECK_VIDEO_TOOL = "check_video";

/** 存下来的图片、视频的站内地址前缀，和服务器 `app.route("/api/media", …)` 同一个。 */
export const MEDIA_PATH = "/api/media";

/** 一个存下来的文件的站内地址。 */
export function mediaUrl(id: string): string {
  return `${MEDIA_PATH}/${encodeURIComponent(id)}`;
}

/** 一条站内地址指向的那个文件的 id；不是站内媒体地址就是 undefined。 */
export function mediaIdOf(url: string): string | undefined {
  const match = url
    .trim()
    .match(/^(?:https?:\/\/[^/]+)?\/api\/media\/([0-9a-f-]{36})(?:[?#].*)?$/i);
  return match?.[1]?.toLowerCase();
}

/** 持有出图工具时说的话。 */
const IMAGE_WORDS = `要图片（插图、海报、示意图、头像等）就用 ${GENERATE_IMAGE_TOOL} 生成，不要说自己不会画图，也不要用文字描述代替图片。`;

/**
 * 持有出图工具时说的话：图片也会写进员工自己电脑的工作区，路径在工具结果里。电脑上的脚本取不到
 * `/api/media` 地址（要登录会话），所以做进 Word、PPT 要用这个路径。
 */
const IMAGE_FILE_WORDS = `生成好的图片，如果你有电脑，也会同时存进电脑工作区的 generated/ 文件夹里，路径在 ${GENERATE_IMAGE_TOOL} 的结果里（形如 generated/<id>.png）。要把图片放进 Word、PPT 等文档，就用这个路径，在电脑上直接读这个文件（python-docx、python-pptx 的 add_picture 等）；电脑上取不到 /api/media 地址，不要去下载它。结果里没有路径，就是电脑上没有这张图，只能给对方看站内地址。`;

/** 持有视频工具时说的话。 */
const VIDEO_WORDS = `要视频就用 ${GENERATE_VIDEO_TOOL}；视频要几分钟才生成好，它先等一会儿，没等到会给你一个任务号，过一会儿用 ${CHECK_VIDEO_TOOL} 带上任务号取结果，不要反复提交同一个视频。可以把刚生成的图片地址作为 image_url 让图片动起来。视频比较大，不会放进电脑工作区，只给站内地址。`;

/** 两种都适用：怎么把结果给人看。 */
const SHOW_WORDS =
  "生成好会给你一条站内地址：图片在回复里用 markdown 图片写法 `![说明](地址)` 放出来，视频写成链接 `[说明](地址)`，对方点开就能看。没调用工具就不要说已经生成了，也不要自己编地址。工具说没配置或生成失败时，照实告诉对方。";

/**
 * 在电脑工作区里生成文档类文件：用哪些库、中文字体在哪、生成后怎么校验、收到的文件怎么读。
 * 只说给这一轮能用电脑的员工。
 */
export const DOCUMENTS_GUIDANCE =
  "要 Word、Excel、PPT、PDF 文件，就在电脑工作区里用 Python 生成：Word 用 python-docx，Excel 用 openpyxl（单元格里写公式，不写算好的数），PPT 用 python-pptx，PDF 用 weasyprint 把 HTML 排成 PDF，或用 reportlab（中文要注册字体 /usr/share/fonts/truetype/wqy/wqy-microhei.ttc）；markdown 和 Word 互转用 pandoc；电脑上有 soffice 时可以用 `soffice --headless --convert-to pdf 文件` 转成 PDF。生成后一定打开校验：重新读回内容，或转成 PDF、图片看一眼版面，确认中文没有变成方块、没有缺页漏段，再交付。读 PDF 或 Office 文件时，先用 `markitdown <文件>` 转成文本再读。";

/**
 * 只说给持有这些能力的员工：出图、出视频的工具在手上才说怎么用它们，这一轮能用电脑才说怎么生成文档。
 * 两样都没有就什么也不说，提示词和以前一字不差。
 */
export function mediaGuidance(
  toolNames: readonly string[],
  options: { computer: boolean },
): string | undefined {
  const image = toolNames.includes(GENERATE_IMAGE_TOOL);
  const video = toolNames.includes(GENERATE_VIDEO_TOOL);
  const parts = [
    ...(image ? [IMAGE_WORDS, IMAGE_FILE_WORDS] : []),
    ...(video ? [VIDEO_WORDS] : []),
    ...(image || video ? [SHOW_WORDS] : []),
    ...(options.computer ? [DOCUMENTS_GUIDANCE] : []),
  ];
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
