import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "./auth/guards";
import type { AvatarSourceForPrompt, LoadAvatarSources } from "./copilot";
import type { Database } from "./db/client";
import {
  agentProfiles,
  avatarSources,
  knowledgeBindings,
  knowledgeNotebooks,
  mcpServers,
  pluginGrants,
  registeredDevices,
} from "./db/schema";
import { reportedRoots } from "./devices/store";
import { KnowledgeNotFoundError, type KnowledgeStore } from "./knowledge/store";
import type { PluginStore } from "./plugins/store";
import { runAsTenant } from "./tenant/context";
import { avatarAgentId } from "./tenant/provisioning";

/**
 * The information sources a person gives their 分身 (story F1, stages 1 to 3).
 *
 * WHAT A SOURCE IS. A declaration (S1): a short name and a note in the person's own words, such as
 * "周报" and "在飞书 / 工作 / 周报，每周五更新". It is put in the 分身's prompt on every run
 * (`avatarSourcesGuidance` in copilot.ts) and grants access to nothing. Or a local folder (S2, stage
 * 2): one of the read-only folders the person's own paired machine reports, named by the machine's
 * device id and the opaque `root_ref` its runner made. The server never sees the folder's path; the
 * row holds the reference, and the 分身 reads through the machine's runner, through the gateway and
 * its approval gate, file by file.
 *
 * Stage 3 adds two kinds that grant access through what already grants it, and through nothing new:
 *
 * - A notebook (S3): one of the person's OWN knowledge notebooks (RES1). The save writes the RES1
 *   binding of that notebook to the 分身 (read only), so the 分身 searches it with the knowledge tools,
 *   which reach exactly the notebooks bound to it and check the binding on every call. Removing the
 *   source removes the binding first, so the next call is refused. No second copy of the text exists.
 * - A connector (S4): one of the deployment's connectors (ADR-0002 rows) the person has connected
 *   THEIR OWN account to, and which an administrator has listed for people to install themselves
 *   (spec §3: 平台目录里要先上架). The save writes the plugin grants of that connector's read tools to
 *   the 分身, as the person could on the assembly page, so every call goes through the plugin store,
 *   the SEC1 rules and the approval gate, in the person's own account. Removing the source takes back
 *   the grants the person wrote. The package-level `knowledgeSources` is never read here.
 *
 * A notebook or connector source is shown, counted and told to the 分身 only while what it granted
 * still stands: a notebook deleted or unbound on the knowledge screen, or a connector whose grants
 * were all taken off on the assembly page, stops being a source, so the list never names access the
 * 分身 does not have.
 *
 * WHOSE. One person's own 分身 only, `avatar-<their id>`. Every read and write here is keyed by the
 * person the session names and never by anything in a path or a body, and runs in that person's
 * frame, so the database's row security and its `avatar_sources_own_avatar` check say the same thing
 * as this code does. There is no route to read or write somebody else's: these sentences go into a
 * prompt that speaks for that person, and another person's notebook or connection is simply not
 * found from inside this person's frame.
 */

/** At most this many sources per 分身 (spec D7), of every kind together. Each one is carried on every run. */
export const AVATAR_SOURCE_LIMIT = 10;
/** Characters, counted as the database counts them (code points). */
export const AVATAR_SOURCE_LABEL_LIMIT = 60;
export const AVATAR_SOURCE_NOTE_LIMIT = 500;

export type AvatarSourceKind =
  | "declaration"
  | "local_folder"
  | "notebook"
  | "connector";

export type AvatarSource =
  | {
      id: string;
      kind: "declaration";
      label: string;
      note: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: "local_folder";
      label: string;
      note: string;
      /** The machine's own id (`registered_devices.device_id`), as the device list shows it. */
      deviceId: string;
      /** The runner's opaque reference for the folder. Never a path. */
      rootRef: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: "notebook";
      label: string;
      note: string;
      notebookId: string;
      /** The notebook's title as it is now, which may have changed since it was attached. */
      title: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: "connector";
      label: string;
      note: string;
      /** The connector's row (`mcp_servers.id`). */
      serverId: string;
      title: string;
      createdAt: string;
    };

/** What a save asks for, checked. An empty label on any kind but a declaration means "its own name". */
export type AvatarSourceInput =
  | { kind: "declaration"; label: string; note: string }
  | {
      kind: "local_folder";
      label: string;
      note: string;
      deviceId: string;
      rootRef: string;
    }
  | { kind: "notebook"; label: string; note: string; notebookId: string }
  | { kind: "connector"; label: string; note: string; serverId: string };

