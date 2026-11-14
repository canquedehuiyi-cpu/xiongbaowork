/**
 * Coworker tables: bots, skills, routines, bot-to-bot handoff.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or computer.ts to do it.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Persona } from "../../../../shared/persona";
import type { PortraitPreset } from "../../portraits/store";
import { agents, users } from "./core";
import { jsonb } from "./json";
import { knowledgeNotebooks } from "./knowledge-foundations";
import { modelRegistry, platformModelPool } from "./model";
import { mcpServers } from "./plugins";
import { tenantId } from "./tenant";
import { responsibilities } from "./responsibilities";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const agentVisibility = pgEnum("agent_visibility", [
  "public",
  "private",
]);

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    tenantId: tenantId(),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    roleDescription: text("role_description").notNull(),
    avatarSeed: text("avatar_seed").notNull(),
    visibility: agentVisibility("visibility").notNull(),
    /**
     * The tenant's connected model this coworker speaks with (ticket 012).
     * Null means the deployment default; a dangling id degrades to the same
     * rather than refusing the turn.
     */
    modelRef: uuid("model_ref").references(() => modelRegistry.id, {
      onDelete: "set null",
    }),
    /**
     * A platform pool model this coworker speaks with instead (stories H1, K1, migration 0120): the
     * experience models a Free tenant has before connecting a key. Never set together with
     * `modelRef`; a pool row still bound here cannot be deleted, only disabled.
     */
    platformModelRef: uuid("platform_model_ref").references(
      () => platformModelPool.id,
      { onDelete: "restrict" },
    ),
    /*
     * A computer of its own rather than its owner's.
     *
     * By default every Bot a person uses runs on that person's one computer, each Bot with its own
     * browser profile and folder there. An isolated Bot gets a computer keyed by the Bot instead, which
     * keeps its logins between runs and which everyone who uses the Bot shares. Only someone the
     * `isolatedComputers` capability allows may set it; when that is withdrawn the Bot runs on the
     * person's computer again rather than stopping.
     */
    isolated: boolean("isolated").notNull().default(false),
    /*
     * The credential this Bot's agent presents when it calls a tool back.
     *
     * A hash, never the token. We issue it, the agent's owner holds it, and this side only ever needs
     * to check one: storing the token itself would mean a database dump is a set of working
     * credentials for every registered agent.
     *
     * Null means the agent has not been issued one and may not call tools back, which is the right
     * default: a URL somebody pasted gets no capability until an administrator hands it one.
     */
    callbackTokenHash: text("callback_token_hash"),
    callbackTokenIssuedAt: timestamp("callback_token_issued_at", {
      withTimezone: true,
    }),
    /**
     * Who this coworker is, as its owner wrote it (ticket 014).
     *
     * Null means no persona, which is every coworker written before this existed and is not the same
     * thing as a persona with three empty boxes: only the first sends no section at all.
     */
    persona: jsonb("persona").$type<Persona | null>(),
    /**
     * When the person first saved an information source for their 分身 (story F1, spec D2,
     * migration 0130). Null is what the employee list shows as 待配置. Only the 分身 has one: every
     * other coworker is configured when it is created, and leaves this null.
     */
    configuredAt: timestamp("configured_at", { withTimezone: true }),
    /**
     * The coworker's 工作手册 (story ROLE1, the "Bible"): long-form background, procedures or a glossary
     * its owner wrote, sent in full after the persona. At most 8000 characters; null means none.
     */
    bible: text("bible"),
    /**
     * The role template this coworker's identity, persona and Bible were last taken from, and that
     * template's version at the time (story ROLE1). Both null or both set. No foreign
     * key: `role_templates` is the owner's alone under row security while this row may be `team`'s,
     * so a deleted template clears these in the application instead.
     */
    roleTemplateId: uuid("role_template_id"),
    roleTemplateVersion: integer("role_template_version"),
    /**
     * The agent this coworker was summoned from (召唤员工, migration 0213). Null for one made by hand.
     * Cleared when the source is deleted; the coworker stays.
     */
    summonedFrom: text("summoned_from").references(() => agents.id, {
      onDelete: "set null",
    }),
    /** The preset portrait this coworker uses (migration 0213). Null means none. */
    presetPortrait: text("preset_portrait").$type<PortraitPreset>(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("agent_profiles_owner_summoned_from_unique")
      .on(table.ownerUserId, table.summonedFrom)
      .where(
        sql`${table.summonedFrom} IS NOT NULL AND ${table.deletedAt} IS NULL`,
      ),
    index("agent_profiles_visibility_deleted_idx").on(
      table.visibility,
      table.deletedAt,
    ),
    check(
      "agent_profiles_single_model_binding",
      sql`${table.modelRef} IS NULL OR ${table.platformModelRef} IS NULL`,
    ),
    check(
      "agent_profiles_bible_length",
      sql`${table.bible} IS NULL OR char_length(${table.bible}) <= 8000`,
    ),
    check(
      "agent_profiles_role_template_pair",
      sql`(${table.roleTemplateId} IS NULL) = (${table.roleTemplateVersion} IS NULL)`,
    ),
    check(
      "agent_profiles_role_template_version",
      sql`${table.roleTemplateVersion} IS NULL OR ${table.roleTemplateVersion} > 0`,
    ),
  ],
);

