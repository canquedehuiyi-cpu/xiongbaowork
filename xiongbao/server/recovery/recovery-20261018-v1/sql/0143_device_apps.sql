/*
 * Device MCP bridge (spec 2026-11-07-device-mcp-bridge, 3.4): the local apps a paired machine offers.
 *
 * WHAT IS STORED. The runner reports, on every heartbeat, the local apps (MCP servers) its owner
 * registered on that machine: for each, an opaque reference the runner made (`app_` and 22 base64url
 * characters) and the display name the owner chose. Never a command or a path: those stay in the
 * runner's own configuration. `apps` is that report, as the last heartbeat said it.
 *
 * WHY HERE. Same reasoning as `roots` (0132): a fact about one registered device, read where the
 * device is read, inheriting the row's tenant and row security. No new table, no new policy.
 *
 * BOUNDED. An array of at most 50 entries; the server keeps at most 20 from a report. Older runners
 * send no `apps` and the column keeps its default, an empty list.
 */
ALTER TABLE "public"."registered_devices" ADD COLUMN "apps" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."registered_devices" ADD CONSTRAINT "registered_devices_apps_shape" CHECK (jsonb_typeof("apps") = 'array' AND jsonb_array_length("apps") <= 50);
