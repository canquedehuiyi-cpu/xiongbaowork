/*
 * 参考站测量脚本：在打开 QoderWake CN 参考实例的浏览器里，把本文件全部内容粘进开发者工具控制台运行。
 *
 * 输出与 capture.ts 的测量 JSON 同结构（anchors / horizontalOverflow / scrollWidth / innerWidth），
 * 并自动复制到剪贴板，另存为 <out>/reference/<theme>/<宽>x<高>/<路由 slug>.json 即可与我方逐项比对。
 *
 * 参考站的 DOM 不一定带我方的 data-sidebar 属性，所以侧栏按"贴左、几乎满高、宽度 120–400px 的块"
 * 识别，其中的链接/按钮当作侧栏菜单项。只记录盒模型、字号和颜色；文字只取界面标签（按钮、链接、
 * 标题、输入框占位符），不读输入框里的值。分享前请自行检查 text 字段，去掉账号名、机器名等标识。
 */
(() => {
  const round = Math.round;
  const box = (selector, index, element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      selector,
      index,
      text: (
        element.getAttribute("aria-label") ??
        element.getAttribute("placeholder") ??
        (element.tagName === "INPUT" || element.tagName === "TEXTAREA"
          ? ""
          : element.innerText) ??
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40),
      x: round(rect.x),
      y: round(rect.y),
      w: round(rect.width),
      h: round(rect.height),
      fontSize: style.fontSize,
      color: style.color,
      backgroundColor: style.backgroundColor,
    };
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const sidebar =
    [
      ...document.querySelectorAll(
        '[data-sidebar="sidebar"], aside, nav, [role="navigation"], div',
      ),
    ].find((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.x <= 1 &&
        rect.height >= window.innerHeight * 0.9 &&
        rect.width >= 120 &&
        rect.width <= 400
      );
    }) ?? null;
  const main =
    document.querySelector("main") ??
    [...document.querySelectorAll("div")].find((element) => {
      const rect = element.getBoundingClientRect();
      return (
        sidebar &&
        rect.x >= sidebar.getBoundingClientRect().right - 1 &&
        rect.height >= window.innerHeight * 0.9
      );
    }) ??
    null;

  const anchors = [];
  if (sidebar) anchors.push(box('[data-sidebar="sidebar"]', 0, sidebar));
  if (main) anchors.push(box("main", 0, main));
  const heading = (main ?? document).querySelector("h1, h2");
  if (heading) anchors.push(box("h1", 0, heading));
  if (sidebar) {
    [...sidebar.querySelectorAll("a, button")]
      .filter(visible)
      .slice(0, 12)
      .forEach((element, index) => {
        anchors.push(box('[data-sidebar="menu-button"]', index, element));
      });
  }
  if (main) {
    [...main.querySelectorAll("button")]
      .filter(visible)
      .slice(0, 12)
      .forEach((element, index) => {
        anchors.push(box("main button", index, element));
      });
    [...main.querySelectorAll("input")]
      .filter(visible)
      .slice(0, 50)
      .forEach((element, index) => {
        anchors.push(box("main input", index, element));
      });
  }

  const result = {
    source: "reference",
    path: location.pathname + location.search,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    devicePixelRatio: window.devicePixelRatio,
    anchors,
    horizontalOverflow:
      document.documentElement.scrollWidth > window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  };
  const json = JSON.stringify(result, null, 2);
  try {
    // `copy` exists only in the DevTools console.
    copy(json);
    console.log("已复制到剪贴板：", result.anchors.length, "个锚点");
  } catch {
    console.log(json);
  }
  return result;
})();