/** The runner's reference shape, as `devices/store.ts` keeps it. */
const ROOT_REF = /^fld_[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AvatarSourceState = {
  /** The 分身 these belong to, so a screen can find it on the roster without rebuilding its id. */
  agentId: string;
  /** When the person first saved a source; null is 待配置 (spec D2). */
  configuredAt: string | null;
  /** Active sources, oldest first. */
  sources: AvatarSource[];
};

/**
 * One connector the person has connected their own account to, and whether it can be attached.
 *
 * `reason` is the sentence that says why not, for the picker to show beside it; null when it can be.
 */
export type AvatarConnectorOption = {
  serverId: string;
  title: string;
  attached: boolean;
  attachable: boolean;
  reason: string | null;
};

/** A refusal a person can read and act on. The route answers each with its status and message. */
export class AvatarSourceRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "AvatarSourceRefusal";
  }
}

const characters = (value: string) => [...value].length;
/** The first characters (code points) of a name, so a notebook's long title can stand as a label. */
const clipped = (value: string) =>
  [...value.trim()].slice(0, AVATAR_SOURCE_LABEL_LIMIT).join("");

const STAGE_ONE_KINDS: ReadonlySet<AvatarSourceKind> = new Set([
  "declaration",
  "local_folder",
]);

/** The sentence for a kind this store was not built to take. */
function unsupportedKinds(kinds: ReadonlySet<AvatarSourceKind>): string {
  return kinds.has("notebook") || kinds.has("connector")
    ? "目前只支持文字声明、本地文件夹、知识库和连接器这几种信息来源。"
    : "目前只支持文字声明和本地文件夹这两种信息来源。";
}

/**
 * A source as the person sent it, checked and trimmed, or the sentence that says why not.
 *
 * Checked here and in the database (`avatar_sources_label_length`, `avatar_sources_note_length`):
 * here to answer with a sentence, there so that no other writer can store past the limits.
 *
 * A local folder's, a notebook's and a connector's name may be left empty, and then the save uses
 * the name the machine, the notebook or the connector has; whether the thing named is this person's
 * own is the store's question, asked inside the save, not this function's.
 *
 * `kinds` is what the store this route serves was built with ({@link AvatarSourceStore.kinds}): a
 * store without the knowledge base or the plugin store refuses those kinds as it always did.
 */
export function parseSource(
  body: unknown,
  kinds: ReadonlySet<AvatarSourceKind> = STAGE_ONE_KINDS,
): AvatarSourceInput {
  const input = (typeof body === "object" && body !== null ? body : {}) as {
    kind?: unknown;
    label?: unknown;
    note?: unknown;
    deviceId?: unknown;
    rootRef?: unknown;
    notebookId?: unknown;
    serverId?: unknown;
  };
  const kind = input.kind ?? "declaration";
  if (typeof kind !== "string" || !kinds.has(kind as AvatarSourceKind)) {
    throw new AvatarSourceRefusal(unsupportedKinds(kinds), 400);
  }
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const text = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";
  if (kind === "local_folder") {
    const deviceId = text(input.deviceId);
    const rootRef = text(input.rootRef);
    if (!deviceId || !ROOT_REF.test(rootRef)) {
      throw new AvatarSourceRefusal("请选择一台设备上的本地文件夹。", 400);
    }
    return {
      kind,
      label: checkedLabel(label, true),
      note: checkedNote(input.note),
      deviceId,
      rootRef,
    };
  }
  if (kind === "notebook") {
    const notebookId = text(input.notebookId);
    if (!UUID.test(notebookId)) {
      throw new AvatarSourceRefusal("请选择一个你自己的知识库。", 400);
    }
    return {
      kind,
      label: checkedLabel(label, true),
      note: checkedNote(input.note),
      notebookId: notebookId.toLowerCase(),
    };
  }
  if (kind === "connector") {
    const serverId = text(input.serverId);
    if (!serverId || serverId.length > 200) {
      throw new AvatarSourceRefusal("请选择一个你已连接的连接器。", 400);
    }
    return {
      kind,
      label: checkedLabel(label, true),
      note: checkedNote(input.note),
      serverId,
    };
  }
  return {
    kind: "declaration",
    label: checkedLabel(label, false),
    note: checkedNote(input.note),
  };
}

