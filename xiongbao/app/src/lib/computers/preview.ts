import { useNavigate, useSearch } from "@tanstack/react-router";
import { createContext, useContext, useMemo } from "react";
import { previewKindOf } from "../../../../shared/preview-kind";
import { normalizedArtifactPath, scopedFileHref } from "./artifact";

/*
 * 预览面板要的那一小块：看哪个文件（连同它在哪里被宣布的）、放进地址栏参数里的写法、
 * 以及两个路由的地址。地址和下载链接共用 `scopedFileHref`，路径规范化与编码只有一份。
 */

export type PreviewScope = { channel: string; run: string } | { task: string };

/** 一个要预览的文件：哪位员工的、哪个路径、在哪次对话的哪次 run（或哪张交付卡）里被宣布。 */
export type FilePreviewTarget = {
  botId: string;
  path: string;
  scope: PreviewScope;
};

/** 一个运行中的程序：哪位员工的、哪个端口与首页路径、在哪张交付卡（或哪次 run）里被宣布。 */
export type AppPreviewTarget = {
  botId: string;
  app: { port: number; path: string };
  /** 交付卡上的程序名；侧栏标题用它，缺省用「端口 N」。 */
  label?: string;
  scope: PreviewScope;
};

export type PreviewTarget = FilePreviewTarget | AppPreviewTarget;

export const isAppTarget = (
  target: PreviewTarget,
): target is AppPreviewTarget => "app" in target;

/** 程序首页路径的规范：以 / 开头、不以 // 开头、没有反斜杠和控制字符。 */
export const validAppPath = (path: unknown): path is string =>
  typeof path === "string" &&
  path.startsWith("/") &&
  !path.startsWith("//") &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要拒绝控制字符
  !/[\\\u0000-\u001f\u007f]/.test(path);

/** 程序端口：非保留端口的整数。 */
export const validAppPort = (port: unknown): port is number =>
  typeof port === "number" &&
  Number.isInteger(port) &&
  port >= 1024 &&
  port <= 65535;

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/** 放进地址栏参数的写法：JSON 的 base64url。 */
export function encodePreview(target: PreviewTarget): string {
  const bytes = new TextEncoder().encode(JSON.stringify(target));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 读回参数；任何坏值（不是 base64url、不是 JSON、缺字段、scope 两种都不是）都是 undefined。 */
export const PREVIEW_PARAM_LIMIT = 4096;

export function decodePreview(
  value: string | undefined,
): PreviewTarget | undefined {
  if (
    typeof value !== "string" ||
    value.length > PREVIEW_PARAM_LIMIT ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    return undefined;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(binary, (char) => char.charCodeAt(0)),
      ),
    );
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { botId, path, scope, app } = parsed as Record<string, unknown>;
    if (!nonEmpty(botId)) return undefined;
    if (typeof scope !== "object" || scope === null) return undefined;
    const { channel, run, task } = scope as Record<string, unknown>;
    const decodedScope: PreviewScope | undefined =
      nonEmpty(channel) && nonEmpty(run)
        ? { channel, run }
        : nonEmpty(task)
          ? { task }
          : undefined;
    if (decodedScope === undefined) return undefined;
    if (app !== undefined) {
      // 程序变体：不带文件路径，端口和首页路径各自严格校验。
      if (path !== undefined || typeof app !== "object" || app === null)
        return undefined;
      const { port, path: appPath } = app as Record<string, unknown>;
      if (!validAppPort(port) || !validAppPath(appPath)) return undefined;
      const { label } = parsed as Record<string, unknown>;
      return {
        botId,
        app: { port, path: appPath },
        ...(nonEmpty(label) ? { label } : {}),
        scope: decodedScope,
      };
    }
    if (!nonEmpty(path)) return undefined;
    return { botId, path, scope: decodedScope };
  } catch {
    return undefined;
  }
}

/** 内联预览的地址（图片、音视频、pdf、html、office 转出的 pdf）。 */
export function previewHref(target: FilePreviewTarget): string | undefined {
  return scopedFileHref("preview", target);
}

/** 文本类内容的地址（markdown、csv、纯文本）。 */
export function textHref(target: FilePreviewTarget): string | undefined {
  return scopedFileHref("text", target);
}

/** 预览面板在右侧详情栏里的宽度（像素）：比看电脑屏幕的那一栏宽，要读文档。 */
export const PREVIEW_PANEL_WIDTH = 560;

/** 当前页面的预览开关：谁在看、打开一个、关掉。 */
export type PreviewController = {
  target: PreviewTarget | undefined;
  open(target: PreviewTarget): void;
  close(): void;
};

/**
 * 读写当前路由 `preview` 参数的那一个。
 *
 * 打开时清掉 `watch` / `settings`（右侧详情栏同一时间只放一种内容），关闭时只删 `preview`，其余参数不动。
 * 地址里的坏值读成没有目标：面板不开。
 */
