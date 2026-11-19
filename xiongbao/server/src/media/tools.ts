/**
 * The tools a coworker makes pictures and videos with: `generate_image`, `generate_video` and
 * `check_video`.
 *
 * HELD BY EVERY COWORKER, BY DEFAULT, as `update_plan` is: granted with the tools a coworker needs to
 * be itself, and left out for one coworker by a `deny` rule naming `bot/generate_image` or
 * `bot/generate_video` (the per-employee tool permission). `check_video` goes with
 * `generate_video` ({@link offeredMediaTools}): a coworker that cannot start a video has none to check.
 *
 * WHO MAKES THEM is configuration (`config.ts`, `providers.ts`): an OpenAI-compatible endpoint by
 * default, any vendor that speaks it by its base URL and model. Not configured, a tool answers with
 * the settings to fill in, in the person's language, and calls nobody.
 *
 * WHERE THEY GO. Every file is saved in `generated_media` for the person whose turn asked for it and
 * answered as `/api/media/<id>`, which the chat draws when the reply writes `![…](…)` and which opens
 * in a tab for that person. The provider's own link is never handed on: it is temporary.
 *
 * A VIDEO TAKES MINUTES. `generate_video` submits the job and waits a while (`waitMs`, polling every
 * `pollMs` as the providers ask); if the video is not done by then it answers a task number, and
 * `check_video` waits a while again. The task number carries when the job was submitted, so a job
 * still not done {@link VIDEO_DEADLINE_MS} after it started is answered as timed out instead of being
 * polled forever. Two short calls rather than one long one: a turn is not held for ten minutes with
 * nothing on the screen, and the coworker can say what it is waiting for.
 *
 * NEVER THROWS. Every failure is a sentence for the model to pass on.
 *
 * COUNTED. Each picture or video saved writes one `media.generated` audit row in the person's trail:
 * which coworker, which kind, which provider and model, how many. That is the record of use there is
 * (the token meter, `model_token_calls`, is keyed to a library model and its credential, which an
 * environment-configured media endpoint does not have).
 */
import { z } from "zod";
import {
  CHECK_VIDEO_TOOL,
  GENERATE_IMAGE_TOOL,
  GENERATE_VIDEO_TOOL,
  mediaIdOf,
  mediaUrl,
} from "../../../shared/media";
import {
  type AuditInitiator,
  type AuditStore,
  recordPersonAuditEvent,
} from "../audit";
import type { OutboundPolicy } from "../net/outbound-guard";
import type { GrantedTool } from "../plugins/tools";
import { runAsTenant } from "../tenant/context";
import type { MediaConfig } from "./config";
import {
  downloadLink,
  type GeneratedFile,
  isImageType,
  MAX_IMAGE_BYTES,
  MediaProviderError,
} from "./providers";
import type { MediaKind, MediaStore } from "./store";

export const GENERATE_IMAGE_REF = `bot/${GENERATE_IMAGE_TOOL}`;
export const GENERATE_VIDEO_REF = `bot/${GENERATE_VIDEO_TOOL}`;
export const CHECK_VIDEO_REF = `bot/${CHECK_VIDEO_TOOL}`;

/** How long a video job may take, from submission, before it is answered as timed out. */
export const VIDEO_DEADLINE_MS = 10 * 60_000;
/** How long one call waits for a video before handing back the task number. */
const VIDEO_WAIT_MS = 2 * 60_000;
/** How often a job is asked about; OpenAI's guide says every 10 to 20 seconds. */
const VIDEO_POLL_MS = 10_000;
const PROMPT_LIMIT = 4000;