function checkedLabel(label: string, mayBeEmpty: boolean): string {
  if (label.length === 0 && !mayBeEmpty) {
    throw new AvatarSourceRefusal("请给这个信息来源起个名字。", 400);
  }
  if (characters(label) > AVATAR_SOURCE_LABEL_LIMIT) {
    throw new AvatarSourceRefusal(
      `名称最多 ${AVATAR_SOURCE_LABEL_LIMIT} 个字。`,
      400,
    );
  }
  return label;
}

function checkedNote(value: unknown): string {
  if (value !== undefined && typeof value !== "string") {
    throw new AvatarSourceRefusal("说明必须是文字。", 400);
  }
  const note = (value ?? "").trim();
  if (characters(note) > AVATAR_SOURCE_NOTE_LIMIT) {
    throw new AvatarSourceRefusal(
      `说明最多 ${AVATAR_SOURCE_NOTE_LIMIT} 个字。`,
      400,
    );
  }
  return note;
}

export type AvatarSourceStore = {
  /** The kinds this store takes: one built without the knowledge base or plugins takes fewer. */
  kinds: ReadonlySet<AvatarSourceKind>;
  state: (personId: string) => Promise<AvatarSourceState>;
  /** Active sources only, oldest first: what a run is told. */
  active: (personId: string) => Promise<AvatarSourceForPrompt[]>;
  /**
   * Save one source. `by` is who the plugin grants and their trail rows name (the session's email,
   * as the assembly page writes grants), so the person sees and can take back what this wrote there
   * too. Defaults to the person's id.
   */
  add: (
    personId: string,
    source: AvatarSourceInput,
    by?: string,
  ) => Promise<AvatarSource>;
  /** False when there is no active source by that id for this person. */
  revoke: (personId: string, sourceId: string, by?: string) => Promise<boolean>;
  /** The connectors the person has connected their own account to, for the picker. */
  connectorOptions: (personId: string) => Promise<AvatarConnectorOption[]>;
  /**
   * The machine a 分身 reads one of its local folders on, or null.
   *
   * Asked by the computer gateway on every file call that names a `root`, so a folder removed a
   * moment ago, or one that was never this 分身's, is not read. Null unless all of these hold: the Bot
   * is a person's own 分身 (`avatar-<person>`), the run is that person's, an active local-folder source
   * of that 分身 names exactly this reference, and the machine it names is still the person's and still
   * reports the folder. Read in the person's own frame.
   */
  folderFor: (
    botId: string,
    actorId: string,
    root: string,
  ) => Promise<{ tenantId: string; deviceId: string } | null>;
};

/** A local folder whose source was removed, so its machine can be asked to forget it (spec §6.5). */
export type RevokedFolder = {
  tenantId: string;
  deviceId: string;
  rootRef: string;
};

/** What a connector source needs of the plugin store: the reads behind the picker, and grants. */
export type AvatarConnectorPlugins = Pick<
  PluginStore,
  | "connectionsFor"
  | "brokeredConnectionsFor"
  | "listServers"
  | "isInstallListed"
  | "grant"
  | "revoke"
  | "grantsWrittenBy"
>;

/** The name a connector's grants are written under, as `plugin_grants.ref` prefixes it. */
const serverKey = sql<string>`coalesce(${mcpServers.catalogueKey}, ${mcpServers.id})`;

/**
 * Whether what a source granted still stands. A declaration and a folder always do (a folder's
 * machine is asked at read time by {@link AvatarSourceStore.folderFor}); a notebook while its RES1
 * binding to the 分身 holds a live notebook; a connector while the 分身 holds a grant on it.
 *
 * The inner `knowledge_notebooks` and `mcp_servers` shadow the outer joins of the same name, so each
 * EXISTS asks about the row it is correlated with.
 */
const stillHeld = sql<boolean>`(
  ${avatarSources.kind} IN ('declaration', 'local_folder')
  OR (${avatarSources.kind} = 'notebook' AND EXISTS (
    SELECT 1 FROM ${knowledgeBindings}
    JOIN ${knowledgeNotebooks}
      ON ${knowledgeNotebooks.id} = ${knowledgeBindings.notebookId}
     AND ${knowledgeNotebooks.deletedAt} IS NULL
    WHERE ${knowledgeBindings.notebookId} = ${avatarSources.notebookId}
      AND ${knowledgeBindings.agentId} = ${avatarSources.agentId}
      AND ${knowledgeBindings.tenantId} = ${avatarSources.tenantId}
      AND ${knowledgeBindings.ownerUserId} = ${avatarSources.tenantId}
  ))
  OR (${avatarSources.kind} = 'connector' AND EXISTS (
    SELECT 1 FROM ${pluginGrants}
    JOIN ${mcpServers} ON ${mcpServers.id} = ${avatarSources.serverId}
    WHERE ${pluginGrants.agentId} = ${avatarSources.agentId}
      AND ${pluginGrants.kind} = 'mcp'
      AND starts_with(${pluginGrants.ref}, ${serverKey} || '/')
  ))
)`;

