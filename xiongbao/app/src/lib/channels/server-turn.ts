import type { ChannelWork } from "./queries";

/*
 * 名册里「服务器上有一轮在跑」的纯判断，单独成文件：`queries.ts` 要用它，而 `background-run.ts` 还连着部署能力
 * 查询（再连到品牌和生成的应用配置），放在一起会让只想读名册的地方也把这些拖进来。
 */

/** 服务器说的起点：这段对话里最早开跑的那一轮；没有就是 null。 */
export function serverTurnSince(
  work: readonly ChannelWork[] | undefined,
): number | null {
  let earliest: number | null = null;
  for (const entry of work ?? []) {
    if (entry.kind !== "turn") continue;
    const at = Date.parse(entry.since);
    if (Number.isFinite(at) && (earliest === null || at < earliest))
      earliest = at;
  }
  return earliest;
}

/** 名册里有没有哪段对话有一轮在服务器上跑着：有就隔一会儿再读一次，免得说完了还挂着。 */
export const TURN_POLL_MS = 15_000;
export function hasServerTurn(
  channels: readonly { work?: readonly ChannelWork[] }[],
): boolean {
  return channels.some((channel) => serverTurnSince(channel?.work) !== null);
}
