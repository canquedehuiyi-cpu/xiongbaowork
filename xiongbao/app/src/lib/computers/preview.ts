import { useNavigate, useSearch } from "@tanstack/react-router";
import { createContext, useContext, useMemo } from "react";
import { previewKindOf } from "../../../../shared/preview-kind";
import { scopedFileHref } from "./artifact";

/*
 * 预览面板要的那一小块：看哪个文件（连同它在哪里被宣布的）、放进地址栏参数里的写法、
 * 以及两个路由的地址。地址和下载链接共用 `scopedFileHref`，路径规范化与编码只有一份。
 */

export type PreviewScope = { channel: string; run: string } | { task: string };

/** 一个要预览的文件：哪位员工的、哪个路径、在哪次对话的哪次 run（或哪张交付卡）里被宣布。 */
export type PreviewTarget = {
  botId: string;
  path: string;
  scope: PreviewScope;
};

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
    const { botId, path, scope } = parsed as Record<string, unknown>;
    if (!nonEmpty(botId) || !nonEmpty(path)) return undefined;
    if (typeof scope !== "object" || scope === null) return undefined;
    const { channel, run, task } = scope as Record<string, unknown>;
    if (nonEmpty(channel) && nonEmpty(run))
      return { botId, path, scope: { channel, run } };
    if (nonEmpty(task)) return { botId, path, scope: { task } };
    return undefined;
  } catch {
    return undefined;
  }
}

/** 内联预览的地址（图片、音视频、pdf、html、office 转出的 pdf）。 */
export function previewHref(target: PreviewTarget): string | undefined {
  return scopedFileHref("preview", target);
}

/** 文本类内容的地址（markdown、csv、纯文本）。 */
export function textHref(target: PreviewTarget): string | undefined {
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
export const previewKindOfTarget = (target: PreviewTarget) =>
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