export function useRoutePreviewTarget(): PreviewController {
  const search = useSearch({ strict: false }) as { preview?: unknown };
  const navigate = useNavigate();
  const raw = typeof search.preview === "string" ? search.preview : undefined;
  const target = useMemo(() => decodePreview(raw), [raw]);
  return useMemo(
    () => ({
      target,
      open: (next) =>
        void navigate({
          search: ((previous: Record<string, unknown>) => ({
            ...previous,
            watch: undefined,
            settings: undefined,
            preview: encodePreview(next),
          })) as never,
          replace: true,
        }),
      close: () =>
        void navigate({
          search: ((previous: Record<string, unknown>) => ({
            ...previous,
            preview: undefined,
          })) as never,
          replace: true,
        }),
    }),
    [target, navigate],
  );
}

/**
 * 路由把自己的预览开关放在这里，清单、交付卡里的「预览」按钮从这里取。没有面板可开的页面（没人提供）
 * 取到 undefined，那些按钮就不画。
 */
export const PreviewTargetContext = createContext<
  PreviewController | undefined
>(undefined);

export function usePreviewTarget(): PreviewController | undefined {
  return useContext(PreviewTargetContext);
}

/** 这个文件在面板里的预览类别。 */
export const previewKindOfTarget = (target: FilePreviewTarget) =>
  previewKindOf(target.path);

/** csv 表格最多画这么多行数据（表头另算）。 */
export const CSV_ROW_LIMIT = 500;

/** 解析 csv：双引号包住的字段可含逗号、换行和成对的 `""`。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === ",") endField();
    else if (char === "\n") endRow();
    else if (char === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else field += char;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/*
 * 通过内容源打开员工做的网页。
 *
 * 服务器 `POST /api/computers/:botId/open` 在配了内容源时答一个一次性的 `url`：打开后 302 到
 * 内容源上的路径令牌地址，页面在不透明源里运行。没配内容源时答 `{ available: false }`。
 */

/** 打开请求的体：`dir` 是工作区里一个网页目录；`app` 是运行中的程序（本期服务器返回不可用占位）。 */
export type OpenBody = (
  | { kind: "dir"; path: string }
  | { kind: "app"; port: number; path?: string }
) & { channel?: string; run?: string; task?: string };

/** 独立端口模式的提示：侧栏横幅和任务页的「打开」按钮旁共用这一句。 */
export const PORT_MODE_NOTICE =
  "独立端口模式下，同一浏览器里先后打开的程序能互相读到内容，只打开你信任的程序。";
/** 这次打开顶掉了同一浏览器里之前打开的程序。 */
export const REPLACED_NOTICE = "已替换你之前打开的程序";

/** 服务器的答案：没配内容源，或可用的一次性地址。 */
export type OpenResult =
  | { available: false; reason: string }
  | {
      available: true;
      url: string;
      mode: "port" | "domain";
      expiresAt: string;
      replaces: boolean;
    };

/** 把预览目标的归属（哪次 run 或哪张交付卡）写成打开请求里的字段。 */
export function scopeFields(
  scope: PreviewScope,
): { channel: string; run: string } | { task: string } {
  return "task" in scope
    ? { task: scope.task }
    : { channel: scope.channel, run: scope.run };
}

/**
 * 请求内容源打开一个目录。服务器答 404（无权限、没有 index.html、工作区根等）或任何失败都抛错，
 * 调用方一律当作「打不开」。
 */
export async function openTarget(
  botId: string,
  body: OpenBody,
  signal?: AbortSignal,
): Promise<OpenResult> {
  const response = await fetch(
    `/api/computers/${encodeURIComponent(botId)}/open`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
  );
  if (!response.ok) throw new Error(`open failed: ${response.status}`);
  const answer = (await response.json()) as Partial<OpenResult> & {
    available?: unknown;
  };
  if (answer.available === false)
    return {
      available: false,
      reason: typeof answer.reason === "string" ? answer.reason : "",
    };
  const ok = answer as Extract<OpenResult, { available: true }>;
  if (typeof ok.url !== "string" || ok.url === "")
    throw new Error("open failed: no url");
  // 服务器给的地址不可信到什么程度由这里定：只认 http(s)，且必须是另一个源（不是本应用）。
  let parsed: URL;
  try {
    parsed = new URL(ok.url, location.href);
  } catch {
    throw new Error("open failed: bad url");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.origin === location.origin
  )
    throw new Error("open failed: url not on a separate http(s) origin");
  return {
    available: true,
    url: parsed.href,
    mode: ok.mode === "domain" ? "domain" : "port",
    expiresAt: String(ok.expiresAt),
    replaces: ok.replaces === true,
  };
}

/**
 * 这个文件走内容源时要打开的目录：只有文件名恰好是 `index.html` 的 html 才走（打开令牌 302 到目录根，
 * 拼不出别的文件名）。`root` 表示 index.html 在工作区根：服务器会拒绝，界面改用受限预览并说明。
 */
export function openDirOf(
  path: string,
): { kind: "none" } | { kind: "root" } | { kind: "dir"; dir: string } {
  const normalised = normalizedArtifactPath(path);
  if (normalised === undefined) return { kind: "none" };
  const segments = normalised.split("/");
  if (segments.pop() !== "index.html") return { kind: "none" };
  if (segments.length === 0) return { kind: "root" };
  return { kind: "dir", dir: segments.join("/") };
}
