import { useState } from "react";
import { openInNewTab } from "@/components/channels/artifact-preview";
import { ARTIFACT_DOWNLOAD_LINK } from "@/components/channels/turn-artifacts";
import {
  type AppPreviewTarget,
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
  const [state, setState] = useState<"idle" | "busy" | "unavailable">("idle");
  const [blocked, setBlocked] = useState(false);
  const disabled = state !== "idle";
  const open = async () => {
    if (preview !== undefined) {
      preview.open(target);
      return;
    }
    setState("busy");
    setBlocked(false);
    const answer = await openInNewTab(target.botId, {
      kind: "app",
      port: target.app.port,
      path: target.app.path,
      ...scopeFields(target.scope),
    });
    setBlocked(answer === "blocked");
    setState(answer === "unavailable" ? "unavailable" : "idle");
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
      {blocked ? (
        <span className="text-[12px]">浏览器拦截了新标签页</span>
      ) : null}
    </>
  );
}