/*
 * Who may see an avatar source, and who may write one: the owner's frame, and the platform's. No
 * `system` branch on either side, because a source is never a catalogue row (migration 0130).
 */
const avatarSourceScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/**
 * An information source a person declared for their 分身 (story F1, option T1, migration 0130).
 *
 * Stage 1 writes `declaration` only: a label and a note in the person's words, put in the 分身's
 * prompt on each run and granting no access to anything. The other kinds are later stages and the
 * API refuses them. `agent_id` is always `avatar-<tenant_id>`: the database refuses anything else.
 * A removed source keeps its row with `revokedAt` set.
 */
export const avatarSources = pgTable(
  "avatar_sources",
  {
    tenantId: tenantId(),
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind")
      .$type<"declaration" | "local_folder" | "notebook" | "connector">()
      .notNull(),
    label: text("label").notNull(),
    note: text("note").notNull().default(""),
    /** The runner folder's machine (a later stage). Never set by stage 1. */
    deviceId: text("device_id"),
    /** The runner's opaque id for a folder: never an absolute path (a later stage). */
    rootRef: text("root_ref"),
    /**
     * A notebook source's notebook (stage 3, S3): one of the person's own RES1 notebooks. Set for
     * `notebook` and for nothing else (`avatar_sources_kind_refs`, 0142). Reading it goes through the
     * RES1 binding the same save writes, never through this pointer.
     */
    notebookId: uuid("notebook_id").references(() => knowledgeNotebooks.id, {
      onDelete: "cascade",
    }),
    /**
     * A connector source's connector row (stage 3, S4, ADR-0002 `mcp_servers.id`). Set for
     * `connector` and for nothing else. Calling it goes through the plugin grants the same save writes.
     */
    serverId: text("server_id").references(() => mcpServers.id, {
      onDelete: "cascade",
    }),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("avatar_sources_active_idx")
      .on(table.agentId, table.createdAt)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "avatar_sources_own_avatar",
      sql`${table.agentId} = 'avatar-' || ${table.tenantId}`,
    ),
    check(
      "avatar_sources_kind",
      sql`${table.kind} IN ('declaration', 'local_folder', 'notebook', 'connector')`,
    ),
    check(
      "avatar_sources_label_length",
      sql`char_length(${table.label}) BETWEEN 1 AND 60`,
    ),
    check("avatar_sources_note_length", sql`char_length(${table.note}) <= 500`),
    check(
      "avatar_sources_kind_refs",
      sql`(${table.kind} = 'notebook') = (${table.notebookId} IS NOT NULL) AND (${table.kind} = 'connector') = (${table.serverId} IS NOT NULL) AND (${table.kind} = 'local_folder' OR (${table.deviceId} IS NULL AND ${table.rootRef} IS NULL))`,
    ),
    uniqueIndex("avatar_sources_active_notebook_idx")
      .on(table.agentId, table.notebookId)
      .where(
        sql`${table.revokedAt} IS NULL AND ${table.notebookId} IS NOT NULL`,
      ),
    uniqueIndex("avatar_sources_active_connector_idx")
      .on(table.agentId, table.serverId)
      .where(sql`${table.revokedAt} IS NULL AND ${table.serverId} IS NOT NULL`),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "select",
      to: "public",
      using: avatarSourceScope,
    }),
    pgPolicy("tenant_isolation_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: avatarSourceScope,
    }),
    pgPolicy("tenant_isolation_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: avatarSourceScope,
      withCheck: avatarSourceScope,
    }),
    pgPolicy("tenant_isolation_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: avatarSourceScope,
    }),
  ],
).enableRLS();

