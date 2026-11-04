import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "./auth/guards";
import type { AvatarSourceForPrompt, LoadAvatarSources } from "./copilot";
import type { Database } from "./db/client";
import { agentProfiles, avatarSources, registeredDevices } from "./db/schema";
import { reportedRoots } from "./devices/store";
import { runAsTenant } from "./tenant/context";
import { avatarAgentId } from "./tenant/provisioning";

/**
 * The information sources a person declares for their 分身 (story F1, stage 1).
 *
 * WHAT A SOURCE IS. A declaration (S1): a short name and a note in the person's own words, such as
 * "周报" and "在飞书 / 工作 / 周报，每周五更新". It is put in the 分身's prompt on every run
 * (`avatarSourcesGuidance` in copilot.ts) and grants access to nothing. Or a local folder (S2, stage
 * 2): one of the read-only folders the person's own paired machine reports, named by the machine's
 * device id and the opaque `root_ref` its runner made. The server never sees the folder's path; the
 * row holds the reference, and the 分身 reads through the machine's runner, through the gateway and
 * its approval gate, file by file. A notebook and a connector are later stages; the table has room
 * for them and this module refuses them until they exist.
 *
 * WHOSE. One person's own 分身 only, `avatar-<their id>`. Every read and write here is keyed by the
 * person the session names and never by anything in a path or a body, and runs in that person's
 * frame, so the database's row security and its `avatar_sources_own_avatar` check say the same thing
 * as this code does. There is no route to read or write somebody else's: these sentences go into a
 * prompt that speaks for that person.
 */

/** At most this many sources per 分身 (spec D7). Each one is carried on every run. */
export const AVATAR_SOURCE_LIMIT = 10;
/** Characters, counted as the database counts them (code points). */
export const AVATAR_SOURCE_LABEL_LIMIT = 60;
export const AVATAR_SOURCE_NOTE_LIMIT = 500;

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
    };

/** What a save asks for, checked: a declaration, or a folder on one of the person's machines. */
export type AvatarSourceInput =
  | { kind: "declaration"; label: string; note: string }
  | {
      kind: "local_folder";
      /** Empty means "the name the machine reports for the folder". */
      label: string;
      note: string;
      deviceId: string;
      rootRef: string;
    };

/** The runner's reference shape, as `devices/store.ts` keeps it. */
const ROOT_REF = /^fld_[A-Za-z0-9_-]{22}$/;

