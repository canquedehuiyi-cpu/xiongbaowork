/*
 * Story ROLE1 (docs/specs/2026-11-04-role1-role-templates.md, option C): role templates are kept apart
 * from the coworkers made from them.
 *
 * 1. THE INSTANCE. A coworker stays one row of `agent_profiles`, the only thing the runtime, the
 *    router and the Team Bot paths read. Three nullable columns:
 *    - `bible`: the coworker's 工作手册, sent in full after the persona (D3), at most 8000 characters.
 *      Written by its owner, never into `configuration.systemPrompt`.
 *    - `role_template_id` / `role_template_version`: which template, at which version, the identity,
 *      persona and Bible were last taken from. Both null or both set, the version positive. No foreign
 *      key: `role_templates` is visible only in its owner's own frame while a profile may be stamped
 *      `team`, so a deleted template clears these in the application, and an edited coworker keeps
 *      them (the screen compares contents to say it was changed after).
 *    Every row written before this keeps all three null, which is "no Bible, no template".
 *
 * 2. THE TEMPLATES. The dormant `role_templates` (0082) is enabled exactly as it is: `profile` holds a
 *    role profile ({ identity, persona, bible }) and `version` goes up by one on every edit. Its
 *    structure, its FORCEd row security (owner's own frame only, never `system` or `platform`) and its
 *    grants are unchanged; nothing here alters it, and `platform` gets no policy because no template
 *    is ever read or written outside its owner's frame. `role_generation_requests` (0082) is enabled
 *    the same way, unchanged, for smart generation (ROLE1-4).
 *    `employee_role_snapshots` and `role_write_receipts` stay dormant: the instance's one source is
 *    `agent_profiles`, and a template write is made idempotent by the unique name and the version
 *    condition, not by a receipt.
 *
 * 3. THE OLD PERSONA TEMPLATES (D6). Each `persona_templates` row is copied into `role_templates` as a
 *    template with an empty identity, its persona, an empty Bible and version 1, under the same name
 *    (trimmed, at most 80 characters). `role_templates` admits a write only in its owner's own frame,
 *    and FORCE binds the migrator too, so the copy runs one tenant at a time with `app.tenant_id` set
 *    locally to that tenant, after listing the tenants as `platform`; `system`, `platform` and `team`
 *    are skipped, as is a tenant that is not a person. ON CONFLICT DO NOTHING on the unique name makes
 *    a second run add nothing. `persona_templates` itself is kept: `/api/personas` reads both until it
 *    is retired.
 */
ALTER TABLE "public"."agent_profiles" ADD COLUMN "bible" text;
--> statement-breakpoint
ALTER TABLE "public"."agent_profiles" ADD COLUMN "role_template_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."agent_profiles" ADD COLUMN "role_template_version" integer;
--> statement-breakpoint
ALTER TABLE "public"."agent_profiles" ADD CONSTRAINT "agent_profiles_bible_length" CHECK ("agent_profiles"."bible" IS NULL OR char_length("agent_profiles"."bible") <= 8000);
--> statement-breakpoint
ALTER TABLE "public"."agent_profiles" ADD CONSTRAINT "agent_profiles_role_template_pair" CHECK (("agent_profiles"."role_template_id" IS NULL) = ("agent_profiles"."role_template_version" IS NULL));
--> statement-breakpoint
ALTER TABLE "public"."agent_profiles" ADD CONSTRAINT "agent_profiles_role_template_version" CHECK ("agent_profiles"."role_template_version" IS NULL OR "agent_profiles"."role_template_version" > 0);
--> statement-breakpoint
DO $$
DECLARE
  tenants text[];
  tenant text;
BEGIN
  PERFORM set_config('app.tenant_id', 'platform', true);
  SELECT coalesce(array_agg(DISTINCT p.tenant_id ORDER BY p.tenant_id), '{}'::text[])
    INTO tenants
    FROM public.persona_templates p
   WHERE p.tenant_id NOT IN ('system', 'platform', 'team');
  FOREACH tenant IN ARRAY tenants LOOP
    PERFORM set_config('app.tenant_id', tenant, true);
    INSERT INTO public.role_templates (tenant_id, owner_user_id, name, profile, version)
    SELECT p.tenant_id,
           p.tenant_id,
           left(btrim(p.name), 80),
           jsonb_build_object(
             'identity', jsonb_build_object('title', '', 'roleDescription', ''),
             'persona', jsonb_build_object(
               'tone', coalesce(p.persona ->> 'tone', ''),
               'principles', coalesce(p.persona ->> 'principles', ''),
               'habits', coalesce(p.persona ->> 'habits', '')
             ),
             'bible', ''
           ),
           1
      FROM public.persona_templates p
     WHERE p.tenant_id = tenant
       AND jsonb_typeof(p.persona) = 'object'
       AND char_length(btrim(p.name)) > 0
       AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = p.tenant_id)
     ORDER BY p.updated_at DESC, p.id
    ON CONFLICT (tenant_id, owner_user_id, name) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
