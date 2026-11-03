/*
 * G01-E P6b: sandboxed (playground) components live in the shared `team` tenant.
 *
 * Until now a playground component was stamped with the frame of the administrator who saved it, so
 * a second administrator could neither list nor edit it, and a member's `/api/sandboxed/published`
 * never saw a component another person published. The store now writes `team` (admitted by 0122's
 * `team_write_*` policies, which require the admin capability), members read published rows through
 * `team_read`, and administrators with the capability read drafts. This moves any row written before.
 * `system` rows (shipped catalogue) stay where they are.
 *
 * The 0122 row guard admits a tenant_id change only under `platform`, and drizzle runs every pending
 * migration in one transaction, so the frame is set locally here and cleared at the end.
 */
SELECT set_config('app.tenant_id', 'platform', true);
--> statement-breakpoint
UPDATE sandboxed_components SET tenant_id = 'team' WHERE tenant_id NOT IN ('team', 'system');
--> statement-breakpoint
SELECT set_config('app.tenant_id', '', true);