export type AvatarSourceState = {
  /** The 分身 these belong to, so a screen can find it on the roster without rebuilding its id. */
  agentId: string;
  /** When the person first saved a source; null is 待配置 (spec D2). */
  configuredAt: string | null;
  /** Active sources, oldest first. */
  sources: AvatarSource[];
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

/**
 * A source as the person sent it, checked and trimmed, or the sentence that says why not.
 *
 * Checked here and in the database (`avatar_sources_label_length`, `avatar_sources_note_length`):
 * here to answer with a sentence, there so that no other writer can store past the limits.
 *
 * A local folder's name may be left empty, and then the save uses the name the machine reports;
 * whether the machine and the folder are this person's own is the store's question, asked inside
 * the save's transaction, not this function's.
 */
export function parseSource(body: unknown): AvatarSourceInput {
  const input = (typeof body === "object" && body !== null ? body : {}) as {
    kind?: unknown;
    label?: unknown;
    note?: unknown;
    deviceId?: unknown;
    rootRef?: unknown;
  };
  const kind = input.kind ?? "declaration";
  if (kind !== "declaration" && kind !== "local_folder") {
    throw new AvatarSourceRefusal(
      "目前只支持文字声明和本地文件夹这两种信息来源。",
      400,
    );
  }
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (kind === "local_folder") {
    const deviceId =
      typeof input.deviceId === "string" ? input.deviceId.trim() : "";
    const rootRef =
      typeof input.rootRef === "string" ? input.rootRef.trim() : "";
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
  return {
    kind,
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
  state: (personId: string) => Promise<AvatarSourceState>;
  /** Active sources only, oldest first: what a run is told. */
  active: (personId: string) => Promise<AvatarSourceForPrompt[]>;
  /** A declaration, or a local folder on one of the person's own machines. */
  add: (personId: string, source: AvatarSourceInput) => Promise<AvatarSource>;
  /** False when there is no active source by that id for this person. */
  revoke: (personId: string, sourceId: string) => Promise<boolean>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAvatarSourceStore(database: Database): AvatarSourceStore {
  /** The kinds this module writes and reads back; any other row is a later stage's and not shown. */
  const activeRows = (agentId: string) =>
    database
      .select({
        id: avatarSources.id,
        kind: avatarSources.kind,
        label: avatarSources.label,
        note: avatarSources.note,
        deviceId: avatarSources.deviceId,
        rootRef: avatarSources.rootRef,
        createdAt: avatarSources.createdAt,
      })
      .from(avatarSources)
      .where(
        and(
          eq(avatarSources.agentId, agentId),
          inArray(avatarSources.kind, ["declaration", "local_folder"]),
          isNull(avatarSources.revokedAt),
        ),
      )
      // Creation order, with the id as the tie-break two inserts in one instant still need.
      .orderBy(asc(avatarSources.createdAt), asc(avatarSources.id));

  const shown = (row: {
    id: string;
    kind: string;
    label: string;
    note: string;
    deviceId: string | null;
    rootRef: string | null;
    createdAt: Date;
  }): AvatarSource =>
    row.kind === "local_folder" && row.deviceId && row.rootRef
      ? {
          id: row.id,
          kind: "local_folder",
          label: row.label,
          note: row.note,
          deviceId: row.deviceId,
          rootRef: row.rootRef,
          createdAt: row.createdAt.toISOString(),
        }
      : {
          id: row.id,
          kind: "declaration",
          label: row.label,
          note: row.note,
          createdAt: row.createdAt.toISOString(),
        };

  return {
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
        (await activeRows(avatarAgentId(personId)))
          .filter((row) => row.kind === "declaration")
          .map((row) => ({
            label: row.label,
            note: row.note,
          })),
      ),

    add: (personId, source) =>
      runAsTenant(personId, () =>
        database.transaction(async (transaction) => {
          const agentId = avatarAgentId(personId);
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
            kind: "declaration" | "local_folder";
            label: string;
            note: string;
            deviceId?: string;
            rootRef?: string;
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
            .returning({
              id: avatarSources.id,
              kind: avatarSources.kind,
              label: avatarSources.label,
              note: avatarSources.note,
              deviceId: avatarSources.deviceId,
              rootRef: avatarSources.rootRef,
              createdAt: avatarSources.createdAt,
            });
          if (!row) throw new Error("avatar source insert returned no row");
          return shown(row);
        }),
      ),

    revoke: async (personId, sourceId) => {
      // Not a uuid is not a row, and must not reach the database as a cast error.
      if (!UUID.test(sourceId)) return false;
      const revoked = await runAsTenant(personId, () =>
        database
          .update(avatarSources)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(avatarSources.id, sourceId),
              eq(avatarSources.agentId, avatarAgentId(personId)),
              isNull(avatarSources.revokedAt),
            ),
          )
          .returning({ id: avatarSources.id }),
      );
      return revoked.length === 1;
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

/**
 * `GET/POST/DELETE /api/me/avatar/sources`: the signed-in person's own 分身's sources.
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

  routes.post("/", requireUser, async (context) => {
    const body = await context.req.json().catch(() => undefined);
    try {
      const source = await store.add(context.var.actor.id, parseSource(body));
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
    );
    return removed
      ? context.json({ removed: true })
      : context.json({ error: "找不到这个信息来源。" }, 404);
  });

  return routes;
}
