import { type Edition, editionHasMemory } from "../edition";
import type { MemoryDefaults } from "./defaults";
import type { MemoryIngestion } from "./ingestion";
import type { LoadPersonalMemory } from "./tools";

/**
 * What of memory runs while XiongBao runs: what a Bot's turn is told it remembers, and the sweep that
 * reads memory sources.
 *
 * NOTHING WHERE MEMORY IS OFF (`editionHasMemory`: the personal edition with `XIONGBAO_PERSONAL_MEMORY=off`).
 * No loader, so no turn picks up memory sources or carries memory in its context, and a sweep that
 * reads nothing, so a source left from before is never synced. Both editions run all of it otherwise.
 */
export function createMemoryRuntime(options: {
  edition: Edition;
  defaults: Pick<MemoryDefaults, "botTurn">;
  ingestion: Pick<MemoryIngestion, "contextFor" | "syncDue">;
  log?: (line: string) => void;
}): {
  /** For the agent resolver. Absent without memory, and then no turn gets the memory middleware. */
  loadForActor?: (ownerUserId: string) => LoadPersonalMemory;
  /** One pass of the background sweep. */
  sweep(): Promise<void>;
} {
  if (!editionHasMemory(options.edition)) return { sweep: async () => {} };
  const log = options.log ?? ((line: string) => console.error(line));
  const attempt = async (operation: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      log(
        JSON.stringify({
          type: "memory-sweep-error",
          error: error instanceof Error ? error.name : "UnknownError",
          context: { operation },
          timestamp: new Date().toISOString(),
        }),
      );
    }
  };
  return {
    loadForActor: (ownerUserId) => (botId, query, threadId) => {
      // Apps connected since this Bot's last turn become its memory sources. Never waits.
      options.defaults.botTurn(ownerUserId, botId);
      return options.ingestion.contextFor(ownerUserId, botId, query, threadId);
    },
    async sweep() {
      await attempt("syncDue", () => options.ingestion.syncDue());
    },
  };
}
