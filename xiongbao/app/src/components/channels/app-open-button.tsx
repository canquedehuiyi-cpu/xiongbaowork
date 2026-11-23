import { useState } from "react";
import { openInNewTab } from "@/components/channels/artifact-preview";
import { ARTIFACT_DOWNLOAD_LINK } from "@/components/channels/turn-artifacts";
import {
  type AppPreviewTarget,
  PORT_MODE_NOTICE,
  REPLACED_NOTICE,
  scopeFields,
  usePreviewTarget,
} from "@/lib/computers/preview";

/**
 * 交付卡上程序行的「打开」按钮，样式同「下载」「预览」。
 *
 * 页面有侧边栏（提供了预览开关）时，把程序目标写进 `preview` 参数，侧栏通过内容源打开它，同一时间只显示
 * 一个程序；没有侧边栏（任务页）时，点击同一刻同步开一个空白标签页，再向内容源要地址并导航过去。
 * 内容源没配置时按钮置灰并写明原因。
 */
export function AppOpenButton({
  target,
  label,
}: {
  target: AppPreviewTarget;
  label: string;
}) {
  const preview = usePreviewTarget();
  const [state, setState] = useState<
    "idle" | "busy" | "unavailable" | "failed"
  >("idle");
  const [blocked, setBlocked] = useState(false);
  // 端口模式下后开的程序能读到先开的：新标签页打开后在按钮旁提示，和侧栏的横幅同一句。
  const [notice, setNotice] = useState<{ replaces: boolean } | null>(null);
  // 打不开（出错）可以再试，只有没配内容源才置灰。
  const disabled = state === "busy" || state === "unavailable";
  const open = async () => {
    if (preview !== undefined) {
      preview.open(target);
      return;
    }
    setState("busy");
    setBlocked(false);
    setNotice(null);
    const answer = await openInNewTab(
      target.botId,
      {
        kind: "app",
        port: target.app.port,
        path: target.app.path,
        ...scopeFields(target.scope),
      },
      (opened) =>
        setNotice(
          opened.mode === "port" ? { replaces: opened.replaces } : null,
        ),
    );
    setBlocked(answer === "blocked");
    setState(answer === "unavailable" || answer === "failed" ? answer : "idle");
  };
  return (
    <>
      <button
        aria-label={`打开 ${label}`}
        className={ARTIFACT_DOWNLOAD_LINK}
        disabled={disabled}
        onClick={open}
        type="button"
      >
        打开
      </button>
      {state === "unavailable" ? (
        <span className="text-[12px]">没有配置内容源，不能打开程序</span>
      ) : null}
      {state === "failed" ? (
        <span className="text-[12px]">打不开这个程序</span>
      ) : null}
      {notice !== null ? (
        // 单独占一行（父级是可换行的横排），左边与标题文字对齐：图标 16px + 间距 10px。
        <span className="order-last basis-full pl-[26px] text-[12px] text-amber-700 dark:text-amber-300">
          {PORT_MODE_NOTICE}
          {notice.replaces ? ` ${REPLACED_NOTICE}` : ""}
        </span>
      ) : null}
      {blocked ? (
        <span className="text-[12px]">浏览器拦截了新标签页</span>
      ) : null}
    </>
  );
}
