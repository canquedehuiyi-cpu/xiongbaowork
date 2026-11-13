/**
 * The headers the server sends this computer: which Bot, which person, the computer's secret, and
 * the one the egress filter puts on a refusal.
 *
 * WHY TWO NAMES. They are being renamed, and a computer image can be rolled out before the server
 * that talks to it, so for a release this side takes both and the server keeps sending the old ones.
 * The next release moves the server to the new names, and the one after drops the old ones here.
 *
 * ONE VALUE PER HEADER. Taking two names is exactly where a check can open: a request with a wrong
 * secret under one name and the right one under the other must not get in because one of them
 * matched. `readWireHeader` gives the new name precedence, so the old one is never consulted when
 * the new one has a value. And a request whose two names carry different values is refused outright
 * (`disagreeingWireHeader`), the token included: nothing says which of the two is the forgery.
 */

export const HEADER = {
  botId: "x-xiongbao-bot-id",
  personId: "x-xiongbao-person-id",
  computerToken: "x-xiongbao-computer-token",
  egress: "x-xiongbao-egress",
} as const;

// legacy-compat：introducedIn 0.2.11，removeIn 0.2.13，Task 20/21
export const LEGACY_HEADER = {
  botId: "x-openbot-bot-id",
  personId: "x-openbot-person-id",
  computerToken: "x-openbot-computer-token",
  egress: "x-openbot-egress",
} as const;

export type WireHeader = keyof typeof HEADER;

/** The header's value, trimmed: the new name when it is not blank, otherwise the old one. */
export function readWireHeader(
  headers: Headers,
  name: WireHeader,
): string | undefined {
  return (
    headers.get(HEADER[name])?.trim() ||
    headers.get(LEGACY_HEADER[name])?.trim() ||
    undefined
  );
}

/** Do the two names both carry a value, and different ones? Blank is no value, as in `readWireHeader`. */
export function wireHeaderDisagrees(
  headers: Headers,
  name: WireHeader,
): boolean {
  const fresh = headers.get(HEADER[name])?.trim();
  const legacy = headers.get(LEGACY_HEADER[name])?.trim();
  return Boolean(fresh && legacy && fresh !== legacy);
}

/** The ones a caller sends. The egress name is only ever on a refusal this computer writes. */
const REQUEST_HEADERS = ["botId", "personId", "computerToken"] as const;

/**
 * The first request header whose two names disagree, or undefined. A blank new name next to a filled
 * old one is the old one, not a disagreement.
 */
export function disagreeingWireHeader(
  headers: Headers,
): WireHeader | undefined {
  return REQUEST_HEADERS.find((name) => wireHeaderDisagrees(headers, name));
}
