import { IconX } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import { ARTIFACT_DOWNLOAD_LINK } from "@/components/channels/turn-artifacts";
import { artifactHref } from "@/lib/computers/artifact";
import {
  type AppPreviewTarget,
  CSV_ROW_LIMIT,
  type FilePreviewTarget,
  isAppTarget,
  type OpenBody,
  openDirOf,
  openTarget,
  PORT_MODE_NOTICE,
  type PreviewTarget,
  parseCsv,
  previewHref,
  previewKindOfTarget,
  REPLACED_NOTICE,
  scopeFields,
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
 *
 * 例外：文件名是 `index.html` 的网页先问内容源（独立的源，见 `openTarget`），可用时 iframe 指向它给的
 * 一次性地址，脚本和相对资源都能用；没配内容源、被拒绝、或在工作区根目录时，仍回到上面的受限沙箱预览。
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

/** 结果记着它属于哪个地址：换了文件，旧结果在新地址的第一帧就不算数。 */
type Keyed<T> = { url: string | undefined; result: Loaded<T> };

/** 只认属于当前地址的结果，其余一律当作还在取。 */
function currentResult<T>(keyed: Keyed<T>, url: string | undefined): Loaded<T> {
  return keyed.url === url ? keyed.result : { state: "loading" };
}

/** 取一个地址的 JSON（文本类）。`url` 变了就重取，卸载时作废。 */
function useTextAnswer(url: string | undefined, enabled: boolean) {
  const [keyed, setKeyed] = useState<Keyed<TextAnswer>>({
    url: undefined,
    result: { state: "loading" },
  });
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    // 换了文件后，上一个地址迟到的答案不许写进来。
    const setLoaded = (result: Loaded<TextAnswer>) => {
      if (!abort.signal.aborted) setKeyed({ url, result });
    };
    if (url === undefined) {
      setLoaded({ state: "failed" });
      return;
    }
    setLoaded({ state: "loading" });
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
  return currentResult(keyed, url);
}

/** office：先问一次，转不了时服务器答 200 的 `{unavailable:true}`，否则是 pdf，交给 iframe 去显示。 */
function useOfficeAvailable(url: string | undefined, enabled: boolean) {
  const [keyed, setKeyed] = useState<Keyed<true>>({
    url: undefined,
    result: { state: "loading" },
  });
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    const setLoaded = (result: Loaded<true>) => {
      if (!abort.signal.aborted) setKeyed({ url, result });
    };
    if (url === undefined) {
      setLoaded({ state: "failed" });
      return;
    }
    setLoaded({ state: "loading" });
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
  return currentResult(keyed, url);
}

/** 打开一个网页目录的结果：还在问、内容源已打开、没配内容源、被拒绝或出错。 */
type Opened =
  | { state: "loading" }
  | {
      state: "opened";
      url: string;
      mode: "port" | "domain";
      expiresAt: string;
      replaces: boolean;
    }
  | { state: "unconfigured" }
  | { state: "refused" };

/** `scope` 用 JSON 字符串传：对象每次渲染都是新的，字符串才能当依赖。 */
function openBody(dir: string, scopeJson: string): OpenBody {
  return {
    kind: "dir",
    path: dir,
    ...(JSON.parse(scopeJson) as ReturnType<typeof scopeFields>),
  };
}

/** 运行中的程序的打开请求体。 */
function appOpenBody(target: AppPreviewTarget): OpenBody {
  return {
    kind: "app",
    port: target.app.port,
    path: target.app.path,
    ...scopeFields(target.scope),
  };
}

/**
 * 向内容源要一个打开地址（网页目录或运行中的程序，`request` 是打开请求体的 JSON）。写法同上面两个取数：
 * 结果记着它属于哪个请求，旧答案不写进来。
 * `reopen` 重新要一个（令牌到期后用）。
 */
function useOpenedPage(botId: string, request: string | undefined) {
  const key = `${botId}\n${request}`;
  const [keyed, setKeyed] = useState<{ key: string; result: Opened }>({
    key: "",
    result: { state: "loading" },
  });
  const [tries, setTries] = useState(0);
  const [expiredUrl, setExpiredUrl] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tries` 只用来让「重新打开」再跑一次
  useEffect(() => {
    if (request === undefined) return;
    const abort = new AbortController();
    const set = (result: Opened) => {
      if (!abort.signal.aborted) setKeyed({ key, result });
    };
    set({ state: "loading" });
    openTarget(botId, JSON.parse(request) as OpenBody, abort.signal).then(
      (answer) =>
        set(
          answer.available
            ? {
                state: "opened",
                url: answer.url,
                mode: answer.mode,
                expiresAt: answer.expiresAt,
                replaces: answer.replaces,
              }
            : { state: "unconfigured" },
        ),
      () => set({ state: "refused" }),
    );
    return () => abort.abort();
  }, [botId, request, key, tries]);
  const result: Opened =
    keyed.key === key ? keyed.result : { state: "loading" };
  const openedUrl = result.state === "opened" ? result.url : undefined;
  const expiresAt = result.state === "opened" ? result.expiresAt : undefined;
  useEffect(() => {
    if (openedUrl === undefined || expiresAt === undefined) return;
    // iframe 跨源读不到失败，只能按服务器给的到期时间计时；到点只提示，不自动换掉内容。
    const end = new Date(expiresAt).getTime();
    if (Number.isNaN(end)) return; // 时间不合法：不计时，不当作已过期
    const wait = Math.min(Math.max(0, end - Date.now()), 2 ** 31 - 1);
    const timer = setTimeout(() => setExpiredUrl(openedUrl), wait);
    return () => clearTimeout(timer);
  }, [openedUrl, expiresAt]);
  return {
    result,
    expired: openedUrl !== undefined && expiredUrl === openedUrl,
    reopen: () => {
      // 正在要的时候再点不重复请求；清掉已过期标记，服务器哪怕给回同一个地址横幅也不会立刻再现。
      if (result.state === "loading") return;
      setExpiredUrl(undefined);
      setTries((n) => n + 1);
    },
  };
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
      {answer.truncated && answer.kind === "csv" ? (
        <span className="px-3 pt-1 text-xs text-muted-foreground">
          最后一行可能不完整。
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

/** 面板顶部的一行说明。 */
function Banner({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-border bg-card px-3 py-2 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * 内容源条目的「在新标签页打开」：打开地址不复用面板 iframe 已用的那个，点击时再要一个新的。
 *
 * 要在点击的同一刻同步开一个空白标签页，否则异步之后再开会被浏览器当作弹窗拦掉。`opener = null` 不等于
 * noopener：新标签页仍在同一浏览上下文组、导航时会带应用源的 Referer；但内容源页本身在 CSP sandbox 的
 * 不透明源里，这个风险可以接受。拿不到新地址（不可用、出错）就关掉空白页，面板里的页面不受影响。
 * 返回 false 表示浏览器拦截了新标签页。
 */
export async function openInNewTab(
  botId: string,
  body: OpenBody,
  /** 拿到可用地址后告诉调用方这次是怎么打开的，好在按钮旁给出提示。 */
  onAnswer?: (answer: { mode: "port" | "domain"; replaces: boolean }) => void,
): Promise<"opened" | "blocked" | "unavailable" | "failed"> {
  const tab = window.open("", "_blank");
  if (tab === null) return "blocked";
  tab.opener = null;
  let result: "opened" | "unavailable" | "failed" = "failed";
  try {
    const answer = await openTarget(botId, body);
    if (answer.available) {
      onAnswer?.({ mode: answer.mode, replaces: answer.replaces });
      tab.location.replace(answer.url);
      result = "opened";
    } else result = "unavailable";
  } catch {
    // 落到 finally 关掉空白页。
  } finally {
    if (result !== "opened") tab.close();
  }
  return result;
}

const FRAME = "min-h-0 w-full flex-1 border-0 bg-background";

export function ArtifactPreview({
  target,
  onClose,
}: {
  target: PreviewTarget;
  /** 在 DetailPanel 里时不传：标题栏已有关闭按钮，不再画第二个；单独使用时传，顶栏画「×」。 */
  onClose?: () => void;
}) {
  // 换了程序就整块重建：上一个程序的 iframe 随之卸载。
  return isAppTarget(target) ? (
    <AppPreview
      key={`${target.botId}:${target.app.port}:${target.app.path}`}
      onClose={onClose}
      target={target}
    />
  ) : (
    <FilePreview onClose={onClose} target={target} />
  );
}

/** 单个程序的预览：通过内容源打开员工正在运行的程序。 */
function AppPreview({
  target,
  onClose,
}: {
  target: AppPreviewTarget;
  onClose?: (() => void) | undefined;
}) {
  const name = target.label ?? `端口 ${target.app.port}`;
  const request = JSON.stringify(appOpenBody(target));
  const page = useOpenedPage(target.botId, request);
  const [opening, setOpening] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const { result } = page;
  let body: ReactNode;
  if (result.state === "loading") body = <Note>加载中…</Note>;
  else if (result.state === "unconfigured")
    body = <Note>没有配置内容源，不能打开程序</Note>;
  else if (result.state === "refused") body = <Note>打不开这个程序</Note>;
  else
    body = (
      <>
        {result.mode === "port" ? <Banner>{PORT_MODE_NOTICE}</Banner> : null}
        {result.replaces ? <Banner>{REPLACED_NOTICE}</Banner> : null}
        {page.expired ? (
          <Banner>
            <button
              className="underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              onClick={page.reopen}
              type="button"
            >
              已过期，重新打开
            </button>
          </Banner>
        ) : null}
        <iframe
          className={FRAME}
          // 程序的响应不带 CSP sandbox（端口模式下程序要能发带 cookie 的子请求，域名模式靠子域隔离），
          // 所以这里的 allow-same-origin 让它运行在内容源的真实源里：拿不到本应用的 cookie 和存储
          // （内容源是另一个源），但端口模式下同一浏览器里先后打开的程序共用一个主机，能互相读到内容，
          // 面板顶部的说明已提示这一点。本应用源上的 iframe 仍永远不给 allow-same-origin。
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          src={result.url}
          title={name}
        />
      </>
    );
  return (
    <section
      aria-label={`预览 程序 ${name}`}
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      data-artifact-preview=""
    >
      <div className="flex min-w-0 items-center gap-3 border-b border-border px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">
          程序 · {name}
        </span>
        {result.state === "opened" ? (
          <button
            className={BAR_LINK}
            disabled={opening}
            onClick={() => {
              if (opening) return;
              setOpening(true);
              setBlocked(false);
              openInNewTab(target.botId, appOpenBody(target))
                .then((answer) => setBlocked(answer === "blocked"))
                .finally(() => setOpening(false));
            }}
            type="button"
          >
            在新标签页打开
          </button>
        ) : result.state === "unconfigured" ? (
          <button className={BAR_LINK} disabled type="button">
            打开
          </button>
        ) : null}
        {onClose === undefined ? null : (
          <button
            aria-label="关闭预览"
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            onClick={onClose}
            type="button"
          >
            <IconX aria-hidden className="size-4" />
          </button>
        )}
      </div>
      {blocked ? <Banner>浏览器拦截了新标签页</Banner> : null}
      {body}
    </section>
  );
}

function FilePreview({
  target,
  onClose,
}: {
  target: FilePreviewTarget;
  onClose?: (() => void) | undefined;
}) {
  const kind = previewKindOfTarget(target);
  const textual = kind === "markdown" || kind === "csv" || kind === "text";
  const src = previewHref(target);
  // PDF 查看器默认展开缩略图栏会挤窄正文：fragment 只给查看器看，不进服务器请求；「在新标签页打开」仍用 src。
  const framed = src === undefined ? undefined : `${src}#navpanes=0`;
  const download = artifactHref(target);
  const name = target.path.split("/").pop() ?? target.path;
  const openDir: ReturnType<typeof openDirOf> =
    kind === "html" ? openDirOf(target.path) : { kind: "none" };
  const scopeJson = JSON.stringify(scopeFields(target.scope));
  const page = useOpenedPage(
    target.botId,
    openDir.kind === "dir"
      ? JSON.stringify(openBody(openDir.dir, scopeJson))
      : undefined,
  );
  const [opening, setOpening] = useState(false);
  const [blocked, setBlocked] = useState(false);
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
  let contentOpened = false;
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
  else if (kind === "html") {
    // 受限预览：应用源上的 iframe 永远只有 allow-scripts，没有 allow-same-origin。
    const sandboxed = (
      <iframe
        className={FRAME}
        sandbox="allow-scripts"
        src={src}
        title={name}
      />
    );
    if (openDir.kind === "none") body = sandboxed;
    else if (openDir.kind === "root")
      body = (
        <>
          <Banner>这个网页在工作区根目录，只能在受限预览里查看</Banner>
          {sandboxed}
        </>
      );
    else if (page.result.state === "loading") body = <Note>加载中…</Note>;
    else if (page.result.state === "unconfigured")
      body = (
        <>
          <Banner>
            没有配置内容源，网页在受限沙箱里显示，部分功能可能不可用。
          </Banner>
          {sandboxed}
        </>
      );
    else if (page.result.state === "refused")
      body = (
        <>
          <Banner>打不开这个网页，已改用受限预览</Banner>
          {sandboxed}
        </>
      );
    else {
      contentOpened = true;
      body = (
        <>
          {page.result.replaces ? (
            <Banner>已替换你之前打开的程序</Banner>
          ) : null}
          {page.expired ? (
            <Banner>
              <button
                className="underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                onClick={page.reopen}
                type="button"
              >
                已过期，重新打开
              </button>
            </Banner>
          ) : null}
          <iframe
            className={FRAME}
            // 「同源」指内容源（不是本应用）；内容源的响应头 CSP sandbox 不含 allow-same-origin，
            // 沙箱取交集，页面实际仍在不透明源里，拿不到任何源的 cookie 和存储。
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            src={page.result.url}
            title={name}
          />
        </>
      );
    }
  } else if (kind === "pdf")
    // 不加 sandbox 属性：它会拦掉 PDF 查看器。隔离靠响应头里的 CSP sandbox。
    body = <iframe className={FRAME} src={framed} title={name} />;
  else if (office.state === "loading") body = <Note>正在转成 PDF…</Note>;
  else if (office.state === "unsupported") {
    body = unsupported;
    canOpen = false;
  } else if (office.state === "failed") body = failed;
  else body = <iframe className={FRAME} src={framed} title={name} />;

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
        {contentOpened ? (
          <button
            className={BAR_LINK}
            disabled={opening}
            onClick={() => {
              if (opening) return;
              setOpening(true);
              setBlocked(false);
              (openDir.kind === "dir"
                ? openInNewTab(target.botId, openBody(openDir.dir, scopeJson))
                : Promise.resolve("opened" as const)
              )
                .then((answer) => setBlocked(answer === "blocked"))
                .finally(() => setOpening(false));
            }}
            type="button"
          >
            在新标签页打开
          </button>
        ) : canOpen && src !== undefined ? (
          <a
            className={BAR_LINK}
            href={src}
            rel="noopener noreferrer"
            target="_blank"
          >
            在新标签页打开
          </a>
        ) : null}
        {onClose === undefined ? null : (
          <button
            aria-label="关闭预览"
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            onClick={onClose}
            type="button"
          >
            <IconX aria-hidden className="size-4" />
          </button>
        )}
      </div>
      {blocked ? <Banner>浏览器拦截了新标签页</Banner> : null}
      {body}
    </section>
  );
}
