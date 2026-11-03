import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  uniqueIndex,
  unique,
  uuid,
  text,
  timestamp,
  pgTable,
} from "drizzle-orm/pg-core";
import { credentials } from "./core";
import { tenantId } from "./tenant";

/**
 * A model a tenant connected: which platform provider template it came
 * through, where to dial, the vault row holding the key, and which model to
 * ask for. Coworkers bind here (`agent_profiles.model_ref`), so "开发用
 * GPT-6、审核用 GLM-5.3" is one row each.
 */
export const modelRegistry = pgTable(
  "model_registry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    /** The platform template's id: openai, anthropic, google, openrouter, custom... */
    provider: text("provider").notNull(),
    /** Only meaningful for templates that take an endpoint (custom/openai-compatible). */
    baseUrl: text("base_url"),
    credentialId: uuid("credential_id").references(() => credentials.id, {
      onDelete: "set null",
    }),
    modelName: text("model_name").notNull(),
    label: text("label"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_registry_tenant_model_idx").on(
      table.tenantId,
      table.provider,
      table.modelName,
    ),
    index("model_registry_tenant_idx").on(table.tenantId),
  ],
);

/** Platform-owned catalogue of provider shapes a tenant may connect through. */
export const providerTemplates = pgTable("provider_templates", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  /** Whether the tenant is offered the endpoint override. */
  allowsBaseUrl: boolean("allows_base_url").notNull().default(false),
  /** How the connectivity probe reaches it: chat-completions | messages | generativelanguage. */
  probe: text("probe").notNull().default("chat-completions"),
});

/** The plans a platform pool row may name; the migration's CHECK holds the same two. */
export const PLATFORM_POOL_TIERS = ["free", "pro"] as const;
export type PlatformPoolTier = (typeof PLATFORM_POOL_TIERS)[number];

/**
 * The name shape `api_key_env` must have (0120). The resolver checks it again before it reads the
 * environment, so a row can only ever name a pool key and never DATABASE_URL or the vault key.
 */
export const PLATFORM_POOL_KEY_ENV = /^OPENBOT_POOL_[A-Z0-9_]{1,64}$/;

/**
 * The platform's own experience models (stories H1, K1): what a Free tenant's coworkers may speak
 * with before the tenant connects a key of its own. Platform-owned, so no tenant_id and no row-level
 * security; the application holds SELECT only and the operator writes the rows. The key is never
 * stored: `apiKeyEnv` names the deployment environment variable that holds it.
 */
export const platformModelPool = pgTable(
  "platform_model_pool",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    baseUrl: text("base_url"),
    modelName: text("model_name").notNull(),
    label: text("label").notNull(),
    apiKeyEnv: text("api_key_env").notNull(),
    tiers: text("tiers")
      .array()
      .$type<PlatformPoolTier[]>()
      .notNull()
      .default(sql`'{free,pro}'::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("platform_model_pool_provider_model_unique").on(
      table.provider,
      table.modelName,
    ),
    check(
      "platform_model_pool_api_key_env",
      sql`${table.apiKeyEnv} ~ '^OPENBOT_POOL_[A-Z0-9_]{1,64}$'`,
    ),
    check(
      "platform_model_pool_tiers",
      sql`${table.tiers} <@ '{free,pro}'::text[]`,
    ),
  ],
);
