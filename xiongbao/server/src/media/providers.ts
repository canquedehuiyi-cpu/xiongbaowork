/**
 * Who makes the pictures and the videos: a provider behind a small interface, picked by configuration.
 *
 * GENERIC BY DEFAULT, NOT TIED TO ONE VENDOR (user decision 2026-11-19: 「视频图片接通用接口」).
 *
 *  - Images speak OpenAI's `POST {base}/images/generations` (`model`, `prompt`, `size`, `n`) and read
 *    the answer's `data[]` whichever way it carries a picture, `b64_json` or `url`. Zhipu (CogView),
 *    SiliconFlow, Tongyi's compatible mode and every OpenAI-compatible gateway answer this shape, so a
 *    vendor is a base URL, a key and a model name in the environment, not code.
 *  - Videos speak OpenAI's videos API: create a job (`POST {base}/videos`, multipart with `model`,
 *    `prompt`, optional `seconds` and an `input_reference` image), read it
 *    (`GET {base}/videos/{id}`: `status` is `queued`, `in_progress`, `completed` or `failed`), then
 *    download it (`GET {base}/videos/{id}/content`).
 *  - A vendor whose video API has another shape gets a small adapter of its own, chosen with
 *    `XIONGBAO_VIDEO_PROVIDER`. The one here is Zhipu's (`zhipu`): `POST {base}/videos/generations`,
 *    then `GET {base}/async-result/{id}` until `task_status` is `SUCCESS` (`video_result[].url`) or
 *    `FAIL`.
 *
 * EVERY REQUEST GOES THROUGH THE OUTBOUND GUARD (`net/outbound-guard.ts`), as a tenant's model
 * endpoint does: no internal address, no redirect followed with the key on it, a deadline. A link a
 * provider answers with (a picture or a video on its CDN) is fetched through the same guard WITHOUT
 * the key, and never more than the cap for its kind.
 *
 * FAILURES ARE SENTENCES. Whatever goes wrong upstream becomes a {@link MediaProviderError} carrying a
 * Chinese sentence the model can pass on; the key and the link's query string are never in it.
 */
import { guardedFetch, type OutboundPolicy } from "../net/outbound-guard";

/** One picture or video, as bytes, with what the bytes are. */
export type GeneratedFile = { bytes: Uint8Array; mimeType: string };

export type ImageRequest = { prompt: string; size?: string; n: number };

export interface ImageProvider {
  /** The provider's name as configured (`openai-compatible`), for the record and the audit row. */
  readonly id: string;
  readonly model: string;
  generate(
    request: ImageRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedFile[]>;
}

export type VideoRequest = {
  prompt: string;
  /** The picture to start from, as bytes, already fetched and checked by the caller. */
  image?: GeneratedFile;
  /** The same picture as a public link, for a provider that takes a link rather than bytes. */
  imageUrl?: string;
  /** Seconds, as the person asked; passed through, each vendor has its own allowed values. */
  duration?: number;
};

export type VideoStatus =
  | { state: "pending"; progress?: number }
  | { state: "failed"; reason: string }
  | { state: "done"; file: GeneratedFile };

export interface VideoProvider {
  readonly id: string;
  readonly model: string;
  /** Starts a job and answers the vendor's id for it. */
  submit(request: VideoRequest, signal?: AbortSignal): Promise<string>;
  /** Where the job is now; downloads the video when it is done. */
  poll(taskId: string, signal?: AbortSignal): Promise<VideoStatus>;
}

/** Something went wrong upstream, said in a sentence the person can read. */
export class MediaProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaProviderError";
  }
}

/** The largest picture kept: a generated image is a few MB at most. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** The largest video kept: the `generated_media` row's own cap says the same. */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/** How long one request to a provider may take. Creating a picture can take most of a minute. */
const REQUEST_TIMEOUT_MS = 120_000;

export type ProviderConnection = {
  baseUrl: string;
  apiKey: string;
  model: string;
  outbound: OutboundPolicy;
};

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** The vendor's own words for a refusal, when it gave any, cut short. Never the request. */
async function upstreamReason(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  let said = text;
  try {
    const body = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
      msg?: unknown;
    };
    const candidate =
      typeof body.error === "string"
        ? body.error
        : (body.error?.message ?? body.message ?? body.msg);
    if (typeof candidate === "string") said = candidate;
  } catch {}
  said = said.replace(/\s+/g, " ").trim().slice(0, 200);
  return said ? `HTTP ${response.status}：${said}` : `HTTP ${response.status}`;
}

