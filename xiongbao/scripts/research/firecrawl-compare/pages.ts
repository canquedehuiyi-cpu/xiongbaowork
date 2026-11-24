/**
 * 对比用的测试页和各页的标准答案。
 *
 * 页面内容全部写死、确定生成：同一份代码任何时候生成的页面都一样，标准答案（正文段落、关键事实、表格单元格、
 * 噪声词）先于任何工具的输出写下，评分只拿它们当尺子。
 */

export type Truth = {
  /** 正文里应该读到的段落，逐段原文。 */
  paragraphs: string[];
  /** 必须原样出现的关键事实（日期、编号、数字）。 */
  facts: string[];
  /** 表格行，每行按列顺序给单元格；没有表格为空。 */
  tableRows: string[][];
  /** 不属于正文的导航、广告、页脚词句；出现在输出里就算噪声。 */
  noise: string[];
  /** 正文要靠脚本执行才出现在页面里。 */
  needsJs: boolean;
};

export type TestPage = {
  id: string;
  /** 报告里用的名字。 */
  label: string;
  /** 本机服务器上的路径。 */
  path: string;
  contentType: string;
  /** HTML 页是页面本身；PDF 页是生成 PDF 用的 HTML 源。 */
  html: string;
  /** 页面要转成 PDF 再提供。 */
  asPdf: boolean;
  truth: Truth;
};

const articleParagraphs = [
  "港口调度中心在 2026 年 3 月 12 日发布了第 7 号公告，宣布从下个月起把夜间装卸窗口从原来的四小时延长到六小时，以缓解春季集装箱积压。",
  "公告引用的数据显示，上一季度平均每艘货轮的等泊时间为 31.4 小时，其中 4,862 个标准箱因为窗口不足被推迟到次日处理，占总吞吐量的 0.37%。",
  "负责人王海涛在发布会上表示，延长窗口不会增加人手，而是把原先分散在三个泊位的龙门吊集中到两个泊位，编号 B-12 与 B-15 的泊位将承担全部夜间作业。",
  "船公司对此反应不一。一部分公司欢迎更长的窗口，另一部分担心集中作业会让单个泊位的拥堵风险上升。调度中心承诺在试行第 30 天公布评估结果。",
  "The pilot also introduces a booking rule: carriers must confirm the berth slot at least 18 hours ahead, otherwise the slot returns to the open pool.",
  "与窗口调整同时生效的还有一项收费变化：超过预约时间 90 分钟仍未靠泊的船只，将按每小时 2,300 元的标准缴纳占位费。",
  "调度中心还公布了试行期的三项观察指标：平均等泊时间、夜间事故数、龙门吊空转率。其中空转率的基线值为 18.6%，目标是降到 12% 以下。",
  "公告最后说明，试行期为 90 天，期间如出现连续三个夜晚的泊位占用率超过 95%，调度中心有权临时恢复原窗口，并在 24 小时内向所有船公司书面通知。",
];

const articleFacts = [
  "2026 年 3 月 12 日",
  "第 7 号公告",
  "31.4 小时",
  "4,862",
  "0.37%",
  "B-12",
  "B-15",
  "18 hours",
  "2,300 元",
  "18.6%",
];

const NAV_NOISE = [
  "首页 产品中心 价格方案 登录 注册",
  "限时特惠 全场五折 立即抢购",
  "广告 赞助内容 点击领取优惠券",
  "我们使用 Cookie 改善体验 接受全部 Cookie",
  "订阅我们的周刊 输入邮箱 立即订阅",
  "猜你喜欢",
  "热门推荐",
  "阅读更多",
  "版权所有 京ICP备00000000号 联系我们 隐私政策",
  "分享到 微信 微博 复制链接",
];

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function paragraphsHtml(items: string[]): string {
  return items.map((item) => `<p>${escapeHtml(item)}</p>`).join("\n");
}

