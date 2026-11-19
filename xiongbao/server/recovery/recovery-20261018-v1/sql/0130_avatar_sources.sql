/*
 * Story F1, stage 1: the information sources a person declares for their 分身 (spec
 * 2026-11-02-f1-avatar-info-sources, option T1).
 *
 * WHAT A ROW IS. One source the person told their 分身 about. Stage 1 writes only `declaration`: a
 * label and a note in the person's own words ("周报 — 在飞书 / 工作 / 周报"), which the server puts in
 * the 分身's prompt on every run and grants no access with. The other kinds are the spec's later
 * stages (a runner folder, a notebook, a connector) and are named here so the table does not have to
 * be rebuilt for them; the API refuses them until they exist. `device_id` and `root_ref` are for the
 * runner folder: an opaque id the runner made, never an absolute path, which stays on the machine.
 *
 * WHOSE IT IS. Only the person's own 分身, and only theirs: `agent_id` must be `avatar-<tenant_id>`,
 * the id provisioning gives it (`avatarAgentId`), so a row naming any other coworker, or another
 * person's 分身, is refused by the database whoever writes it. A removed source keeps its row with
 * `revoked_at` set, so a removal is a fact that can be read back, and the next run no longer sees it.
 *
 * ROW SECURITY. The owner's frame reads and writes its own rows, and the platform frame reaches
 * every row, the two scopes every tenant table has had since 0072. There is no `system` branch on
 * either side: a source is never a catalogue row, so no other tenant reads one. FORCE binds the
 * owner of the table too, like every sibling.
 *
 * CONFIGURED. `agent_profiles.configured_at` is when the person first saved a source for their
 * 分身 (spec D2): null is what the employee list shows as 待配置. It is a column on the profile rather
 * than a count of sources here, so it says "this was configured" and not "this has rows right now".
 *
 * THE PLACEHOLDER. Provisioning wrote "选择你的信息来源，为个人分身完成输入配置。" as the 分身's
 * role description. That sentence was an instruction to the person, but the router reads a role
 * description as what a coworker is FOR (`routing/classify.ts`), so it told the router this coworker
 * exists to configure sources. Every 分身 still carrying exactly that sentence gets the neutral one
 * provisioning now writes; a role description the person edited is left alone. Only
 * `role_description` changes: the 分身 runs on `configuration.systemPrompt`, which is not touched.
 * The data statement runs as `platform` (FORCE binds the migrator), set locally and cleared at the
 * end, like 0129.
 */
CREATE TABLE "public"."avatar_sources" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" text NOT NULL,
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "device_id" text,
  "root_ref" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "avatar_sources_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "avatar_sources_own_avatar" CHECK ("agent_id" = 'avatar-' || "tenant_id"),
  CONSTRAINT "avatar_sources_kind" CHECK ("kind" IN ('declaration', 'local_folder', 'notebook', 'connector')),
  CONSTRAINT "avatar_sources_label_length" CHECK (char_length("label") BETWEEN 1 AND 60),
  CONSTRAINT "avatar_sources_note_length" CHECK (char_length("note") <= 500)
);
--> statement-breakpoint
CREATE INDEX "avatar_sources_active_idx" ON "public"."avatar_sources" ("agent_id", "created_at") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "public"."avatar_sources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."avatar_sources" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."avatar_sources" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."avatar_sources" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."avatar_sources" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."avatar_sources" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."avatar_sources" TO openbot_app;
--> statement-breakpoint
ALTER TABLE "public"."agent_profiles" ADD COLUMN "configured_at" timestamp with time zone;
--> statement-breakpoint
SELECT set_config('app.tenant_id', 'platform', true);
--> statement-breakpoint
UPDATE public.agent_profiles
   SET role_description = '代表你本人收集、整理和跟进工作信息，回答与你自己的资料、日程和待办有关的问题。'
 WHERE agent_id = 'avatar-' || tenant_id
   AND role_description = '选择你的信息来源，为个人分身完成输入配置。';
--> statement-breakpoint
SELECT set_config('app.tenant_id', '', true);