/** The tool-name prefix a connector's granted tools carry (`toolNameFor` in plugins/store.ts). */
const toolPrefixFor = (key: string) => `mcp__${key}__`;

export function createAvatarSourceStore(
  database: Database,
  options: {
    /** Told after a local folder's source is removed. Best effort: a failure here is not the person's. */
    onFolderRevoked?: (folder: RevokedFolder) => void;
    /** The person's knowledge base (RES1). Without it, a notebook is not a kind this store takes. */
    knowledge?: KnowledgeStore;
    /** The plugin store. Without it, a connector is not a kind this store takes. */
    plugins?: AvatarConnectorPlugins;
  } = {},
): AvatarSourceStore {
  const { knowledge, plugins } = options;
  const kinds = new Set<AvatarSourceKind>(STAGE_ONE_KINDS);
  if (knowledge) kinds.add("notebook");
  if (plugins) kinds.add("connector");

  /** Active sources still held, oldest first, with what their notebook or connector is called now. */
  const activeRows = (agentId: string) =>
    database
      .select({
        id: avatarSources.id,
        kind: avatarSources.kind,
        label: avatarSources.label,
        note: avatarSources.note,
        deviceId: avatarSources.deviceId,
        rootRef: avatarSources.rootRef,
        notebookId: avatarSources.notebookId,
        notebookTitle: knowledgeNotebooks.title,
        serverId: avatarSources.serverId,
        serverTitle: mcpServers.title,
        serverKey: sql<
          string | null
        >`coalesce(${mcpServers.catalogueKey}, ${mcpServers.id})`,
        createdAt: avatarSources.createdAt,
      })
      .from(avatarSources)
      .leftJoin(
        knowledgeNotebooks,
        eq(knowledgeNotebooks.id, avatarSources.notebookId),
      )
      .leftJoin(mcpServers, eq(mcpServers.id, avatarSources.serverId))
      .where(
        and(
          eq(avatarSources.agentId, agentId),
          inArray(avatarSources.kind, [...kinds]),
          isNull(avatarSources.revokedAt),
          stillHeld,
        ),
      )
      // Creation order, with the id as the tie-break two inserts in one instant still need.
      .orderBy(asc(avatarSources.createdAt), asc(avatarSources.id));

  type Row = Awaited<ReturnType<typeof activeRows>>[number];

  const shown = (row: Row): AvatarSource => {
    const base = {
      id: row.id,
      label: row.label,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    };
    if (row.kind === "local_folder" && row.deviceId && row.rootRef) {
      return {
        ...base,
        kind: "local_folder",
        deviceId: row.deviceId,
        rootRef: row.rootRef,
      };
    }
    if (row.kind === "notebook" && row.notebookId) {
      return {
        ...base,
        kind: "notebook",
        notebookId: row.notebookId,
        title: row.notebookTitle ?? row.label,
      };
    }
    if (row.kind === "connector" && row.serverId) {
      return {
        ...base,
        kind: "connector",
        serverId: row.serverId,
        title: row.serverTitle ?? row.label,
      };
    }
    return { ...base, kind: "declaration" };
  };

  const forPrompt = (row: Row): AvatarSourceForPrompt => {
    if (row.kind === "local_folder" && row.rootRef) {
      return { label: row.label, note: row.note, root: row.rootRef };
    }
    if (row.kind === "notebook" && row.notebookId) {
      return {
        label: row.label,
        note: row.note,
        notebook: { id: row.notebookId, title: row.notebookTitle ?? row.label },
      };
    }
    if (row.kind === "connector" && row.serverId) {
      return {
        label: row.label,
        note: row.note,
        connector: {
          title: row.serverTitle ?? row.label,
          tools: toolPrefixFor(row.serverKey ?? row.serverId),
        },
      };
    }
    return { label: row.label, note: row.note };
  };

  /**
   * The connectors this person has connected their own account to, each with the read tools an
   * attachment would grant and, when it cannot be attached, why. Read in the person's own frame, from
   * the person's own connections: another person's connection is in neither list.
   */
  const connectorsOf = async (personId: string) => {
    if (!plugins) return [];
    const [direct, brokered, servers] = await Promise.all([
      plugins.connectionsFor(personId),
      plugins.brokeredConnectionsFor(personId),
      plugins.listServers(),
    ]);
    const connected = [
      ...new Set([...direct, ...brokered].map((row) => row.serverId)),
    ];
    if (connected.length === 0) return [];
    const rows = await database
      .select({ id: mcpServers.id, title: mcpServers.title, key: serverKey })
      .from(mcpServers)
      .where(inArray(mcpServers.id, connected));
    const records = new Map(servers.map((server) => [server.id, server]));
    return Promise.all(
      rows.map(async (row) => {
        const record = records.get(row.id);
        // Only what reads: an information source is something to read from. Writing tools stay on
        // the assembly page, where they are switched on one by one.
        const readTools = (record?.tools ?? [])
          .filter(
            (tool) =>
              tool.effect === "read" && tool.ref.startsWith(`${row.key}/`),
          )
          .map((tool) => tool.ref);
        const listed = await plugins.isInstallListed("mcp", row.key);
        const reason = !listed
          ? "管理员还没有把这个连接器上架给个人使用，暂时不能交给分身。"
          : readTools.length === 0
            ? "这个连接器目前没有可以读取资料的工具。"
            : null;
        return {
          serverId: row.id,
          title: record?.title ?? row.title,
          readTools,
          reason,
        };
      }),
    );
  };

  /** Mark one source removed: a save whose grant failed after its row was written. */
  const retire = (personId: string, id: string) =>
    runAsTenant(personId, () =>
      database
        .update(avatarSources)
        .set({ revokedAt: new Date() })
        .where(and(eq(avatarSources.id, id), isNull(avatarSources.revokedAt))),
    );

  return {
    kinds,

    state: (personId) =>
      runAsTenant(personId, async () => {
        const agentId = avatarAgentId(personId);
        const [profile] = await database
          .select({ configuredAt: agentProfiles.configuredAt })
          .from(agentProfiles)
          .where(eq(agentProfiles.agentId, agentId))
          .limit(1);
        const rows = await activeRows(agentId);
        return {
          agentId,
          configuredAt: profile?.configuredAt?.toISOString() ?? null,
          sources: rows.map(shown),
        };
      }),

    active: (personId) =>
      runAsTenant(personId, async () =>
        (await activeRows(avatarAgentId(personId))).map(forPrompt),
      ),

    connectorOptions: (personId) =>
      runAsTenant(personId, async () => {
        const options = await connectorsOf(personId);
        const attached = new Set(
          (await activeRows(avatarAgentId(personId))).flatMap((row) =>
            row.kind === "connector" && row.serverId ? [row.serverId] : [],
          ),
        );
        return options
          .map((option) => ({
            serverId: option.serverId,
            title: option.title,
            attached: attached.has(option.serverId),
            attachable:
              option.reason === null && !attached.has(option.serverId),
            reason: option.reason,
          }))
          .sort((left, right) => left.title.localeCompare(right.title, "zh"));
      }),

    add: async (personId, source, by = personId) => {
      if (!kinds.has(source.kind)) {
        throw new AvatarSourceRefusal(unsupportedKinds(kinds), 400);
      }
      const agentId = avatarAgentId(personId);
      /*
       * A connector is checked before the transaction: what the person connected, what is listed and
       * which of its tools only read are the plugin store's reads, each on its own connection. All of
       * them in the person's own frame.
       */
      const connector =
        source.kind === "connector"
          ? await runAsTenant(personId, async () => {
              const found = (await connectorsOf(personId)).find(
                (option) => option.serverId === source.serverId,
              );
              if (!found) {
                throw new AvatarSourceRefusal(
                  "找不到这个连接器，或者你还没有用自己的账号连接它。请先在「设置 › 已连接的账号」里连接。",
                  404,
                );
              }
              if (found.reason) {
                throw new AvatarSourceRefusal(found.reason, 400);
              }
              return found;
            })
          : null;

      const saved = await runAsTenant(personId, () =>
        database.transaction(async (transaction) => {
          /*
           * The profile row first, for two reasons. It stamps `configured_at` the first time, and
           * the UPDATE holds that row's lock until commit, so two saves at once are counted one
           * after the other and cannot both land as the tenth. No row means no 分身 to configure:
           * a deleted one, or a person provisioning never reached.
           */
          const [profile] = await transaction
            .update(agentProfiles)
            .set({
              configuredAt: sql`coalesce(${agentProfiles.configuredAt}, now())`,
            })
            .where(
              and(
                eq(agentProfiles.agentId, agentId),
                isNull(agentProfiles.deletedAt),
              ),
            )
            .returning({ agentId: agentProfiles.agentId });
          if (!profile) {
            throw new AvatarSourceRefusal("找不到你的分身。", 404);
          }
          /*
           * A notebook or connector source whose access was taken back somewhere else (the notebook
           * deleted or unbound, every grant taken off) is no longer one: it is closed here, so it is
           * not counted against the limit and the same thing can be attached again.
           */
          await transaction
            .update(avatarSources)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(avatarSources.agentId, agentId),
                isNull(avatarSources.revokedAt),
                sql`NOT ${stillHeld}`,
              ),
            );
          const [held] = await transaction
            .select({ value: count() })
            .from(avatarSources)
            .where(
              and(
                eq(avatarSources.agentId, agentId),
                isNull(avatarSources.revokedAt),
              ),
            );
          if ((held?.value ?? 0) >= AVATAR_SOURCE_LIMIT) {
            throw new AvatarSourceRefusal(
              `每个分身最多登记 ${AVATAR_SOURCE_LIMIT} 个信息来源。请先删掉不再需要的。`,
              409,
            );
          }
          let values: {
            kind: AvatarSourceKind;
            label: string;
            note: string;
            deviceId?: string;
            rootRef?: string;
            notebookId?: string;
            serverId?: string;
          };
          if (source.kind === "local_folder") {
            /*
             * The folder has to be one the person's OWN machine reports right now. Read in the
             * person's frame and filtered by their id as well, so another person's device id or
             * reference finds nothing here whatever was sent: row security and this filter say the
             * same thing. The reference is all that is stored; the path never reached this server.
             */
            const [device] = await transaction
              .select({ roots: registeredDevices.roots })
              .from(registeredDevices)
              .where(
                and(
                  eq(registeredDevices.tenantId, personId),
                  eq(registeredDevices.deviceId, source.deviceId),
                ),
              )
              .limit(1);
            const root = (reportedRoots(device?.roots) ?? []).find(
              (entry) => entry.ref === source.rootRef,
            );
            if (!root) {
              throw new AvatarSourceRefusal(
                "你的设备上没有这个本地文件夹。请先在设备端添加它，并确认设备已连接。",
                400,
              );
            }
            const [already] = await transaction
              .select({ id: avatarSources.id })
              .from(avatarSources)
              .where(
                and(
                  eq(avatarSources.agentId, agentId),
                  eq(avatarSources.kind, "local_folder"),
                  eq(avatarSources.rootRef, source.rootRef),
                  isNull(avatarSources.revokedAt),
                ),
              )
              .limit(1);
            if (already) {
              throw new AvatarSourceRefusal(
                "这个本地文件夹已经登记过了。",
                409,
              );
            }
            values = {
              kind: "local_folder",
              label: source.label || root.name,
              note: source.note,
              deviceId: source.deviceId,
              rootRef: source.rootRef,
            };
          } else if (source.kind === "notebook") {
            /*
             * The notebook has to be the person's OWN and live, read in their frame and filtered by
             * their id as owner and tenant, as RES1 reads it. Another person's notebook id finds
             * nothing here, and the answer is the same as for no notebook at all.
             */
            const [notebook] = await transaction
              .select({ title: knowledgeNotebooks.title })
              .from(knowledgeNotebooks)
              .where(
                and(
                  eq(knowledgeNotebooks.id, source.notebookId),
                  eq(knowledgeNotebooks.tenantId, personId),
                  eq(knowledgeNotebooks.ownerUserId, personId),
                  isNull(knowledgeNotebooks.deletedAt),
                ),
              )
              .limit(1);
            if (!notebook) {
              throw new AvatarSourceRefusal("找不到你的这个知识库。", 404);
            }
            const [already] = await transaction
              .select({ id: avatarSources.id })
              .from(avatarSources)
              .where(
                and(
                  eq(avatarSources.agentId, agentId),
                  eq(avatarSources.notebookId, source.notebookId),
                  isNull(avatarSources.revokedAt),
                ),
              )
              .limit(1);
            if (already) {
              throw new AvatarSourceRefusal("这个知识库已经添加过了。", 409);
            }
            values = {
              kind: "notebook",
              label: source.label || clipped(notebook.title),
              note: source.note,
              notebookId: source.notebookId,
            };
          } else if (source.kind === "connector" && connector) {
            const [already] = await transaction
              .select({ id: avatarSources.id })
              .from(avatarSources)
              .where(
                and(
                  eq(avatarSources.agentId, agentId),
                  eq(avatarSources.serverId, connector.serverId),
                  isNull(avatarSources.revokedAt),
                ),
              )
              .limit(1);
            if (already) {
              throw new AvatarSourceRefusal("这个连接器已经添加过了。", 409);
            }
            values = {
              kind: "connector",
              label: source.label || clipped(connector.title),
              note: source.note,
              serverId: connector.serverId,
            };
          } else {
            values = {
              kind: "declaration",
              label: source.label,
              note: source.note,
            };
          }
          const [row] = await transaction
            .insert(avatarSources)
            .values({ tenantId: personId, agentId, ...values })
            .returning({ id: avatarSources.id });
          if (!row) throw new Error("avatar source insert returned no row");
          return row.id;
        }),
      );

      /*
       * Then the access, through the store that owns it, which asks again whether the notebook and
       * the 分身 are the person's own and writes its own trail row. After the row commits, so a
       * refused save (the limit, a duplicate) never touches a binding or a grant that was already
       * there. If granting fails, the row is closed and what was granted is taken back, so the list
       * never names access the 分身 does not have.
       */
      try {
        if (source.kind === "notebook" && knowledge) {
          await runAsTenant(personId, () =>
            knowledge.bind(personId, source.notebookId, agentId, {
              accessMode: "read_only",
            }),
          );
        } else if (connector && plugins) {
          const granted: string[] = [];
          try {
            for (const ref of connector.readTools) {
              await runAsTenant(personId, () =>
                plugins.grant("mcp", ref, agentId, by, { selfService: true }),
              );
              granted.push(ref);
            }
          } catch (error) {
            for (const ref of granted) {
              await runAsTenant(personId, () =>
                plugins.revoke("mcp", ref, agentId, by, { selfService: true }),
              ).catch(() => undefined);
            }
            throw error;
          }
        }
      } catch (error) {
        await retire(personId, saved);
        throw error;
      }

      const [row] = await runAsTenant(personId, async () =>
        (await activeRows(agentId)).filter((entry) => entry.id === saved),
      );
      if (!row) throw new Error("avatar source was saved but is not held");
      return shown(row);
    },

    revoke: async (personId, sourceId, by = personId) => {
      // Not a uuid is not a row, and must not reach the database as a cast error.
      if (!UUID.test(sourceId)) return false;
      const agentId = avatarAgentId(personId);
      const [row] = await runAsTenant(personId, () =>
        database
          .select({
            kind: avatarSources.kind,
            deviceId: avatarSources.deviceId,
            rootRef: avatarSources.rootRef,
            notebookId: avatarSources.notebookId,
            serverKey: sql<
              string | null
            >`coalesce(${mcpServers.catalogueKey}, ${mcpServers.id})`,
          })
          .from(avatarSources)
          .leftJoin(mcpServers, eq(mcpServers.id, avatarSources.serverId))
          .where(
            and(
              eq(avatarSources.id, sourceId),
              eq(avatarSources.agentId, agentId),
              isNull(avatarSources.revokedAt),
            ),
          )
          .limit(1),
      );
      if (!row) return false;

      /*
       * The access goes first and the row after, so there is no moment in which the list says a
       * source is gone while the 分身 can still read through it. The knowledge tools and every plugin
       * call check the binding and the grant again on each call, so a run already in flight loses
       * access at its next call.
       */
      const { notebookId, serverKey: key } = row;
      if (row.kind === "notebook" && notebookId && knowledge) {
        try {
          await runAsTenant(personId, () =>
            knowledge.unbind(personId, notebookId, agentId),
          );
        } catch (error) {
          // A notebook deleted since: its bindings went with it, so there is nothing to take back.
          if (!(error instanceof KnowledgeNotFoundError)) throw error;
        }
      }
      if (row.kind === "connector" && key && plugins) {
        // The grants of this connector the person wrote; what an administrator granted stays theirs.
        const refs = (
          await runAsTenant(personId, () =>
            plugins.grantsWrittenBy(agentId, by),
          )
        )
          .filter(
            (grant) => grant.kind === "mcp" && grant.ref.startsWith(`${key}/`),
          )
          .map((grant) => grant.ref);
        for (const ref of refs) {
          await runAsTenant(personId, () =>
            plugins.revoke("mcp", ref, agentId, by, { selfService: true }),
          );
        }
      }

      const revoked = await runAsTenant(personId, () =>
        database
          .update(avatarSources)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(avatarSources.id, sourceId),
              eq(avatarSources.agentId, agentId),
              isNull(avatarSources.revokedAt),
            ),
          )
          .returning({ id: avatarSources.id }),
      );
      if (row.kind === "local_folder" && row.deviceId && row.rootRef) {
        try {
          options.onFolderRevoked?.({
            tenantId: personId,
            deviceId: row.deviceId,
            rootRef: row.rootRef,
          });
        } catch {
          // The source is removed either way; the next run neither sees nor reads the folder.
        }
      }
      return revoked.length === 1;
    },

    folderFor: async (botId, actorId, root) => {
      const personId = botId.startsWith("avatar-") ? botId.slice(7) : "";
      if (
        !personId ||
        botId !== avatarAgentId(personId) ||
        actorId !== personId ||
        !ROOT_REF.test(root)
      ) {
        return null;
      }
      return runAsTenant(personId, async () => {
        const [source] = await database
          .select({ deviceId: avatarSources.deviceId })
          .from(avatarSources)
          .where(
            and(
              eq(avatarSources.tenantId, personId),
              eq(avatarSources.agentId, botId),
              eq(avatarSources.kind, "local_folder"),
              eq(avatarSources.rootRef, root),
              isNull(avatarSources.revokedAt),
            ),
          )
          .limit(1);
        if (!source?.deviceId) return null;
        const [device] = await database
          .select({ roots: registeredDevices.roots })
          .from(registeredDevices)
          .where(
            and(
              eq(registeredDevices.tenantId, personId),
              eq(registeredDevices.deviceId, source.deviceId),
            ),
          )
          .limit(1);
        const offered = (reportedRoots(device?.roots) ?? []).some(
          (entry) => entry.ref === root,
        );
        return offered
          ? { tenantId: personId, deviceId: source.deviceId }
          : null;
      });
    },
  };
}