function shell(title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${head}</head>
<body>
${body}
</body>
</html>
`;
}

function staticArticle(): TestPage {
  const html = shell(
    "港口夜间装卸窗口延长",
    `<article>
<h1>港口夜间装卸窗口延长</h1>
<p class="byline">调度中心新闻办 · 2026 年 3 月 12 日</p>
${paragraphsHtml(articleParagraphs)}
</article>`,
  );
  return {
    id: "static-article",
    label: "静态文章",
    path: "/static-article.html",
    contentType: "text/html; charset=utf-8",
    html,
    asPdf: false,
    truth: {
      paragraphs: articleParagraphs,
      facts: articleFacts,
      tableRows: [],
      noise: [],
      needsJs: false,
    },
  };
}

function jsArticle(): TestPage {
  const data = JSON.stringify(articleParagraphs);
  // 正文只存在于脚本里的数据中，页面本身只有「加载中」。
  const html = shell(
    "港口夜间装卸窗口延长（脚本渲染）",
    `<div id="app"><p>正在加载…</p></div>
<script>
  const paragraphs = ${data};
  window.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => {
      const app = document.getElementById("app");
      app.innerHTML = "";
      const article = document.createElement("article");
      const heading = document.createElement("h1");
      heading.textContent = "港口夜间装卸窗口延长";
      article.appendChild(heading);
      for (const text of paragraphs) {
        const p = document.createElement("p");
        p.textContent = text;
        article.appendChild(p);
      }
      app.appendChild(article);
    }, 150);
  });
</script>`,
  );
  return {
    id: "js-article",
    label: "脚本渲染页",
    path: "/js-article.html",
    contentType: "text/html; charset=utf-8",
    html,
    asPdf: false,
    truth: {
      paragraphs: articleParagraphs,
      facts: articleFacts,
      tableRows: [],
      noise: ["正在加载"],
      needsJs: true,
    },
  };
}

const WAREHOUSES = ["上海一仓", "苏州二仓", "成都三仓", "武汉四仓"];

export const TABLE_ROWS: string[][] = Array.from({ length: 80 }, (_, index) => {
  const n = index + 1;
  const sku = `SKU-${String(n).padStart(4, "0")}`;
  const price = (n * 37.5 + 1280).toFixed(2);
  return [
    sku,
    `型号${String.fromCharCode(65 + (n % 26))}${n * 7}`,
    `¥${price}`,
    String(n * 13 + 200),
    WAREHOUSES[n % WAREHOUSES.length] as string,
  ];
});
const TABLE_HEAD = ["编号", "型号", "单价", "库存", "仓库"];

function tableHtml(rows: string[][]): string {
  const head = `<tr>${TABLE_HEAD.map((cell) => `<th>${cell}</th>`).join("")}</tr>`;
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
    )
    .join("\n");
  return `<table border="1">\n<thead>${head}</thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

const tableIntro = "下表列出本季度全部在售商品的编号、单价与分仓库存。";

function longTable(): TestPage {
  const html = shell(
    "季度商品库存表",
    `<article>
<h1>季度商品库存表</h1>
<p>${tableIntro}</p>
${tableHtml(TABLE_ROWS)}
</article>`,
  );
  return {
    id: "long-table",
    label: "长表格（80 行 x 5 列）",
    path: "/long-table.html",
    contentType: "text/html; charset=utf-8",
    html,
    asPdf: false,
    truth: {
      paragraphs: [tableIntro],
      facts: ["SKU-0001", "SKU-0080", "¥4280.00"],
      tableRows: TABLE_ROWS,
      noise: [],
      needsJs: false,
    },
  };
}

function noisyArticle(): TestPage {
  const html = shell(
    "港口夜间装卸窗口延长 - 新闻中心",
    `<header><nav><a href="/">首页</a> <a href="/p">产品中心</a> <a href="/price">价格方案</a> <a href="/login">登录</a> <a href="/signup">注册</a></nav></header>
<div class="banner ad"><a href="/sale">限时特惠 全场五折 立即抢购</a></div>
<div class="cookie"><p>我们使用 Cookie 改善体验</p><button>接受全部 Cookie</button></div>
<div class="layout">
<aside class="sidebar">
<div class="ad"><p>广告</p><p>赞助内容 点击领取优惠券</p></div>
<div class="newsletter"><p>订阅我们的周刊</p><p>输入邮箱</p><button>立即订阅</button></div>
</aside>
<main>
<article>
<h1>港口夜间装卸窗口延长</h1>
<div class="share"><a href="#">分享到</a> <a href="#">微信</a> <a href="#">微博</a> <a href="#">复制链接</a></div>
${paragraphsHtml(articleParagraphs)}
</article>
<section class="related"><h2>猜你喜欢</h2><ul><li><a href="/a">热门推荐 春季运价走势</a></li><li><a href="/b">热门推荐 新泊位启用</a></li><li><a href="/c">阅读更多</a></li></ul></section>
</main>
</div>
<footer><p>版权所有 京ICP备00000000号</p><p><a href="/c">联系我们</a> <a href="/p">隐私政策</a></p></footer>`,
  );
  return {
    id: "noisy-article",
    label: "带导航与广告噪声的页",
    path: "/noisy-article.html",
    contentType: "text/html; charset=utf-8",
    html,
    asPdf: false,
    truth: {
      paragraphs: articleParagraphs,
      facts: articleFacts,
      tableRows: [],
      noise: NAV_NOISE,
      needsJs: false,
    },
  };
}

