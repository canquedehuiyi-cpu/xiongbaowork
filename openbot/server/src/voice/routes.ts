import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AppVariables } from "../auth/guards";
import type { ChannelStore } from "../channels/routes";
import {
  isVoiceSdp,
  MAX_VOICE_SDP_BYTES,
  type VoiceConnection,
  VoiceError,
  type VoiceProvider,
} from "./provider";
import {
  createVoiceSessionRoutes,
  type VoiceSessionServices,
} from "./session-routes";

const VOICE_HANDSHAKE_TIMEOUT_MS = 20_000;
const ATTEMPT_WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;
const MAX_TRACKED_USERS = 1024;

export function createVoiceRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  provider: VoiceProvider | undefined,
  channels: Pick<ChannelStore, "get"> | undefined,
  profiles?: Pick<AgentProfileStore, "get">,
  sessions?: VoiceSessionServices,
  learningForAgent?: (agentId: string) => Promise<boolean>,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const active = new Set<string>();
  const attempts = new Map<string, { count: number; expires: number }>();
  app.use("*", requireUser);
  app.route("/sessions", createVoiceSessionRoutes(sessions));
  app.get("/config", (context) => {
    context.header("Cache-Control", "no-store");
    if (!provider || !channels || !profiles)
      return context.json({ error: "实时语音尚未配置。" }, 503);
    return context.json({ transport: provider.transport });
  });
  app.post(
    "/calls",
    async (context, next) => {
      context.header("Cache-Control", "no-store");
      // Cross-origin HTML forms cannot set this header; this route grants no CORS access.
      if (context.req.header("x-openbot-voice") !== "1") {
        return context.json({ error: "无效的语音请求。" }, 403);
      }
      if (!provider || !channels || !profiles)
        return context.json({ error: "实时语音尚未配置。" }, 503);
      const userId = context.var.actor.id;
      const now = Date.now();
      for (const [id, attempt] of attempts) {
        if (attempt.expires <= now) attempts.delete(id);
      }
      const attempt = attempts.get(userId);
      if (
        active.has(userId) ||
        active.size >= 8 ||
        (attempt && attempt.count >= MAX_ATTEMPTS) ||
        (!attempt && attempts.size >= MAX_TRACKED_USERS)
      ) {
        context.header("Retry-After", "60");
        return context.json(
          {
            error: "语音连接尝试过于频繁，请稍后重试。",
          },
          429,
        );
      }
      attempts.set(userId, {
        count: (attempt?.count ?? 0) + 1,
        expires: attempt?.expires ?? now + ATTEMPT_WINDOW_MS,
      });
      active.add(userId);
      try {
        await next();
      } finally {
        active.delete(userId);
      }
    },
    bodyLimit({
      maxSize: MAX_VOICE_SDP_BYTES,
      onError: (context) => context.json({ error: "语音连接请求过大。" }, 413),
    }),
    async (context) => {
      if (
        context.req.header("content-type")?.split(";")[0]?.trim() !==
        "application/json"
      ) {
        return context.json({ error: "语音连接请求必须是 JSON 格式。" }, 400);
      }
      const body: unknown = await context.req.json().catch(() => null);
      if (
        !body ||
        typeof body !== "object" ||
        !("channelId" in body) ||
        typeof body.channelId !== "string" ||
        !body.channelId.trim() ||
        body.channelId.length > 256
      ) {
        return context.json({ error: "需要提供频道和有效的音频 SDP。" }, 400);
      }
      if (!provider || !channels || !profiles)
        return context.json({ error: "实时语音尚未配置。" }, 503);
      const offer = "sdp" in body ? body.sdp : undefined;
      if (
        (provider.transport === "webrtc" || offer !== undefined) &&
        !isVoiceSdp(offer)
      ) {
        return context.json({ error: "需要提供有效的音频 SDP offer。" }, 400);
      }
      let channel: Awaited<ReturnType<ChannelStore["get"]>>;
      try {
        channel = await channels.get(context.var.actor, body.channelId);
      } catch {
        return context.json({ error: "无法加载该频道，请重试。" }, 503);
      }
      if (!channel) return context.json({ error: "Channel not found." }, 404);
      if (!channel.active)
        return context.json({ error: "该频道已不再活跃。" }, 409);
      const agentId = channel.agentIds[0];
      if (channel.agentIds.length !== 1 || !agentId)
        return context.json(
          { error: "实时语音要求频道中恰好有一位数字员工。" },
          400,
        );
      let profile: Awaited<ReturnType<AgentProfileStore["get"]>>;
      try {
        profile = await profiles.get(context.var.actor, agentId);
      } catch {
        return context.json({ error: "无法加载该数字员工，请重试。" }, 503);
      }
      if (!profile || profile.deletedAt)
        return context.json({ error: "Agent not found." }, 404);
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(),
        VOICE_HANDSHAKE_TIMEOUT_MS,
      );
      const signal = AbortSignal.any([context.req.raw.signal, timeout.signal]);
      try {
        signal.throwIfAborted();
        const connection = await connectWithCancellation(provider, {
          sdp: typeof offer === "string" ? offer : undefined,
          agentName: profile.name,
          agentTitle: profile.title,
          agentRole: profile.roleDescription,
          learningEnabled: (await learningForAgent?.(agentId)) ?? false,
          userId: context.var.actor.id,
          signal,
        });
        return context.json(connection);
      } catch (error) {
        return signal.aborted
          ? context.json(
              {
                error:
                  "Voice connection timed out or was cancelled. Please retry.",
              },
              504,
            )
          : context.json(
              {
                // VoiceError carries only fixed text written for the caller, such as the service
                // being busy; anything else may hold an upstream body and stays generic.
                error:
                  error instanceof VoiceError
                    ? error.message
                    : "The voice service could not start a call. Please retry.",
              },
              502,
            );
      } finally {
        clearTimeout(timer);
      }
    },
  );
  return app;
}

/** A misbehaving adapter must not retain the user's handshake slot after cancellation. */
async function connectWithCancellation(
  provider: VoiceProvider,
  input: Parameters<VoiceProvider["connect"]>[0],
): Promise<VoiceConnection> {
  const { signal } = input;
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      provider.connect(input),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
