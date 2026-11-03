/*
 * G01-E P8b: public and published Bots live in the shared `team` tenant.
 *
 * Until now a public Bot was stamped with its owner's tenant, so row security showed it to its owner
 * alone and every other person saw it only where it happened to carry the legacy `system` stamp. The
 * profile store now moves a Bot to `team` when it is made public (the owner's explicit move, keyed by
 * `app.team_move`, admitted by 0122's row guard), and teammates read it through `team_read`, gated by
 * `openbot_team_bot_visible`. This moves every Bot made public or published before.
 *
 * Moved: the profile, its `agents` row, its publication, audience and assignment rows, and its plugin
 * grants (so the Bot keeps the tools it was granted). Not moved: the Bot's child rows (security
 * policy, knowledge bindings, device projects), which stay with the owner (I8); 0122's
 * `*_team_bot_*` policies keep them reachable for the owner. A profile without an owner, a deleted
 * one, and the `system`/`platform` catalogue are left where they are.
 *
 * The 0122 row guard admits a tenant_id change only under `platform`, and drizzle runs every pending
 * migration in one transaction, so the frame is set locally here and cleared at the end.
 */
SELECT set_config('app.tenant_id', 'platform', true);
--> statement-breakpoint
UPDATE agent_profiles SET tenant_id = 'team'
 WHERE tenant_id NOT IN ('system', 'platform', 'team') AND deleted_at IS NULL AND owner_user_id IS NOT NULL
   AND (visibility = 'public' OR agent_id IN (SELECT agent_id FROM team_bot_publications));
--> statement-breakpoint
UPDATE agents a SET tenant_id = 'team' FROM agent_profiles p
 WHERE p.agent_id = a.id AND p.tenant_id = 'team' AND a.tenant_id NOT IN ('system', 'platform', 'team');
--> statement-breakpoint
UPDATE team_bot_publications SET tenant_id = 'team' WHERE tenant_id <> 'team';
--> statement-breakpoint
UPDATE team_bot_audience SET tenant_id = 'team' WHERE tenant_id <> 'team';
--> statement-breakpoint
UPDATE team_bot_assignments SET tenant_id = 'team' WHERE tenant_id <> 'team';
--> statement-breakpoint
UPDATE plugin_grants g SET tenant_id = 'team' FROM agent_profiles p
 WHERE p.agent_id = g.agent_id AND p.tenant_id = 'team' AND g.tenant_id NOT IN ('system', 'platform', 'team');
--> statement-breakpoint
SELECT set_config('app.tenant_id', '', true);
