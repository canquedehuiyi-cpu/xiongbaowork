/**
 * `--census`：只读连接器市场索引，写一份普查 YAML。
 *
 * 从 `index.ts` 拆出来（技术债 #25）。与移植管线零耦合：一次读、一次 stat、一次写，
 * 所以它能在 CI 每次 push 时安全地跑。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  buildCensus,
  type Census,
  CensusError,
  formatCensusCounts,
  formatCensusTiers,
  renderCensus,
} from "./census";
import { EXIT_INVALID, EXIT_OK, type CliOptions } from "./cli-args";
import type { RunnableLevel } from "./mapping";

/** Print a level breakdown as `full 12 / degraded 9 / blocked 2`. */
export function formatCounts(counts: Record<RunnableLevel, number>): string {
  return `full ${counts.full} / degraded ${counts.degraded} / blocked ${counts.blocked}`;
}

/**
 * Survey the connector marketplace and write the census.
 *
 * Nothing here touches the source tree: one file is read, the directories are stat-ed, one YAML file is
 * written. That is what makes it safe to run in CI on every push.
 */
export function runCensus(options: CliOptions): number {
  try {
    console.log(`[port:capabilities] census ${options.sourceRoot}`);
    const census = buildCensus(options.sourceRoot);
    mkdirSync(dirname(options.censusPath), { recursive: true });
    writeFileSync(options.censusPath, renderCensus(census), "utf8");
    console.log(
      `[port:capabilities] 普查 ${census.counts.total} 条：${formatCensusCounts(census)}`,
    );
    console.log(`[port:capabilities] 三档 ${formatCensusTiers(census)}`);
    console.log(`[port:capabilities] transport ${TRANSPORT_SUMMARY(census)}`);
    console.log(`[port:capabilities] 写出 ${options.censusPath}`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof CensusError) {
      console.error(`[port:capabilities] 普查失败：${error.message}`);
      return EXIT_INVALID;
    }
    throw error;
  }
}

/** `mcp-url 239 / mcp-command 15 / cli 44`, in report order. */
function TRANSPORT_SUMMARY(census: Census): string {
  return Object.entries(census.counts.by_transport)
    .map(([transport, count]) => `${transport} ${count}`)
    .join(" / ");
}
