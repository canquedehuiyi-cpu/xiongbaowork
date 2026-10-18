import {
  boolean,
  index,
  uniqueIndex,
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