export type MediaToolOptions = {
  config: MediaConfig;
  store: MediaStore;
  /** The person whose turn this is: whose frame a file is saved in, whose trail counts it. */
  ownerUserId: string;
  agentId: string;
  /** Where a picture to start a video from may be fetched (the model endpoints' policy). */
  outbound: OutboundPolicy;
  auditStore?: AuditStore;
  initiator?: AuditInitiator;
  /** Injected by tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  waitMs?: number;
  pollMs?: number;
  deadlineMs?: number;
};

const imageParameters = z.object({
  prompt: z
    .string()
    .describe(
      "要画什么：主体、场景、风格、构图、颜色，越具体越好。用对方的语言写。",
    ),
  size: z
    .string()
    .optional()
    .describe(
      "图片尺寸，宽x高，例如 1024x1024、1024x1792；不填用服务的默认尺寸",
    ),
  n: z.number().int().optional().describe("生成几张，1 到 4，不填就是 1 张"),
});

const videoParameters = z.object({
  prompt: z
    .string()
    .describe("视频里发生什么：主体、动作、镜头、风格。用对方的语言写。"),
  image_url: z
    .string()
    .optional()
    .describe(
      "可选：从这张图片开始生成（图生视频）。可以是刚用 generate_image 生成的 /api/media/… 地址，或公开的 https 图片链接",
    ),
  duration: z
    .number()
    .int()
    .optional()
    .describe("可选：视频时长（秒），不同服务支持的取值不同，不填用服务默认"),
});

const checkParameters = z.object({
  task_id: z.string().describe("generate_video 返回的任务号，原样传回"),
});

function parse<T>(schema: z.ZodType<T>, args: unknown): T | undefined {
  const raw =
    typeof args === "string"
      ? (() => {
          try {
            return JSON.parse(args);
          } catch {
            return undefined;
          }
        })()
      : args;
  const parsed = schema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : undefined;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** The task number handed to the model: when the job started, and the vendor's own id. */
export function videoTaskNumber(
  submittedAtMs: number,
  vendorId: string,
): string {
  return `video-${Math.floor(submittedAtMs / 1000)}-${vendorId}`;
}

function readTaskNumber(
  value: string,
): { submittedAtMs: number; vendorId: string } | undefined {
  const match = value.trim().match(/^video-(\d{1,12})-(.+)$/);
  if (!match?.[1] || !match[2]) return undefined;
  return { submittedAtMs: Number(match[1]) * 1000, vendorId: match[2] };
}

function sentence(error: unknown, fallback: string): string {
  if (error instanceof MediaProviderError) return error.message;
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
    return "这一轮被停下了，生成没有完成。";
  return fallback;
}

export function mediaTools(options: MediaToolOptions): GrantedTool[] {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const waitMs = options.waitMs ?? VIDEO_WAIT_MS;
  const pollMs = options.pollMs ?? VIDEO_POLL_MS;
  const deadlineMs = options.deadlineMs ?? VIDEO_DEADLINE_MS;
  const asOwner = <T>(work: () => Promise<T>) =>
    runAsTenant(options.ownerUserId, work);

  async function save(
    kind: MediaKind,
    file: GeneratedFile,
    prompt: string,
    provider: { id: string; model: string },
  ) {
    return asOwner(() =>
      options.store.save({
        agentId: options.agentId,
        kind,
        mimeType: file.mimeType,
        bytes: file.bytes,
        prompt,
        provider: provider.id,
        model: provider.model,
      }),
    );
  }

  async function counted(
    kind: MediaKind,
    provider: { id: string; model: string },
    count: number,
  ) {
    if (!options.auditStore) return;
    await recordPersonAuditEvent(options.auditStore, options.ownerUserId, {
      eventType: "media.generated",
      targetType: "generated_media",
      ...(options.initiator ? { initiator: options.initiator } : {}),
      actorUserId: options.ownerUserId,
      payload: {
        bot: options.agentId,
        kind,
        provider: provider.id,
        model: provider.model,
        count,
      },
    }).catch(() => {
      // Counting never fails the call: the person still gets the picture.
      console.warn({
        error: "media_audit_failed",
        timestamp: new Date().toISOString(),
      });
    });
  }

  /** The picture a video starts from, or a sentence saying why it cannot be used. */
  async function startingImage(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ image: GeneratedFile; link?: string } | string> {
    const id = mediaIdOf(url);
    if (id) {
      const stored = await asOwner(() => options.store.read(id));
      if (stored?.kind !== "image")
        return "image_url 指向的图片找不到，或者不是这位用户的图片。";
      return { image: { bytes: stored.bytes, mimeType: stored.mimeType } };
    }
    if (!/^https:\/\//i.test(url.trim()))
      return "image_url 只能是刚生成的 /api/media/… 地址，或公开的 https 图片链接。";
    try {
      const image = await downloadLink(
        url.trim(),
        options.outbound,
        MAX_IMAGE_BYTES,
        "起始图片",
        signal,
      );
      if (!isImageType(image.mimeType))
        return "image_url 下载下来不是 PNG、JPEG、GIF 或 WebP 图片。";
      return { image, link: url.trim() };
    } catch (error) {
      return sentence(error, "image_url 的图片下载失败。");
    }
  }

  /** Polls a job until it is done, fails, or this call's wait runs out. */
  async function follow(
    vendorId: string,
    submittedAtMs: number,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const setup = options.config.video;
    if (!setup.ready) return setup.problem;
    const provider = setup.provider;
    const task = videoTaskNumber(submittedAtMs, vendorId);
    const stopWaiting = now() + waitMs;
    for (;;) {
      const status = await provider.poll(vendorId, signal);
      if (status.state === "failed")
        return `视频没有生成出来：${status.reason}。可以换个描述再试。`;
      if (status.state === "done") {
        const id = await save("video", status.file, prompt, provider);
        await counted("video", provider, 1);
        const url = mediaUrl(id);
        return `视频已生成：[视频](${url})\n在回复里原样放上这个链接，对方点开就能看（登录后可以打开）。`;
      }
      if (now() - submittedAtMs >= deadlineMs)
        return `视频生成超时：提交 ${Math.round(deadlineMs / 60_000)} 分钟后还没生成好（任务号 ${task}）。请告诉对方这次没有生成出来，可以稍后换个描述重新生成。`;
      if (now() + pollMs > stopWaiting) {
        const progress =
          typeof status.progress === "number"
            ? `，进度约 ${Math.round(status.progress)}%`
            : "";
        return `视频还在生成${progress}。任务号：${task}\n过一两分钟用 ${CHECK_VIDEO_TOOL} 带上这个任务号取结果，不要重新提交；先告诉对方视频正在生成。`;
      }
      await sleep(pollMs, signal);
    }
  }

  return [
    {
      name: GENERATE_IMAGE_TOOL,
      ref: GENERATE_IMAGE_REF,
      description:
        "按文字描述生成图片（插图、海报、示意图等），存好后返回站内地址。在回复里用 markdown 图片写法 ![说明](地址) 放出来，对方就能直接看到。",
      parameters: imageParameters,
      async execute(args, execution) {
        const input = parse(imageParameters, args);
        const prompt = input?.prompt.trim() ?? "";
        if (!input || !prompt)
          return "没有生成：prompt 不能为空，写清楚要画什么。";
        if (prompt.length > PROMPT_LIMIT)
          return `没有生成：prompt 超过 ${PROMPT_LIMIT} 字，请精简。`;
        const n = input.n ?? 1;
        if (n < 1 || n > 4) return "没有生成：n 只能是 1 到 4。";
        const size = input.size?.trim();
        if (size && !/^\d{2,5}x\d{2,5}$/.test(size))
          return "没有生成：size 要写成 宽x高，例如 1024x1024。";
        const setup = options.config.image;
        if (!setup.ready) return setup.problem;
        const provider = setup.provider;
        try {
          const files = await provider.generate(
            { prompt, n, ...(size ? { size } : {}) },
            execution?.signal,
          );
          const urls: string[] = [];
          for (const file of files)
            urls.push(mediaUrl(await save("image", file, prompt, provider)));
          await counted("image", provider, urls.length);
          const lines = urls.map(
            (url, index) => `${index + 1}. ![图片 ${index + 1}](${url})`,
          );
          return `已生成 ${urls.length} 张图片：\n${lines.join("\n")}\n在回复里原样放上面的 markdown 图片，对方就能直接看到（地址登录后可以打开）。要做进 PPT 或文档时，告诉对方图片的地址。`;
        } catch (error) {
          return `图片没有生成出来：${sentence(error, "保存图片时出错了。")}`;
        }
      },
    },
    {
      name: GENERATE_VIDEO_TOOL,
      ref: GENERATE_VIDEO_REF,
      description: `按文字描述（可带一张起始图片）生成短视频。视频要几分钟：先等一会儿，生成好就返回站内地址；没等到就返回任务号，之后用 ${CHECK_VIDEO_TOOL} 取结果。`,
      parameters: videoParameters,
      async execute(args, execution) {
        const input = parse(videoParameters, args);
        const prompt = input?.prompt.trim() ?? "";
        if (!input || !prompt)
          return "没有提交：prompt 不能为空，写清楚视频里发生什么。";
        if (prompt.length > PROMPT_LIMIT)
          return `没有提交：prompt 超过 ${PROMPT_LIMIT} 字，请精简。`;
        if (
          input.duration !== undefined &&
          (input.duration < 1 || input.duration > 60)
        )
          return "没有提交：duration 是秒数，1 到 60 之间。";
        const setup = options.config.video;
        if (!setup.ready) return setup.problem;
        const signal = execution?.signal;
        try {
          let start: { image: GeneratedFile; link?: string } | undefined;
          if (input.image_url?.trim()) {
            const found = await startingImage(input.image_url, signal);
            if (typeof found === "string") return `没有提交：${found}`;
            start = found;
          }
          const submittedAt = now();
          const vendorId = await setup.provider.submit(
            {
              prompt,
              ...(start ? { image: start.image } : {}),
              ...(start?.link ? { imageUrl: start.link } : {}),
              ...(input.duration !== undefined
                ? { duration: input.duration }
                : {}),
            },
            signal,
          );
          return await follow(vendorId, submittedAt, prompt, signal);
        } catch (error) {
          return `视频没有生成出来：${sentence(error, "保存视频时出错了。")}`;
        }
      },
    },
    {
      name: CHECK_VIDEO_TOOL,
      ref: CHECK_VIDEO_REF,
      description: `查 ${GENERATE_VIDEO_TOOL} 提交的视频生成好了没有：等一会儿，生成好就返回站内地址，没好就再说一声还在生成。`,
      parameters: checkParameters,
      async execute(args, execution) {
        const input = parse(checkParameters, args);
        const task = input ? readTaskNumber(input.task_id) : undefined;
        if (!task)
          return `任务号不对：要原样传回 ${GENERATE_VIDEO_TOOL} 给的任务号（video- 开头）。`;
        try {
          return await follow(
            task.vendorId,
            task.submittedAtMs,
            "（由 check_video 取回的视频）",
            execution?.signal,
          );
        } catch (error) {
          return `视频没有取到：${sentence(error, "保存视频时出错了。")}`;
        }
      },
    },
  ];
}

/**
 * What a coworker is offered of these once its rules have had their say: `check_video` only beside
 * `generate_video`.
 */
export function offeredMediaTools<T extends { name: string }>(tools: T[]): T[] {
  const canStartVideo = tools.some((tool) => tool.name === GENERATE_VIDEO_TOOL);
  return canStartVideo
    ? tools
    : tools.filter((tool) => tool.name !== CHECK_VIDEO_TOOL);
}
