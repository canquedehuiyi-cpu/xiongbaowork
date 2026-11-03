/*
 * SEC1 (docs/specs/2026-11-02-sec1-employee-tool-permissions.md, option B): per-employee tool
 * permissions.
 *
 * 1. A rule may disable a tool. `approval_rules` and `approval_team_rules` accept `deny` beside the
 *    four behaviours they had. Purely a wider CHECK: every row written before still satisfies it and
 *    is read exactly as before. The code that reads `deny` (and ranks any behaviour it does not know
 *    as `deny`) shipped before this migration, as §4.1 orders.
 *
 * 2. The team can make every Bot ask before a dangerous command (D10):
 *    `approval_team_settings.enforce_dangerous_commands`, false by default, so no deployment's
 *    behaviour changes until an administrator turns it on. The row is the shared `team` row; its
 *    write policies (admin capability) and the 0122 row guard are unchanged.
 *
 * 3. One Bot's own security floors (D3, B1): `agent_security_settings`, a NEW table. The dormant
 *    `agent_security_policies` (0099) stays exactly as it is, unwritten and ungranted.
 *
 *    A row belongs to the Bot's owner and is stamped with the owner (I8: a Bot's child rows stay with
 *    its owner when the Bot moves to `team`). Row security is the sibling's, command for command:
 *    the owner policies of 0099 (the row is the writer's own, and the writer owns the Bot's profile
 *    under the same stamp) and the additive `_team_bot_` copies of 0122 (the writer owns the Bot's
 *    `team` profile). Nobody else reads it; another person using the Bot reaches the owner's floors
 *    only through the server reading them in the owner's frame, never through a wider policy.
 *
 *    Defaults are the floors' defaults: both ask, no added paths, no default path switched off. A
 *    default path can only be switched off, never removed (D8); the application keeps the list.
 */
ALTER TABLE "public"."approval_rules" DROP CONSTRAINT "approval_rules_behaviour_check";
--> statement-breakpoint
ALTER TABLE "public"."approval_rules" ADD CONSTRAINT "approval_rules_behaviour_check" CHECK ("approval_rules"."behaviour" IN ('allow', 'pre_approved', 'ask', 'hand_off', 'deny'));
--> statement-breakpoint
ALTER TABLE "public"."approval_team_rules" DROP CONSTRAINT "approval_team_rules_behaviour_check";
--> statement-breakpoint
ALTER TABLE "public"."approval_team_rules" ADD CONSTRAINT "approval_team_rules_behaviour_check" CHECK ("approval_team_rules"."behaviour" IN ('allow', 'pre_approved', 'ask', 'hand_off', 'deny'));
--> statement-breakpoint
ALTER TABLE "public"."approval_team_settings" ADD COLUMN "enforce_dangerous_commands" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "public"."agent_security_settings" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "agent_id" text NOT NULL,
  "dangerous_commands" text DEFAULT 'ask' NOT NULL,
  "sensitive_paths" text DEFAULT 'ask' NOT NULL,
  "extra_sensitive_paths" text[] DEFAULT '{}'::text[] NOT NULL,
  "disabled_default_paths" text[] DEFAULT '{}'::text[] NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_security_settings_tenant_id_agent_id_pk" PRIMARY KEY ("tenant_id", "agent_id"),
  CONSTRAINT "agent_security_settings_dangerous_commands_check" CHECK ("agent_security_settings"."dangerous_commands" IN ('off', 'ask')),
  CONSTRAINT "agent_security_settings_sensitive_paths_check" CHECK ("agent_security_settings"."sensitive_paths" IN ('off', 'ask')),
  CONSTRAINT "agent_security_settings_paths_bounded" CHECK (cardinality("agent_security_settings"."extra_sensitive_paths") <= 50 AND cardinality("agent_security_settings"."disabled_default_paths") <= 50),
  CONSTRAINT "agent_security_settings_tenant_person" CHECK ("agent_security_settings"."tenant_id" NOT IN ('system', 'platform', 'team'))
);
--> statement-breakpoint
ALTER TABLE "public"."agent_security_settings" ADD CONSTRAINT "agent_security_settings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."agent_security_settings" ADD CONSTRAINT "agent_security_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."agent_security_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."agent_security_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "agent_security_settings_owner_select" ON "public"."agent_security_settings" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_settings"."agent_id"
          AND p."tenant_id" = "agent_security_settings"."tenant_id" AND p."owner_user_id" = "agent_security_settings"."tenant_id" AND p."deleted_at" IS NULL));