/**
 * A persona kept to be given again.
 *
 * The reuse is the point: a tenant with six reviewers wants the same care written once, and a
 * persona that only lives on one coworker is a persona that gets retyped — which is how the sixth
 * one ends up with a shorter version of the rule everybody meant.
 */
export const personaTemplates = pgTable(
  "persona_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    persona: jsonb("persona").$type<Persona>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("persona_templates_tenant_idx").on(table.tenantId),
    uniqueIndex("persona_templates_tenant_name_idx").on(
      table.tenantId,
      table.name,
    ),
  ],
);

export const agentPreferences = pgTable(
  "agent_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: tenantId(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);

export const routineRunStatus = pgEnum("routine_run_status", [
  "succeeded",
  "failed",
  "skipped",
  "waiting",
]);

/**
 * A standing instruction one person gave one Bot, on a schedule.
 *
 * Owned rows all the way down: the owner is who the headless turn runs as, so the routine can do
 * exactly what its owner could do in chat and nothing more. The channel is where the reply lands.
 */
export const routines = pgTable(
  "routines",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * Not a foreign key. Channels soft-delete (`channels.deletedAt`), and a routine pointing at a
     * deleted channel must survive to be shown as broken rather than vanish in a cascade.
     */
    channelId: text("channel_id").notNull(),
    instruction: text("instruction").notNull(),
    /**
     * What the person called it, in their own words: "Morning briefing". Null when they named it
     * nothing, and then the instruction stands in for it wherever a routine is named.
     */
    title: text("title"),
    /**
     * The goal this routine runs, recorded when it is made for one (`goalId` on `create_routine`, or
     * the goal's id in its instruction) or when its firing runs one with `run_goal`. A goal a routine
     * runs repeats, and is listed with it. Cleared when the goal is deleted.
     */
    goalId: text("goal_id").references(() => responsibilities.id, {
      onDelete: "set null",
    }),
    /**
     * Made before routines recorded their goal. Its goal, if any, is found from its instruction: the
     * goal's id, or its whole title in quotes. False for every routine made since.
     */
    goalByTitle: boolean("goal_by_title").notNull().default(false),
    /** Five-field cron. Validated at the tool boundary; never parsed by the client. */
    cron: text("cron").notNull(),
    /** IANA zone the cron is read in. UTC when the person never said otherwise. */
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    /** The sweep's read target. Recomputed on every write and CAS-advanced by the sweep. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    /**
     * The last occurrence stamp the sweep advanced past — fired OR silently drained as stale.
     * Not "when this last ran": the run history lives in routine_runs, and everything a person
     * sees reads that table. This is the scheduler's own bookmark, kept because a CAS needs the
     * value it compared against recorded somewhere a human can inspect when a clock looks wrong.
     */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /**
     * When this routine was last switched on, or created. The fatigue rule counts failures from
     * here, so a routine switched off after ten failures and switched back on gets ten more chances
     * rather than one. Not `updatedAt`, which every sweep that claims the routine moves.
     */
    enabledAt: timestamp("enabled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("routines_due_idx").on(table.enabled, table.nextRunAt),
    /** Owner-scoped reads and writes: listFor, countEnabled, and the users cascade all hit this. */
    index("routines_by_owner_idx").on(table.ownerUserId, table.enabled),
  ],
);

export const routineSweeps = pgTable("routine_sweeps", {
  id: text("id").primaryKey(),
  sweptAt: timestamp("swept_at", { withTimezone: true }).notNull().defaultNow(),
  owner: text("owner"),
});

/** One row per firing, which is what the page's "last ran" and the fatigue rule read. */
export const routineRuns = pgTable(
  "routine_runs",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Null means the firing is still in flight; only a finished run has succeeded/failed/skipped. */
    status: routineRunStatus("status"),
    waiting: jsonb("waiting").$type<Record<string, unknown>>(),
    /** The refusal or the throw, capped like audit payloads. Never shown raw to a person. */
    error: text("error"),
    /** What started this run: its schedule, a person pressing Run now, or an event trigger. */
    source: text("source")
      .$type<"schedule" | "run_now" | "trigger">()
      .notNull()
      .default("schedule"),
  },
  (table) => [
    index("routine_runs_by_routine_idx").on(table.routineId, table.startedAt),
  ],
);
