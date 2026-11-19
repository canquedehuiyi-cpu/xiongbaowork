import { randomUUID } from "node:crypto";
import type { Env, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { productName } from "../../brand";
import type { AgentUpstream } from "../../models/runtime-resolver";
import {
  buildModelTokenCallRow,
  type MeteringOutcome,
  type ModelTokenCallSink,
} from "../../models/token-metering";
import {
  guardedFetch,
  type OutboundPolicy,
  OutboundRefusedError,
} from "../../net/outbound-guard";
import { isPersonTenant, runAsTenant } from "../../tenant/context";
import type { AgentModelClaims, AgentModelTokens } from "./token";
import {
  type ModelWire,
  unsupportedWireMessage,
  upstreamTarget,
} from "./upstream";
import { createUsageTap, type UsageTap } from "./usage";

/**
 * The model proxy external employees' agents (Codex, Claude Code) send their model requests to
 * instead of to a provider.
 *
 *   POST /api/agent-model/v1/responses   OpenAI Responses     (Codex)
 *   POST /api/agent-model/v1/messages    Anthropic Messages   (Claude Code)
 *   GET  /api/agent-model/v1/models      the employee's one model
 *
 * WHO MAY ASK. Only a holder of a pass this server signed (`./token.ts`): it names the tenant, the
 * employee and the thread. Every request also asks whether that employee is still one of that
 * tenant's external employees, so a deleted employee's pass stops working at once.
 *
 * WHAT IT DOES TO A REQUEST. It forwards it. The first version does not translate between formats:
 * a provider that speaks the format itself (DeepSeek speaks both) gets the body as it was, with three
 * changes. The `model` is the one the employee is bound to in XiongBao. The credential is the
 * employee's real one, read here and never sent anywhere but that provider. And the usage the
 * response reports, streamed or not, is written to `model_token_calls` under the tenant that pays,
 * like a call a built-in coworker makes. A provider that has no such endpoint is refused with a
 * sentence saying which model to pick instead.
 *
 * WHERE IT GOES. Only where the employee's own model configuration points: nothing in the request
 * (a header, a query, a field in the body) names an address, and the destination goes through the
 * same outbound check as every tenant-chosen model address, so a redirect is never followed with a
 * key attached.
 *
 * HOW MUCH. A tenant over its plan's monthly task allowance, and an employee asking faster than
 * `perMinute` calls a minute, are answered 429 with the reason in Chinese.
 */

export const AGENT_MODEL_ROUTE = "/api/agent-model";

/** The largest request body forwarded: a coding agent sends its whole working context each step. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** How many calls one employee may make in a minute unless the deployment says otherwise. */
export const AGENT_MODEL_DEFAULT_PER_MINUTE = 300;

export type AgentModelProxyDeps = {
  tokens: AgentModelTokens;
  /** Whether this employee is still an external employee of this tenant. Asked in the tenant's frame. */
  employeeActive: (claims: AgentModelClaims) => Promise<boolean>;
  /** The employee's own model with the real key, null when it has none. Asked in the tenant's frame. */
  resolveUpstream: (claims: AgentModelClaims) => Promise<AgentUpstream | null>;
  /** A sentence when the tenant may not spend more, else null. */
  quota?: (tenantId: string) => Promise<string | null>;
  sink: ModelTokenCallSink;
  /** The outbound check, plus the test doubles `guardedFetch` takes. */
  outbound?: OutboundPolicy;
  /** Calls per employee per minute. */
  perMinute?: number;
  now?: () => number;
  log?: (message: string) => void;
};

export type AgentModelProxy = {
  forward(request: Request, wire: ModelWire): Promise<Response>;
  models(request: Request): Promise<Response>;
};

type Failure = {
  status: number;
  /** Anthropic's names for the same classes of error. */
  kind:
    | "authentication_error"
    | "permission_error"
    | "invalid_request_error"
    | "rate_limit_error"
    | "api_error";
  message: string;
  retryAfterSeconds?: number;
};

/** The error in the body shape the caller's own client reads. */
function failure(wire: ModelWire, input: Failure): Response {
  const body =
    wire === "messages"
      ? { type: "error", error: { type: input.kind, message: input.message } }
      : {
          error: {
            message: input.message,
            type: input.kind,
            code: `xiongbao_${input.kind}`,
          },
        };
  return new Response(JSON.stringify(body), {
    status: input.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(input.retryAfterSeconds
        ? { "retry-after": String(input.retryAfterSeconds) }
        : {}),
    },
  });
}

/** The pass from `Authorization: Bearer …` or `x-api-key`, which is where each harness puts it. */
function presented(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? "");
  return (
    bearer?.[1]?.trim() || request.headers.get("x-api-key")?.trim() || undefined
  );
}

/** Response headers worth handing back; the rest belong to the provider's connection, not ours. */
const RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "retry-after",
  "request-id",
  "x-request-id",
];

