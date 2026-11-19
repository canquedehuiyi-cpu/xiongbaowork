/**
 * The headers the server sends a Bot's computer: which Bot, which person, the computer's secret, and
 * the one the computer's egress filter puts on a refusal.
 *
 * One place for the names, because two programs have to agree on them: the server writes them on every
 * call to a computer (`server/src/computer/client.ts`, `provider.ts`, `policy-network.ts`,
 * `browser/routes.ts`) and the computer reads them (`agent-computer/src/wire-headers.ts`). The server
 * sends only these. The computer still takes the names they replaced for a while, so that a server a
 * release older than its computer still gets in; those are kept beside the code that reads them, not
 * here.
 */
export const HEADER = {
  botId: "x-xiongbao-bot-id",
  personId: "x-xiongbao-person-id",
  computerToken: "x-xiongbao-computer-token",
  egress: "x-xiongbao-egress",
} as const;

export type WireHeader = keyof typeof HEADER;