--> statement-breakpoint
CREATE POLICY "agent_security_settings_owner_insert" ON "public"."agent_security_settings" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_settings"."agent_id"
          AND p."tenant_id" = "agent_security_settings"."tenant_id" AND p."owner_user_id" = "agent_security_settings"."tenant_id" AND p."deleted_at" IS NULL));
--> statement-breakpoint
CREATE POLICY "agent_security_settings_owner_update" ON "public"."agent_security_settings" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_settings"."agent_id"
          AND p."tenant_id" = "agent_security_settings"."tenant_id" AND p."owner_user_id" = "agent_security_settings"."tenant_id" AND p."deleted_at" IS NULL)) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_settings"."agent_id"
          AND p."tenant_id" = "agent_security_settings"."tenant_id" AND p."owner_user_id" = "agent_security_settings"."tenant_id" AND p."deleted_at" IS NULL));
--> statement-breakpoint
CREATE POLICY "agent_security_settings_owner_delete" ON "public"."agent_security_settings" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" = current_setting('app.tenant_id', true)
        AND EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p."agent_id" = "agent_security_settings"."agent_id"
          AND p."tenant_id" = "agent_security_settings"."tenant_id" AND p."owner_user_id" = "agent_security_settings"."tenant_id" AND p."deleted_at" IS NULL));
--> statement-breakpoint
CREATE POLICY agent_security_settings_team_bot_select ON public.agent_security_settings AS PERMISSIVE FOR SELECT TO public
  USING ((tenant_id = current_setting('app.tenant_id', true)) AND (EXISTS (SELECT 1 FROM public.agent_profiles p
    WHERE p.agent_id = agent_security_settings.agent_id AND p.tenant_id = 'team'
      AND p.owner_user_id = agent_security_settings.tenant_id AND p.deleted_at IS NULL)));
--> statement-breakpoint
CREATE POLICY agent_security_settings_team_bot_insert ON public.agent_security_settings AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((tenant_id = current_setting('app.tenant_id', true)) AND (EXISTS (SELECT 1 FROM public.agent_profiles p
    WHERE p.agent_id = agent_security_settings.agent_id AND p.tenant_id = 'team'
      AND p.owner_user_id = agent_security_settings.tenant_id AND p.deleted_at IS NULL)));
--> statement-breakpoint
CREATE POLICY agent_security_settings_team_bot_update ON public.agent_security_settings AS PERMISSIVE FOR UPDATE TO public
  USING ((tenant_id = current_setting('app.tenant_id', true)) AND (EXISTS (SELECT 1 FROM public.agent_profiles p
    WHERE p.agent_id = agent_security_settings.agent_id AND p.tenant_id = 'team'
      AND p.owner_user_id = agent_security_settings.tenant_id AND p.deleted_at IS NULL)))
  WITH CHECK ((tenant_id = current_setting('app.tenant_id', true)) AND (EXISTS (SELECT 1 FROM public.agent_profiles p
    WHERE p.agent_id = agent_security_settings.agent_id AND p.tenant_id = 'team'
      AND p.owner_user_id = agent_security_settings.tenant_id AND p.deleted_at IS NULL)));
--> statement-breakpoint
CREATE POLICY agent_security_settings_team_bot_delete ON public.agent_security_settings AS PERMISSIVE FOR DELETE TO public
  USING ((tenant_id = current_setting('app.tenant_id', true)) AND (EXISTS (SELECT 1 FROM public.agent_profiles p
    WHERE p.agent_id = agent_security_settings.agent_id AND p.tenant_id = 'team'
      AND p.owner_user_id = agent_security_settings.tenant_id AND p.deleted_at IS NULL)));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."agent_security_settings" TO openbot_app;