async function call(
  connection: ProviderConnection,
  url: string,
  init: RequestInit,
  what: string,
  signal?: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await guardedFetch(
      url,
      {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${connection.apiKey}`,
        },
        ...(signal ? { signal } : {}),
      },
      { ...connection.outbound, timeoutMs: REQUEST_TIMEOUT_MS },
    );
  } catch (error) {
    throw new MediaProviderError(
      `${what}没有连上生成服务：${describeFailure(error)}`,
    );
  }
  if (!response.ok)
    throw new MediaProviderError(
      `${what}被生成服务拒绝了（${await upstreamReason(response)}）。`,
    );
  return response;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError")
      return "等待超时";
    // The guard's own sentences are written for people and carry no URL query or header.
    if (error.name === "OutboundRefusedError") return error.message;
  }
  return "网络错误";
}

/** Reads a body, refusing one past `cap` before holding all of it. */
async function readCapped(
  response: Response,
  cap: number,
  what: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap)
    throw new MediaProviderError(
      `${what}超过 ${cap / 1024 / 1024} MB，没有保存。`,
    );
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new MediaProviderError(
        `${what}超过 ${cap / 1024 / 1024} MB，没有保存。`,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * A file a provider answered with as a link, fetched through the guard and WITHOUT the key: the link
 * is the vendor's CDN, which needs none, and a key sent there would be a key handed to whoever the
 * link names.
 */
export async function downloadLink(
  link: string,
  outbound: OutboundPolicy,
  cap: number,
  what: string,
  signal?: AbortSignal,
): Promise<GeneratedFile> {
  let response: Response;
  try {
    response = await guardedFetch(link, signal ? { signal } : {}, {
      ...outbound,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    throw new MediaProviderError(`${what}下载失败：${describeFailure(error)}`);
  }
  if (!response.ok)
    throw new MediaProviderError(
      `${what}下载失败（HTTP ${response.status}）。`,
    );
  const bytes = await readCapped(response, cap, what);
  return {
    bytes,
    mimeType: sniffMediaType(bytes) ?? "application/octet-stream",
  };
}

/**
 * What the bytes are, read from their first bytes and never from what anybody said about them: the
 * type is what the media route serves as `Content-Type`.
 */
export function sniffMediaType(bytes: Uint8Array): string | undefined {
  const at = (offset: number, ...values: number[]) =>
    values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return "image/webp";
  // ISO base media (`....ftyp`): MP4, and MOV, which browsers play as MP4.
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return "video/mp4";
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
  return undefined;
}

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);

export function isImageType(type: string): boolean {
  return IMAGE_TYPES.has(type);
}
export function isVideoType(type: string): boolean {
  return VIDEO_TYPES.has(type);
}

/** OpenAI's `images/generations`, as every compatible endpoint answers it. */
export function openAiCompatibleImages(
  connection: ProviderConnection,
): ImageProvider {
  return {
    id: "openai-compatible",
    model: connection.model,
    async generate(request, signal) {
      const response = await call(
        connection,
        endpoint(connection.baseUrl, "/images/generations"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: connection.model,
            prompt: request.prompt,
            n: request.n,
            ...(request.size ? { size: request.size } : {}),
          }),
        },
        "出图请求",
        signal,
      );
      const body = (await response.json().catch(() => null)) as {
        data?: { b64_json?: unknown; url?: unknown }[];
      } | null;
      const entries = Array.isArray(body?.data) ? body.data : [];
      const files: GeneratedFile[] = [];
      for (const entry of entries.slice(0, request.n)) {
        let file: GeneratedFile | undefined;
        if (typeof entry?.b64_json === "string" && entry.b64_json) {
          const bytes = new Uint8Array(Buffer.from(entry.b64_json, "base64"));
          if (bytes.byteLength > MAX_IMAGE_BYTES)
            throw new MediaProviderError(
              `图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB，没有保存。`,
            );
          file = { bytes, mimeType: sniffMediaType(bytes) ?? "" };
        } else if (typeof entry?.url === "string" && entry.url) {
          file = await downloadLink(
            entry.url,
            connection.outbound,
            MAX_IMAGE_BYTES,
            "图片",
            signal,
          );
        }
        if (!file) continue;
        if (!isImageType(file.mimeType))
          throw new MediaProviderError(
            "生成服务返回的不是 PNG、JPEG、GIF 或 WebP 图片，没有保存。",
          );
        files.push(file);
      }
      if (files.length === 0)
        throw new MediaProviderError(
          "生成服务的回答里没有图片（data 里既没有 b64_json 也没有 url）。",
        );
      return files;
    },
  };
}

/** OpenAI's videos API: create, read, download. */
export function openAiCompatibleVideos(
  connection: ProviderConnection,
): VideoProvider {
  return {
    id: "openai-compatible",
    model: connection.model,
    async submit(request, signal) {
      const form = new FormData();
      form.set("model", connection.model);
      form.set("prompt", request.prompt);
      if (request.duration !== undefined)
        form.set("seconds", String(request.duration));
      if (request.image) {
        const extension = request.image.mimeType.split("/")[1] ?? "png";
        form.set(
          "input_reference",
          new Blob([Buffer.from(request.image.bytes)], {
            type: request.image.mimeType,
          }),
          `reference.${extension}`,
        );
      }
      const response = await call(
        connection,
        endpoint(connection.baseUrl, "/videos"),
        { method: "POST", body: form },
        "视频任务",
        signal,
      );
      const body = (await response.json().catch(() => null)) as {
        id?: unknown;
      } | null;
      if (typeof body?.id !== "string" || !body.id)
        throw new MediaProviderError("生成服务接了视频任务，但没有给任务号。");
      return body.id;
    },
    async poll(taskId, signal) {
      const response = await call(
        connection,
        endpoint(connection.baseUrl, `/videos/${encodeURIComponent(taskId)}`),
        { method: "GET" },
        "查询视频任务",
        signal,
      );
      const body = (await response.json().catch(() => null)) as {
        status?: unknown;
        progress?: unknown;
        error?: { message?: unknown } | null;
      } | null;
      const status = body?.status;
      if (status === "failed") {
        const said =
          typeof body?.error?.message === "string" ? body.error.message : "";
        return {
          state: "failed",
          reason: said ? said.slice(0, 200) : "生成服务说这个视频生成失败了",
        };
      }
      if (status === "completed") {
        const content = await call(
          connection,
          endpoint(
            connection.baseUrl,
            `/videos/${encodeURIComponent(taskId)}/content`,
          ),
          { method: "GET" },
          "下载视频",
          signal,
        );
        const bytes = await readCapped(content, MAX_VIDEO_BYTES, "视频");
        return { state: "done", file: videoFile(bytes) };
      }
      return {
        state: "pending",
        ...(typeof body?.progress === "number"
          ? { progress: body.progress }
          : {}),
      };
    },
  };
}

function videoFile(bytes: Uint8Array): GeneratedFile {
  const mimeType = sniffMediaType(bytes);
  if (!mimeType || !isVideoType(mimeType))
    throw new MediaProviderError(
      "生成服务返回的不是 MP4 或 WebM 视频，没有保存。",
    );
  return { bytes, mimeType };
}

/**
 * Zhipu's own video API (CogVideoX), whose shape is not OpenAI's: a JSON create at
 * `/videos/generations` and a shared async-result endpoint. The picture to start from is passed as a
 * link when it has one, and as base64 otherwise (a picture this deployment generated has no public
 * link).
 */
export function zhipuVideos(connection: ProviderConnection): VideoProvider {
  return {
    id: "zhipu",
    model: connection.model,
    async submit(request, signal) {
      const image =
        request.imageUrl ??
        (request.image
          ? Buffer.from(request.image.bytes).toString("base64")
          : undefined);
      const response = await call(
        connection,
        endpoint(connection.baseUrl, "/videos/generations"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: connection.model,
            prompt: request.prompt,
            ...(image ? { image_url: image } : {}),
            ...(request.duration !== undefined
              ? { duration: request.duration }
              : {}),
          }),
        },
        "视频任务",
        signal,
      );
      const body = (await response.json().catch(() => null)) as {
        id?: unknown;
        task_status?: unknown;
      } | null;
      if (typeof body?.id !== "string" || !body.id)
        throw new MediaProviderError("生成服务接了视频任务，但没有给任务号。");
      if (body.task_status === "FAIL")
        throw new MediaProviderError("生成服务说这个视频任务失败了。");
      return body.id;
    },
    async poll(taskId, signal) {
      const response = await call(
        connection,
        endpoint(
          connection.baseUrl,
          `/async-result/${encodeURIComponent(taskId)}`,
        ),
        { method: "GET" },
        "查询视频任务",
        signal,
      );
      const body = (await response.json().catch(() => null)) as {
        task_status?: unknown;
        video_result?: { url?: unknown }[];
      } | null;
      if (body?.task_status === "FAIL")
        return { state: "failed", reason: "生成服务说这个视频生成失败了" };
      if (body?.task_status === "SUCCESS") {
        const link = body.video_result?.find(
          (entry) => typeof entry?.url === "string" && entry.url,
        )?.url;
        if (typeof link !== "string")
          throw new MediaProviderError("视频生成好了，但回答里没有视频地址。");
        const file = await downloadLink(
          link,
          connection.outbound,
          MAX_VIDEO_BYTES,
          "视频",
          signal,
        );
        return { state: "done", file: videoFile(file.bytes) };
      }
      return { state: "pending" };
    },
  };
}