/** 没有 header/nav/aside/footer 这些语义标签，噪声和正文都是 div，靠类名区分。 */
function noisyDivs(): TestPage {
  const html = shell(
    "港口夜间装卸窗口延长 - 资讯",
    `<div class="top"><div class="menu"><a href="/">首页</a> <a href="/p">产品中心</a> <a href="/price">价格方案</a> <a href="/login">登录</a> <a href="/signup">注册</a></div></div>
<div class="promo"><a href="/sale">限时特惠 全场五折 立即抢购</a></div>
<div class="wrap">
<div class="left">
<div class="box"><div class="tag">广告</div><div>赞助内容 点击领取优惠券</div></div>
<div class="box"><div>订阅我们的周刊</div><div>输入邮箱</div><div>立即订阅</div></div>
</div>
<div class="content">
<div class="title">港口夜间装卸窗口延长</div>
<div class="tools"><span>分享到</span> <span>微信</span> <span>微博</span> <span>复制链接</span></div>
${articleParagraphs.map((item) => `<div class="text">${escapeHtml(item)}</div>`).join("\n")}
<div class="more"><div class="more-title">猜你喜欢</div><div><a href="/a">热门推荐 春季运价走势</a></div><div><a href="/b">热门推荐 新泊位启用</a></div><div><a href="/c">阅读更多</a></div></div>
</div>
</div>
<div class="bottom"><div>版权所有 京ICP备00000000号</div><div><a href="/c">联系我们</a> <a href="/p">隐私政策</a></div></div>
<div class="consent"><div>我们使用 Cookie 改善体验</div><div>接受全部 Cookie</div></div>`,
  );
  return {
    id: "noisy-divs",
    label: "噪声页（全是 div，无语义标签）",
    path: "/noisy-divs.html",
    contentType: "text/html; charset=utf-8",
    html,
    asPdf: false,
    truth: {
      paragraphs: articleParagraphs,
      facts: articleFacts,
      tableRows: [],
      noise: NAV_NOISE,
      needsJs: false,
    },
  };
}

const PDF_ROWS = TABLE_ROWS.slice(0, 12);

function pdfDocument(): TestPage {
  const paragraphs = articleParagraphs.slice(0, 4);
  const html = shell(
    "港口夜间装卸窗口延长（PDF）",
    `<h1>港口夜间装卸窗口延长</h1>
${paragraphsHtml(paragraphs)}
<h2>附表：部分商品库存</h2>
${tableHtml(PDF_ROWS)}`,
    `<style>body{font-family:"Noto Sans CJK SC","WenQuanYi Zen Hei",sans-serif;font-size:11pt}table{border-collapse:collapse}td,th{padding:2px 6px}</style>`,
  );
  return {
    id: "pdf-report",
    label: "PDF（正文 + 12 行表）",
    path: "/pdf-report.pdf",
    contentType: "application/pdf",
    html,
    asPdf: true,
    truth: {
      paragraphs,
      facts: articleFacts.slice(0, 6),
      tableRows: PDF_ROWS,
      noise: [],
      needsJs: false,
    },
  };
}

export function buildPages(): TestPage[] {
  return [
    staticArticle(),
    jsArticle(),
    longTable(),
    noisyArticle(),
    noisyDivs(),
    pdfDocument(),
  ];
}
