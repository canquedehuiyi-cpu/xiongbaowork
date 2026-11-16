/**
 * What a check-in may read: the person's own connections, and in them only what says it only reads.
 *
 * WHOSE APPS. "Anything a person has connected, whether it's MCP or API or whatever. If the admin
 * connected it but they haven't connected their credentials, it's irrelevant." So a check-in reads a
 * server only where a call to it goes out on this person's own credential, and only once they have
 * connected it. Both facts are the plugin layer's, read here and never re-derived:
 * - whose credential a server runs on is `ownCredential`, which every kind of server answers where
 *   it is resolved (`plugins/access.ts`), so a kind added later falls under this rule without this
 *   module knowing its name;
 * - whether this person connected it is `ownConnections`, one answer across every table a person's
 *   own connection is kept in.
 * An admin's key used for everybody (a server added by URL, web search with the deployment's key),
 * a Shared app's team account, a public endpoint and OpenBot's own built-in tools are not the
 * person's, so a check-in never reads them.
 *
 * WHAT IN THEM. Only a tool that says it only reads (`labelledRead`, see `plugins/catalogue.ts`).
 * A check-in is never offered anything else: it is never a person's turn, so there is nobody to ask,
 * and what it would need done it raises as an item for the person instead.
 *
 * AND WHOSE ACCOUNT THE CALL LANDS IN. A Team Bot someone else published can reach its publisher's
 * account, or the person's own only with their standing consent. A check-in reads neither the
 * publisher's account nor one the person has not consented to, so those tools are left out too.
 */

import { PROACTIVE_OWN_READS } from "./restriction";

/** A server as the catalogue lists it, as much of it as the scope reads. */
export type ScopeServer = {
  id: string;
  title: string;
  ownCredential: boolean;
  tools: { ref: string; labelledRead: boolean }[];
};

export type CheckInScopeDeps = {
  catalogue: { listServers(): Promise<ScopeServer[]> };
  /** The servers this person connected with their own account. */
  ownConnections(userId: string): Promise<ReadonlySet<string>>;
  /**
   * For a Team Bot another person published: which of its tools land in this person's own account
   * without asking them. Null for any other Bot.
   */
  unaskedOwnAccount?(
    ownerUserId: string,
    agentId: string,
  ): Promise<((ref: string) => Promise<boolean>) | null>;
};

/** The connector reads a check-in may call, by ref, with the title of the app each belongs to. */
export type CheckInReads = ReadonlyMap<string, string>;

/**
 * What a check-in for this person and this Bot may read, asked afresh each time: at load, before
 * each call, and by the gate, so a connection withdrawn or a label changed a moment ago applies on
 * the next question.
 */
export type CheckInScope = (
  ownerUserId: string,
  agentId: string,
) => Promise<CheckInReads>;

/**
 * The plugin store's catalogue as the scope reads it, until the plugins session brings upstream's
 * `ownCredential` and reviewed read lists: every server counts as the person's own once they hold a
 * connection to it (`ownConnections` decides that), and a tool reads where it is recorded as a read
 * and not destructive. An action the broker said nothing about is recorded as a write (0146), so it
 * is not a read either. The same rule the plugin store holds a check-in's call to (`callTool`).
 */
export function checkInCatalogue(store: {
  listServers(): Promise<
    {
      id: string;
      title: string;
      tools: {
        ref: string;
        effect: "read" | "write";
        destructive: boolean;
        /**
         * 这个「读」有人作证：厂商列出时记录为读，或目录 `readTools` 审查过（plugins/catalogue.ts 的
         * `checkInRead`）。聊天里 `classifyTool` 推断出来的读不算，check-in 不读它。
         */
        checkInRead: boolean;
      }[];
    }[]
  >;
}): CheckInScopeDeps["catalogue"] {
  return {
    listServers: async () =>
      (await store.listServers()).map((server) => ({
        id: server.id,
        title: server.title,
        ownCredential: true,
        tools: server.tools.map((tool) => ({
          ref: tool.ref,
          labelledRead:
            tool.effect === "read" && !tool.destructive && tool.checkInRead,
        })),
      })),
  };
}

export function createCheckInScope(deps: CheckInScopeDeps): CheckInScope {
  return async (ownerUserId, agentId) => {
    const [servers, connected, landsInOwn] = await Promise.all([
      deps.catalogue.listServers(),
      deps.ownConnections(ownerUserId),
      deps.unaskedOwnAccount?.(ownerUserId, agentId) ?? null,
    ]);
    const reads = new Map<string, string>();
    for (const server of servers) {
      if (!server.ownCredential || !connected.has(server.id)) continue;
      for (const tool of server.tools) {
        if (!tool.labelledRead) continue;
        if (landsInOwn && !(await landsInOwn(tool.ref))) continue;
        reads.set(tool.ref, server.title);
      }
    }
    return reads;
  };
}

/** One app a check-in can read, by the title the person knows it by. */
export type CheckInApp = { title: string; refs: string[] };

/**
 * The apps among a Bot's tools that a check-in can read, in the order the Bot holds them: what the
 * gate counts and what the instruction names.
 */
export function appsOf(
  tools: readonly { ref: string }[],
  reads: CheckInReads,
): CheckInApp[] {
  const apps = new Map<string, string[]>();
  for (const tool of tools) {
    const title = reads.get(tool.ref);
    if (title === undefined) continue;
    apps.set(title, [...(apps.get(title) ?? []), tool.ref]);
  }
  return [...apps].map(([title, refs]) => ({ title, refs }));
}

/**
 * The engine's two questions about one Bot's tools for one person, answered from the scope: which
 * apps a check-in can read (the gate, and what the instruction names), and which of the Bot's tools
 * are answered with a refusal if the model calls one anyway. One function, so the server and its
 * tests ask both the same way.
 */
export function checkInToolsFor(
  load: (
    ownerUserId: string,
  ) => (agentId: string) => Promise<readonly { ref: string; name: string }[]>,
  scope: CheckInScope,
) {
  const read = (ownerUserId: string, agentId: string) =>
    Promise.all([load(ownerUserId)(agentId), scope(ownerUserId, agentId)]);
  return {
    async readableApps(ownerUserId: string, agentId: string) {
      const [tools, reads] = await read(ownerUserId, agentId);
      return appsOf(tools, reads);
    },
    async deniedToolNames(ownerUserId: string, agentId: string) {
      const [tools, reads] = await read(ownerUserId, agentId);
      return tools
        .filter(
          (tool) => !reads.has(tool.ref) && !PROACTIVE_OWN_READS.has(tool.name),
        )
        .map((tool) => tool.name);
    },
  };
}
