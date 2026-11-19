/**
 * Where pictures and videos are made, read from the environment, one group of settings per kind.
 *
 *   XIONGBAO_IMAGE_BASE_URL  XIONGBAO_IMAGE_API_KEY  XIONGBAO_IMAGE_MODEL
 *   XIONGBAO_VIDEO_BASE_URL  XIONGBAO_VIDEO_API_KEY  XIONGBAO_VIDEO_MODEL  XIONGBAO_VIDEO_PROVIDER
 *
 * Only the new names: these settings are new, so there is no older spelling to keep working.
 *
 * NOTHING IS ASSUMED. No vendor is the default and no model name is filled in: a kind with a setting
 * missing is "not configured", and the tool says which settings to fill in rather than calling
 * anybody. `XIONGBAO_VIDEO_PROVIDER` picks the video API's shape and defaults to `openai-compatible`;
 * `zhipu` is the adapter for Zhipu's own (see `providers.ts`). Images have one shape, OpenAI's, which
 * the vendors share.
 */
import type { OutboundPolicy } from "../net/outbound-guard";
import {
  type ImageProvider,
  openAiCompatibleImages,
  openAiCompatibleVideos,
  type VideoProvider,
  zhipuVideos,
} from "./providers";

export const VIDEO_PROVIDERS = ["openai-compatible", "zhipu"] as const;
export type VideoProviderId = (typeof VIDEO_PROVIDERS)[number];

/** One kind's provider, or the settings that are missing and why nothing can be called. */
export type MediaSetup<T> =
  | { ready: true; provider: T }
  | { ready: false; problem: string };

export type MediaConfig = {
  image: MediaSetup<ImageProvider>;
  video: MediaSetup<VideoProvider>;
};

const read = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
) => environment[name]?.trim() || undefined;

function missing(kind: "IMAGE" | "VIDEO", names: string[]): string {
  const what = kind === "IMAGE" ? "生成图片" : "生成视频";
  return `这个部署还没有配置${what}的服务：缺少 ${names.join("、")}。请管理员在部署的环境变量里填上兼容 OpenAI 接口的服务地址、密钥和模型名（见 .env.example 的「生成图片和视频」一节），重启后再试。`;
}

function connection(
  environment: Readonly<Record<string, string | undefined>>,
  kind: "IMAGE" | "VIDEO",
  outbound: OutboundPolicy,
) {
  const names = {
    baseUrl: `XIONGBAO_${kind}_BASE_URL`,
    apiKey: `XIONGBAO_${kind}_API_KEY`,
    model: `XIONGBAO_${kind}_MODEL`,
  };
  const baseUrl = read(environment, names.baseUrl);
  const apiKey = read(environment, names.apiKey);
  const model = read(environment, names.model);
  if (!baseUrl || !apiKey || !model) {
    const absent = [
      ...(baseUrl ? [] : [names.baseUrl]),
      ...(apiKey ? [] : [names.apiKey]),
      ...(model ? [] : [names.model]),
    ];
    return { ready: false as const, problem: missing(kind, absent) };
  }
  return {
    ready: true as const,
    connection: { baseUrl, apiKey, model, outbound },
  };
}

export function readMediaConfig(
  environment: Readonly<Record<string, string | undefined>>,
  outbound: OutboundPolicy,
): MediaConfig {
  const image = connection(environment, "IMAGE", outbound);
  const video = connection(environment, "VIDEO", outbound);
  const videoProvider =
    read(environment, "XIONGBAO_VIDEO_PROVIDER") ?? "openai-compatible";

  return {
    image: image.ready
      ? { ready: true, provider: openAiCompatibleImages(image.connection) }
      : { ready: false, problem: image.problem },
    video: !(VIDEO_PROVIDERS as readonly string[]).includes(videoProvider)
      ? {
          ready: false,
          problem: `XIONGBAO_VIDEO_PROVIDER 的值「${videoProvider}」不认识，只能是 ${VIDEO_PROVIDERS.join(" 或 ")}。请管理员改好后重启。`,
        }
      : video.ready
        ? {
            ready: true,
            provider:
              videoProvider === "zhipu"
                ? zhipuVideos(video.connection)
                : openAiCompatibleVideos(video.connection),
          }
        : { ready: false, problem: video.problem },
  };
}
