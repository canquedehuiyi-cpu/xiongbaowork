/**
 * The read-only boundary a proactive run is held to, enforced where tools are dispatched.
 *
 * A proactive run is a Bot looking through a person's apps while nobody is watching. It may read:
 * connected-app actions its catalogue marks `read` and not destructive, and the person's own memory.
 * 而且这个「读」必须有人作证：厂商列出时记录为读，或目录 `readTools` 审查过（见 plugins/catalogue.ts
 * 的 `checkInRead`）。聊天里 `classifyTool` 对没有标签的工具推断出的读，在这里不算。
 * It may not write to an app, send a message, hand work to another Bot or person, or drive a browser
 * or the computer. That is decided here, by the deployment, and never by telling the model.
 *
 * WHY THE INITIATOR. Every door a tool call arrives through already carries the run's initiator: the
 * in-process loader is built with it, and a remote Bot's callback carries it inside the run assertion
 * this deployment signed, which the Bot cannot edit. So one predicate over it covers the built-in,
 * remote AG-UI and remote framework doors alike, and a child run cannot inherit an escape because a
 * proactive run is given no way to start one.
 *
 * FAIL CLOSED. Anything not positively classified as a read is refused: an unknown ref, a catalogue
 * that could not be read, a tool with no recorded effect.
 */
import type { AuditInitiator } from "../audit";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import { isProactiveInitiator } from "./initiator";

// In `./initiator` so the plugin store can ask the same question without importing this module.
export {
  isProactiveInitiator,
  PROACTIVE_INITIATOR_PREFIX,
  proactiveInitiator,
  proactiveRunIdOf,
} from "./initiator";

/**
 * Memory tools a proactive run may call by name. Writing memory goes through the proactive tool.
 *
 * BY NAME AND NEVER BY REF. A connector tool's name is always `mcp__<server>__<tool>` and its ref
 * `<server>/<tool>`, so no connector can carry one of these names. The ref
 * `memory/recall_personal_memory` used to be on this list too, and a server sitting at the id
 * `memory` with a tool of that name would have passed as the person's own memory. That id is
 * reserved now as well (`addCustomServer` in `plugins/store.ts`).
 */
export const PROACTIVE_MEMORY_READS: ReadonlySet<string> = new Set([
  "recall_personal_memory",
]);

type CatalogueReader = {
  listServers(): Promise<
    {
      id: string;
      title: string;
      tools: {
        ref: string;
        effect: string;
        destructive: boolean;
        /**
         * check-in 能否依赖它是读，插件 store 对每个工具都给出（`ToolRecord.checkInRead`）。为 false
         * 时，即使 `effect` 是 read（聊天里推断出来的读）也不算。类型上必填，src 里的读者都得给。
         */
        checkInRead: boolean;
      }[];
    }[]
  >;
};

/** Which refs are reads right now, read from the catalogue per question so a relabel applies at once. */
export function createReadOnlyClassifier(plugins: CatalogueReader) {
  return async (): Promise<ReadonlySet<string>> => {
    const servers = await plugins.listServers();
    const refs = new Set<string>(PROACTIVE_MEMORY_READS);
    for (const server of servers)
      for (const tool of server.tools)
        if (
          tool.effect === "read" &&
          tool.destructive !== true &&
          tool.checkInRead !== false
        )
          refs.add(tool.ref);
    return refs;
  };
}
export type ReadOnlyRefs = () => Promise<ReadonlySet<string>>;

function refused(name: string) {
  return `${REFUSAL_MARKER} ${name} is not available during background research, which can only read. Suggest it as a next step instead.`;
}

/**
 * The loader a run's granted tools come from, narrowed for a proactive run.
 *
 * Unchanged for every other initiator. For a proactive one, only reads are offered, and each is
 * checked again when it executes, so a grant relabelled mid-run is refused on its next call.
 */
export function restrictToolsForRun<A extends unknown[]>(
  initiator: AuditInitiator | undefined,
  load: (...args: A) => Promise<GrantedTool[]>,
  readOnlyRefs: ReadOnlyRefs,
): (...args: A) => Promise<GrantedTool[]> {
  if (!isProactiveInitiator(initiator)) return load;
  return async (...args: A) => {
    const [tools, allowed] = await Promise.all([load(...args), readOnlyRefs()]);
    return tools
      .filter((tool) => allowed.has(tool.ref) || allowed.has(tool.name))
      .map((tool) => ({
        ...tool,
        execute: async (input: unknown) => {
          const current = await readOnlyRefs();
          if (!current.has(tool.ref) && !current.has(tool.name))
            return refused(tool.name);
          return tool.execute(input);
        },
      }));
  };
}

/**
 * 后台调研的运行没有电脑（见 index.ts 里它的 `toolsForTurn`：只有它自己的两个工具），所以也不告诉它
 * 有浏览器：电脑说明和随之而来的网页搜索引导一并不给。其他运行照旧。
 */
export function computerGuidanceForRun(
  initiator: AuditInitiator | undefined,
  guidance: string | undefined,
): string | undefined {
  return isProactiveInitiator(initiator) ? undefined : guidance;
}

/** Handing work to a Bot or asking a person is a message; a proactive run is given neither. */
export function restrictCoordinationForRun<A extends unknown[], R>(
  initiator: AuditInitiator | undefined,
  coordination: (...args: A) => Promise<R[]>,
): (...args: A) => Promise<R[]> {
  if (!isProactiveInitiator(initiator)) return coordination;
  return async () => [];
}

/**
 * The remote Bot's callback door. Returns a refusal to answer with, or null to carry on.
 *
 * Called before anything else in the callback dispatch, so coordination, memory writes, host tools
 * and connector writes are all refused for a proactive run in one place.
 */
export async function guardProactiveCallback(
  input: {
    name: string;
    initiator?: AuditInitiator | null;
    run?: { initiator?: AuditInitiator | null } | null;
  },
  readOnlyRefs: ReadOnlyRefs,
): Promise<{ text: string; isError: true } | null> {
  const initiator = input.initiator ?? input.run?.initiator ?? undefined;
  if (!isProactiveInitiator(initiator)) return null;
  let allowed: ReadonlySet<string>;
  try {
    allowed = await readOnlyRefs();
  } catch {
    return { text: refused(input.name), isError: true };
  }
  return allowed.has(input.name)
    ? null
    : { text: refused(input.name), isError: true };
}

/**
 * Hidden refusals for the tools a proactive run was not given, so a call the model makes anyway is
 * answered with a governed refusal rather than left dangling. Never offered; never executed as the
 * real tool.
 */
export function refusalsFor(names: readonly string[]) {
  return names.map((name) => ({
    hidden: true as const,
    definition: {
      name,
      description: "Not available during background research.",
      parameters: { type: "object", properties: {} },
    },
    execute: async () => refused(name),
  }));
}
