import { IconX } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import { ARTIFACT_DOWNLOAD_LINK } from "@/components/channels/turn-artifacts";
import { artifactHref } from "@/lib/computers/artifact";
import {
  CSV_ROW_LIMIT,
  type PreviewTarget,
  parseCsv,
  previewHref,
  previewKindOfTarget,
  textHref,
} from "@/lib/computers/preview";

/*
 * 侧边栏里的文件预览面板。
 *
 * 文件是员工写的，内容不可信：这里从不在本页的源里执行它。图片、音视频交给原生标签；html 放进
 * `sandbox="allow-scripts"` 的 iframe（没有 allow-same-origin，拿不到本页的 cookie 和存储）；pdf 与
 * office 转出的 pdf 也放 iframe，但元素上不能带 sandbox——它会拦掉浏览器的 PDF 查看器——隔离靠服务器
 * 响应头里的 CSP sandbox。文本类（markdown、csv、纯文本）只画成文字或表格，markdown 不渲染成 html。
 * 面板不听 iframe 的任何 message。
 */

const BAR_LINK =
  "shrink-0 underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

/** 文本类内容的服务器答案。 */
type TextAnswer = {
  kind: "markdown" | "csv" | "text";
  text: string;
  truncated: boolean;
};

/** 一次取回的结果：还在取、能画、预览不了这个类型、取失败。 */
type Loaded<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "unsupported" }
  | { state: "failed" };

/** 取一个地址的 JSON（文本类）。`url` 变了就重取，卸载时作废。 */
function useTextAnswer(url: string | undefined, enabled: boolean) {
  const [loaded, setLoaded] = useState<Loaded<TextAnswer>>({
    state: "loading",
  });
  useEffect(() => {
    if (!enabled) return;
    if (url === undefined) {
      setLoaded({ state: "failed" });
      return;
    }
    setLoaded({ state: "loading" });
    const abort = new AbortController();
    (async () => {
      try {
        const response = await fetch(url, { signal: abort.signal });
        if (response.status === 415) return setLoaded({ state: "unsupported" });
        if (!response.ok) return setLoaded({ state: "failed" });
        const body = (await response.json()) as Partial<TextAnswer>;
        if (typeof body.text !== "string")
          return setLoaded({ state: "failed" });
        setLoaded({
          state: "ready",
          value: {
            kind: body.kind ?? "text",
            text: body.text,
            truncated: body.truncated === true,
          },
        });
      } catch {
        if (!abort.signal.aborted) setLoaded({ state: "failed" });
      }
    })();
    return () => abort.abort();
  }, [url, enabled]);
  return loaded;
}

/** office：先问一次，转不了时服务器答 200 的 `{unavailable:true}`，否则是 pdf，交给 iframe 去显示。 */
function useOfficeAvailable(url: string | undefined, enabled: boolean) {
  const [loaded, setLoaded] = useState<Loaded<true>>({ state: "loading" });
  useEffect(() => {
    if (!enabled) return;
    if (url === undefined) {
      setLoaded({ state: "failed" });
      return;
    }
    setLoaded({ state: "loading" });
    const abort = new AbortController();
    (async () => {
      try {
        const response = await fetch(url, { signal: abort.signal });
        if (!response.ok) return setLoaded({ state: "failed" });
        const type = response.headers.get("content-type") ?? "";
        if (type.includes("application/json")) {
          const body = (await response.json()) as { unavailable?: unknown };
          return setLoaded(
            body.unavailable === true
              ? { state: "unsupported" }
              : { state: "failed" },
          );
        }
        // 不读 pdf 的内容：iframe 会自己再取一次。
        await response.body?.cancel().catch(() => {});
        setLoaded({ state: "ready", value: true });
      } catch {
        if (!abort.signal.aborted) setLoaded({ state: "failed" });
      }
    })();
    return () => abort.abort();
  }, [url, enabled]);
  return loaded;
}

function Note({
  children,
  download,
}: {
  children: ReactNode;
  download?: string;
}) {
  return (
    <div className="flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground">
      <span>{children}</span>
      {download === undefined ? null : (
        <a className={ARTIFACT_DOWNLOAD_LINK} download="" href={download}>
          下载
        </a>
      )}
    </div>
  );
}