/**
 * What a run of one person's Bots is told about their 分身's sources: the list for their own
 * 分身, and nothing, without a read, for any other Bot (see `LoadAvatarSources` in copilot.ts).
 */
export function avatarSourcesForActor(
  store: AvatarSourceStore,
): (actorId: string) => LoadAvatarSources {
  return (actorId) => async (agentId) =>
    agentId === avatarAgentId(actorId) ? store.active(actorId) : [];
}

/** Who a grant and its trail row name: the session's email, as the assembly page writes them. */
const writerOf = (actor: AuthenticatedActor) => actor.email || actor.id;

/**
 * `GET/POST/DELETE /api/me/avatar/sources`: the signed-in person's own 分身's sources, and
 * `GET /api/me/avatar/sources/connectors`: the connectors they may attach.
 *
 * `requireUser` opens the person's frame; the store opens it again on the same person, so a caller
 * outside a request reads and writes exactly as a request does.
 */
export function createAvatarSourceRoutes(
  store: AvatarSourceStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) =>
    context.json(await store.state(context.var.actor.id)),
  );

  routes.get("/connectors", requireUser, async (context) =>
    context.json({
      connectors: await store.connectorOptions(context.var.actor.id),
    }),
  );

  routes.post("/", requireUser, async (context) => {
    const body = await context.req.json().catch(() => undefined);
    try {
      const source = await store.add(
        context.var.actor.id,
        parseSource(body, store.kinds),
        writerOf(context.var.actor),
      );
      return context.json({ source }, 201);
    } catch (error) {
      if (error instanceof AvatarSourceRefusal) {
        return context.json({ error: error.message }, error.status);
      }
      throw error;
    }
  });

  routes.delete("/:sourceId", requireUser, async (context) => {
    const removed = await store.revoke(
      context.var.actor.id,
      context.req.param("sourceId"),
      writerOf(context.var.actor),
    );
    return removed
      ? context.json({ removed: true })
      : context.json({ error: "找不到这个信息来源。" }, 404);
  });

  return routes;
}
