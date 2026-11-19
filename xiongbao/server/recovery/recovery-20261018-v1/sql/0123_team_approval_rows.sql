/*
 * G01-E P6a ("team-rules"): team approval rules and the team approval settings row live in the
 * shared `team` tenant.
 *
 * Until now an administrator's team rule was stamped with the admin's own frame, so only that admin
 * (and `platform`) could read it, and a member's gate never applied it; the one settings row (id
 * 'team') belonged to whichever admin saved it first, and a second admin's save collided on the
 * primary key without being able to see it. The store now writes `team` (admitted by 0122's
 * `team_write_*` policies, which require the admin capability) and members read it through
 * `team_read`. This moves any row written before.
 *
 * The 0122 row guard admits a tenant_id change only under `platform`, and drizzle runs every pending
 * migration in one transaction, so the frame is set locally here and cleared at the end.
 */
SELECT set_config('app.tenant_id', 'platform', true);
--> statement-breakpoint
UPDATE approval_team_settings SET tenant_id = 'team' WHERE id = 'team' AND tenant_id <> 'team';
--> statement-breakpoint
UPDATE approval_team_rules SET tenant_id = 'team' WHERE tenant_id <> 'team';
--> statement-breakpoint
SELECT set_config('app.tenant_id', '', true);