function CsvTable({ text }: { text: string }) {
  const rows = parseCsv(text);
  const [head, ...rest] = rows.slice(0, CSV_ROW_LIMIT + 1);
  const hidden = rows.length - 1 - CSV_ROW_LIMIT;
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="overflow-auto">
        <table className="border-collapse text-xs">
          {head === undefined ? null : (
            <thead>
              <tr>
                {head.map((cell, column) => (
                  <th
                    className="border border-border bg-card px-2 py-1 text-left font-medium"
                    // biome-ignore lint/suspicious/noArrayIndexKey: 表头只按列排
                    key={column}
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rest.map((row, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 表格行没有别的身份，且不会重排
              <tr key={index}>
                {row.map((cell, column) => (
                  <td
                    className="border border-border px-2 py-1 align-top"
                    // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                    key={column}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 ? (
        <span className="text-xs text-muted-foreground">
          只显示了前 {CSV_ROW_LIMIT} 行，共 {rows.length - 1} 行。
        </span>
      ) : null}
    </div>
  );
}

function TextBody({ answer }: { answer: TextAnswer }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {answer.truncated ? (
        <span className="px-3 pt-3 text-xs text-muted-foreground">
          只显示了前 1MB。
        </span>
      ) : null}
      {answer.kind === "csv" ? (
        <CsvTable text={answer.text} />
      ) : (
        <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs">
          {answer.text}
        </pre>
      )}
    </div>
  );
}

const FRAME = "min-h-0 w-full flex-1 border-0 bg-background";

export function ArtifactPreview({
  target,
  onClose,
}: {
  target: PreviewTarget;
  onClose: () => void;
}) {
  const kind = previewKindOfTarget(target);
  const textual = kind === "markdown" || kind === "csv" || kind === "text";
  const src = previewHref(target);
  const download = artifactHref(target);
  const name = target.path.split("/").pop() ?? target.path;
  const text = useTextAnswer(textHref(target), textual);
  const office = useOfficeAvailable(src, kind === "office");
  // 一次取回的结果只对取它的那个地址有效：换了文件，下一帧先当作「还在取」。
  const [failedImage, setFailedImage] = useState<string>();
  const imageFailed = failedImage === src;

  const unsupported = (
    <Note download={download}>预览不了这个类型，可以下载后查看。</Note>
  );
  const failed = <Note download={download}>预览加载失败</Note>;

  let body: ReactNode;
  let canOpen = !textual;
  if (kind === "none") {
    body = unsupported;
    canOpen = false;
  } else if (src === undefined) body = failed;
  else if (textual) {
    if (text.state === "loading") body = <Note>加载中…</Note>;
    else if (text.state === "unsupported") {
      body = unsupported;
    } else if (text.state === "failed") body = failed;
    else body = <TextBody answer={text.value} />;
  } else if (kind === "image")
    body = imageFailed ? (
      failed
    ) : (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
        <img
          alt={name}
          className="max-h-full max-w-full object-contain"
          onError={() => setFailedImage(src)}
          src={src}
        />
      </div>
    );
  else if (kind === "video")
    body = (
      // biome-ignore lint/a11y/useMediaCaption: 员工的文件没有字幕轨
      <video className="max-h-full w-full" controls src={src} />
    );
  else if (kind === "audio")
    body = (
      // biome-ignore lint/a11y/useMediaCaption: 员工的文件没有字幕轨
      <audio className="m-3 w-[calc(100%-1.5rem)]" controls src={src} />
    );
  else if (kind === "html")
    body = (
      <iframe
        className={FRAME}
        // 恰好这个值：能跑脚本，但没有 allow-same-origin，拿不到本页的 cookie 和存储。
        sandbox="allow-scripts"
        src={src}
        title={name}
      />
    );
  else if (kind === "pdf")
    // 不加 sandbox 属性：它会拦掉 PDF 查看器。隔离靠响应头里的 CSP sandbox。
    body = <iframe className={FRAME} src={src} title={name} />;
  else if (office.state === "loading") body = <Note>正在转成 PDF…</Note>;
  else if (office.state === "unsupported") {
    body = unsupported;
    canOpen = false;
  } else if (office.state === "failed") body = failed;
  else body = <iframe className={FRAME} src={src} title={name} />;

  return (
    <section
      aria-label={`预览 ${name}`}
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      data-artifact-preview=""
    >
      <div className="flex min-w-0 items-center gap-3 border-b border-border px-3 py-2 text-sm">
        <span
          className="min-w-0 flex-1 truncate font-medium"
          title={target.path}
        >
          {name}
        </span>
        {download === undefined ? null : (
          <a
            aria-label={`下载 ${name}`}
            className={ARTIFACT_DOWNLOAD_LINK}
            download=""
            href={download}
          >
            下载
          </a>
        )}
        {canOpen && src !== undefined ? (
          <a
            className={BAR_LINK}
            href={src}
            rel="noopener noreferrer"
            target="_blank"
          >
            在新标签页打开
          </a>
        ) : null}
        <button
          aria-label="关闭预览"
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          onClick={onClose}
          type="button"
        >
          <IconX aria-hidden className="size-4" />
        </button>
      </div>
      {body}
    </section>
  );
}
