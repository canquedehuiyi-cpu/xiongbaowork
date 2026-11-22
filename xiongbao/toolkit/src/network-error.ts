/**
 * Whether a failure is a connection that dropped or never opened, as opposed to an answer the other
 * side gave: the one kind of failure a model call is made again for (`model-net-retry`), and the
 * list the server's read retries (`plugins/transient.ts`) use for the same codes.
 *
 * Only the network layer. An HTTP status (401, 402, 429, 5xx) is the provider's answer, and what is
 * done about it is not decided here.
 */

/** A connection that dropped or never opened, by the code Node, Bun and undici give it. */
export const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ConnectionRefused",
  "ConnectionClosed",
]);

/** The same failures when only their words survived (an error message passed along as text). */
const NETWORK_WORDS =
  /socket connection was closed unexpectedly|socket hang up|other side closed|fetch failed|Unable to connect|\b(?:ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|UND_ERR_SOCKET)\b/i;

type ErrorLike = {
  name?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  message?: unknown;
  cause?: unknown;
};

/**
 * Whether a thrown failure (or an error part's `error`) is a dropped connection. Follows the cause
 * chain, since a transport's error is usually wrapped. A failure that carries an HTTP status is the
 * other side's answer and is never one. An abort is not one either.
 */
export function droppedConnection(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "string") return NETWORK_WORDS.test(current);
    if (typeof current !== "object") return false;
    const value = current as ErrorLike;
    if (value.name === "AbortError" || value.name === "TimeoutError")
      return false;
    if (
      typeof value.status === "number" ||
      typeof value.statusCode === "number"
    )
      return false;
    if (typeof value.code === "string" && NETWORK_CODES.has(value.code))
      return true;
    if (typeof value.message === "string" && NETWORK_WORDS.test(value.message))
      return true;
    current = value.cause;
  }
  return false;
}

/** The deployment switch for the model call's one retry on a dropped connection. */
export const MODEL_NET_RETRY_ENV = "XIONGBAO_MODEL_NET_RETRY";

/** 开着吗：默认开，只有明确写 `off` 才关。 */
export function modelNetRetryOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[MODEL_NET_RETRY_ENV]?.trim().toLowerCase() !== "off";
}
