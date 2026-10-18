import { type BaseEvent, EventType } from "@ag-ui/client";
import { catchError, type Observable, of, throwError } from "rxjs";

/**
 * A provider's refusal, turned into something a person can read.
 *
 * The AI SDK signals a rejected call with `AI_APICallError`, which carries the HTTP status and the
 * provider's own response body. Until now only 401 had a branch (`desktop-connection-failure.ts`, which
 * tells the native host to open the model settings); every other refusal left the observable errored, so
 * the browser printed "network error", the board closed the card as failed with no reason anywhere on it,
 * and the one party that said what was wrong — the provider, in its own sentence — was thrown away. The
 * audit's first real-model attempt died exactly this way: a 400 naming the model names the endpoint does
 * support, and a screen that showed none of it (N3).
 *
 * The refusal therefore goes on the stream as the event both surfaces already handle — `RUN_ERROR` — and
 * the stream then closes normally, which is also what makes the task card land in `failed` rather than
 * `awaiting_review` (see `carriedFailure` in `threads/postgres-runner.ts`).
 *
 * NOT 401. That status has an owner elsewhere: the desktop host reads its signal and opens the credential
 * screen, which is the right answer for a bad key and the wrong one for a bad model name. Converting it
 * here would take that path away, so it is rethrown untouched.
 *
 * NOT every error either. "Unable to connect" is not a refusal by anybody and inventing a provider
 * sentence for it would send the person to edit a model name that was never the problem.
 */

/** The most the provider's own words contribute to the sentence, counted in code points. */
const MAX_PROVIDER_WORDS = 300;

/**
 * Credentials a provider might echo back inside its error body.
 *
 * Some vendors quote the rejected `Authorization` header verbatim, and this text is about to be written
 * into a task card, a transcript, and whatever log the deployment keeps. A key must not travel there.
 */
const CREDENTIAL_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

type ProviderFailure = { status: number; body: string };

/** Walks the cause chain, because `BuiltInAgent` wraps the SDK error before rethrowing it. */
function findFailure(value: unknown, depth = 0): ProviderFailure | null {
  if (depth > 5 || !(value instanceof Error)) return null;
  const candidate = value as Error & {
    statusCode?: unknown;
    responseBody?: unknown;
  };
  if (
    candidate.name === "AI_APICallError" &&
    typeof candidate.statusCode === "number"
  ) {
    return {
      status: candidate.statusCode,
      body:
        typeof candidate.responseBody === "string"
          ? candidate.responseBody
          : "",
    };
  }
  return value.cause === value ? null : findFailure(value.cause, depth + 1);
}

/** The provider's sentence, out of whatever shape its body came in. */
function providerWords(body: string): string {
  const withoutCredentials = CREDENTIAL_SHAPES.reduce(
    (text, shape) => text.replace(shape, "«凭据已隐去»"),
    body,
  ).trim();
  if (!withoutCredentials) return "";
  let text = withoutCredentials;
  try {
    const parsed: unknown = JSON.parse(withoutCredentials);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const nested =
        record.error && typeof record.error === "object"
          ? (record.error as Record<string, unknown>).message
          : undefined;
      const direct =
        typeof record.message === "string"
          ? record.message
          : typeof record.error === "string"
            ? record.error
            : undefined;
      const words = typeof nested === "string" ? nested : direct;
      if (words) text = words;
    }
  } catch {
    // Not JSON: many gateways answer 429 with a plain line, and that line is the whole message.
  }
  const codePoints = Array.from(text.replace(/\s+/g, " "));
  return codePoints.length > MAX_PROVIDER_WORDS
    ? `${codePoints.slice(0, MAX_PROVIDER_WORDS).join("")}…`
    : codePoints.join("");
}

/** Who refused, in the person's language, from the status the provider actually sent. */
function refusalOf(status: number): string {
  if (status === 400) return "模型供应商不接受这一轮的请求";
  if (status === 401) return "模型供应商不认这份凭据";
  if (status === 402) return "模型供应商因为账户余额已经用完而停止服务";
  if (status === 403) return "模型供应商说这个账户无权使用该模型";
  if (status === 404) return "模型供应商说它这里没有这个模型";
  if (status === 429) return "模型供应商在这一刻限流了，这一轮没有排上";
  if (status >= 500) return "模型供应商那边出了错";
  return `模型供应商返回了 HTTP ${status}`;
}

/** The `RUN_ERROR` both surfaces already subscribe to, carrying the sentence. */
function runError(failure: ProviderFailure): BaseEvent {
  const words = providerWords(failure.body);
  return {
    type: EventType.RUN_ERROR,
    message: `${refusalOf(failure.status)}（HTTP ${failure.status}）。${
      words ? `供应商原话：「${words}」` : "供应商没有说明原因。"
    }`,
    code: "OPENBOT_PROVIDER_REQUEST_REFUSED",
  } as unknown as BaseEvent;
}

/**
 * Replace a provider refusal with a `RUN_ERROR` and a normal close; pass anything else through.
 *
 * Applied wherever an agent stream is handed to the runner — see `observeModelConnection`, which is the
 * one helper all three of those sites already call.
 */
export function providerFailureAsRunError(
  stream: Observable<BaseEvent>,
): Observable<BaseEvent> {
  return stream.pipe(
    catchError((error: unknown) => {
      const failure = findFailure(error);
      if (!failure || failure.status === 401) return throwError(() => error);
      return of(runError(failure));
    }),
  );
}
