/*
 * Story F1, stage 2 (spec 2026-11-02-f1-avatar-info-sources, S2): the read-only folders a paired
 * machine offers.
 *
 * WHAT IS STORED. The runner reports, on every heartbeat, the folders its owner registered on that
 * machine (`runner --add-root`, or the device app's window): for each, an opaque reference the runner
 * made (`fld_` and 22 base64url characters) and the display name the owner chose. Never a path: the
 * absolute path stays in the runner's own `runner-roots.json`, because a folder's path names the
 * person, their clients and their projects. `roots` is that report, as the last heartbeat said it.
 *
 * WHY HERE. It is a fact about one registered device, read where the device is read (the owner's
 * device list, and the check that an information source names a folder this person's own machine
 * offers). A column on the row inherits the row's tenant and its row security: the owner's frame and
 * the platform frame, exactly as `last_seen_at` is written today. No new table, no new policy.
 *
 * BOUNDED. An array of at most 50 entries; the runner offers at most 20. Older runners send no
 * `roots` and the column keeps its default, an empty list.
 */
ALTER TABLE "public"."registered_devices" ADD COLUMN "roots" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."registered_devices" ADD CONSTRAINT "registered_devices_roots_shape" CHECK (jsonb_typeof("roots") = 'array' AND jsonb_array_length("roots") <= 50);