function answerHeaders(from: Headers): Headers {
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = from.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export function createAgentModelProxy(
  deps: AgentModelProxyDeps,
): AgentModelProxy {
  const now = deps.now ?? Date.now;
  const perMinute = deps.perMinute ?? AGENT_MODEL_DEFAULT_PER_MINUTE;
  const log = deps.log ?? ((message: string) => console.warn(message));
  /** `tenant\nagent` → the instants of its calls in the last minute. */
  const recent = new Map<string, number[]>();

  /** Seconds to wait, or 0 when this call may go. Counts the call when it may. */
  function throttle(claims: AgentModelClaims): number {
    const current = now();
    const key = `${claims.tenantId}\n${claims.agentId}`;
    const kept = (recent.get(key) ?? []).filter((at) => current - at < 60_000);
    if (kept.length >= perMinute) {
      recent.set(key, kept);
      return Math.max(
        1,
        Math.ceil((60_000 - (current - (kept[0] ?? current))) / 1000),
      );
    }
    kept.push(current);
    recent.set(key, kept);
    // Employees that stopped asking should not be remembered forever.
    if (recent.size > 5_000)
      for (const [other, times] of recent)
        if (times.every((at) => current - at >= 60_000)) recent.delete(other);
    return 0;
  }

  /** The claims of a request that may go on, or the answer that refuses it. */
  async function admit(
    request: Request,
    wire: ModelWire,
  ): Promise<{ claims: AgentModelClaims } | { refused: Response }> {
    const claims = deps.tokens.verify(presented(request));
    if (!claims || !isPersonTenant(claims.tenantId))
      return {
        refused: failure(wire, {
          status: 401,
          kind: "authentication_error",
          message: `这个令牌无效或已过期，请回到${productName()}重新打开这位员工的对话。`,
        }),
      };
    let active = false;
    try {
      active = await runAsTenant(claims.tenantId, () =>
        deps.employeeActive(claims),
      );
    } catch {
      return {
        refused: failure(wire, {
          status: 502,
          kind: "api_error",
          message: `${productName()}暂时没能确认这位员工的身份，请稍后再试。`,
        }),
      };
    }
    if (!active)
      return {
        refused: failure(wire, {
          status: 403,
          kind: "permission_error",
          message: "这位员工已经不在了，或不属于这个空间，模型不再可用。",
        }),
      };
    const wait = throttle(claims);
    if (wait > 0)
      return {
        refused: failure(wire, {
          status: 429,
          kind: "rate_limit_error",
          message: "这位员工请求模型太频繁了，请稍等一会儿再继续。",
          retryAfterSeconds: wait,
        }),
      };
    return { claims };
  }

  /** Writes the call's row once, whatever way it ended. */
  function recorder(
    upstream: AgentUpstream,
    claims: AgentModelClaims,
    wire: ModelWire,
    tap: UsageTap,
  ) {
    const callId = randomUUID();
    const startedAt = new Date();
    let settled = false;
    return (end: "end" | "cancel" | "error" | "failed") => {
      if (settled) return;
      settled = true;
      try {
        const { usage, finished, finishReason, model } = tap.result();
        const outcome: MeteringOutcome =
          end === "failed"
            ? "unknown"
            : finished
              ? "completed"
              : end === "cancel"
                ? "stopped"
                : "unknown";
        const row = buildModelTokenCallRow({
          binding: upstream.metering,
          scope: { runId: "", threadId: claims.threadId },
          callId,
          sdkProvider: `xiongbao-agent-model.${wire}`,
          sdkModelId: upstream.modelName,
          startedAt,
          observedAt: new Date(),
          outcome,
          usage,
          finishReason,
          responseModelId: model,
        });
        Promise.resolve(deps.sink(row)).catch(() =>
          log("agent-model: a call could not be recorded"),
        );
      } catch {
        log("agent-model: a call could not be recorded");
      }
    };
  }

  return {
    async forward(request, wire) {
      const admitted = await admit(request, wire);
      if ("refused" in admitted) return admitted.refused;
      const { claims } = admitted;

      if (deps.quota) {
        const over = await deps.quota(claims.tenantId).catch(() => null);
        if (over)
          return failure(wire, {
            status: 429,
            kind: "rate_limit_error",
            message: over,
          });
      }

      let upstream: AgentUpstream | null;
      try {
        upstream = await runAsTenant(claims.tenantId, () =>
          deps.resolveUpstream(claims),
        );
      } catch {
        return failure(wire, {
          status: 502,
          kind: "api_error",
          message: `${productName()}暂时没能读取这位员工的模型配置，请稍后再试。`,
        });
      }
      if (!upstream)
        return failure(wire, {
          status: 400,
          kind: "invalid_request_error",
          message: "这位员工还没有可用的模型，请在员工设置里为它选一个模型。",
        });
      const target = upstreamTarget(wire, upstream.provider, upstream.baseUrl);
      if (!target)
        return failure(wire, {
          status: 400,
          kind: "invalid_request_error",
          message: unsupportedWireMessage(
            wire,
            `${upstream.provider}/${upstream.modelName}`,
          ),
        });

      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES)
        return failure(wire, {
          status: 413,
          kind: "invalid_request_error",
          message: "这次请求的内容太大了。",
        });
      let body: Record<string, unknown>;
      try {
        const text = await request.text();
        if (text.length > MAX_REQUEST_BYTES) throw new Error("too large");
        const parsed: unknown = JSON.parse(text);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        )
          throw new Error("not an object");
        body = parsed as Record<string, unknown>;
      } catch {
        return failure(wire, {
          status: 400,
          kind: "invalid_request_error",
          message: "请求内容不是有效的 JSON。",
        });
      }
      // The employee's model, whatever the agent asked for.
      body.model = upstream.modelName;

      const headers = new Headers({
        "content-type": "application/json",
        accept: request.headers.get("accept") ?? "application/json",
        ...target.headers,
      });
      if (target.auth === "bearer")
        headers.set("authorization", `Bearer ${upstream.apiKey}`);
      else headers.set("x-api-key", upstream.apiKey);
      if (wire === "messages") {
        headers.set(
          "anthropic-version",
          request.headers.get("anthropic-version") ?? "2023-06-01",
        );
        const beta = request.headers.get("anthropic-beta");
        if (beta) headers.set("anthropic-beta", beta);
      }

      const tap = createUsageTap(wire);
      const record = recorder(upstream, claims, wire, tap);
      let response: Response;
      try {
        response = await guardedFetch(
          target.url,
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: request.signal,
          },
          deps.outbound,
        );
      } catch (error) {
        record(request.signal.aborted ? "cancel" : "failed");
        // Never the thrown value: it can carry an address or a header.
        log(
          `agent-model: ${wire} call of ${claims.agentId} could not reach its provider${error instanceof OutboundRefusedError ? " (refused by the outbound check)" : ""}`,
        );
        return failure(wire, {
          status: 502,
          kind: "api_error",
          message:
            error instanceof OutboundRefusedError
              ? "这位员工的模型地址不允许访问，请检查模型配置。"
              : "没能连上这位员工的模型服务，请稍后再试。",
        });
      }

      const streaming = (response.headers.get("content-type") ?? "").includes(
        "text/event-stream",
      );
      if (response.status >= 400 || !response.body) {
        // The provider's own error is passed on as it came; the call is recorded without usage.
        const text = await response.text().catch(() => "");
        record("failed");
        return new Response(text, {
          status: response.status,
          headers: answerHeaders(response.headers),
        });
      }
      if (!streaming) {
        const text = await response.text().catch(() => "");
        try {
          tap.json(JSON.parse(text));
        } catch {
          // A body that is not JSON carries no usage.
        }
        record("end");
        return new Response(text, {
          status: response.status,
          headers: answerHeaders(response.headers),
        });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              record("end");
              controller.close();
              return;
            }
            tap.push(decoder.decode(next.value, { stream: true }));
            controller.enqueue(next.value);
          } catch (error) {
            record("error");
            controller.error(error);
          }
        },
        cancel(reason) {
          record("cancel");
          return reader.cancel(reason);
        },
      });
      return new Response(stream, {
        status: response.status,
        headers: answerHeaders(response.headers),
      });
    },

    async models(request) {
      const admitted = await admit(request, "responses");
      if ("refused" in admitted) return admitted.refused;
      const { claims } = admitted;
      const upstream = await runAsTenant(claims.tenantId, () =>
        deps.resolveUpstream(claims),
      ).catch(() => null);
      const data = upstream
        ? [{ id: upstream.modelName, object: "model", type: "model" }]
        : [];
      return new Response(JSON.stringify({ object: "list", data }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  };
}

/** Mounted ahead of the sign-in middleware: its callers hold a pass, not a session. */
export function mountAgentModelProxy<T extends Env>(
  app: Hono<T>,
  proxy: AgentModelProxy | undefined,
): void {
  if (!proxy) return;
  const limit = bodyLimit({
    maxSize: MAX_REQUEST_BYTES,
    onError: (context) =>
      context.json({ error: { message: "这次请求的内容太大了。" } }, 413),
  });
  app.post(`${AGENT_MODEL_ROUTE}/v1/responses`, limit, (context) =>
    proxy.forward(context.req.raw, "responses"),
  );
  app.post(`${AGENT_MODEL_ROUTE}/v1/messages`, limit, (context) =>
    proxy.forward(context.req.raw, "messages"),
  );
  app.get(`${AGENT_MODEL_ROUTE}/v1/models`, (context) =>
    proxy.models(context.req.raw),
  );
}
