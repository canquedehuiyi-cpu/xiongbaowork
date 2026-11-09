/*
 * Which reading of a vendor's listing stored an app's tools (upstream 0080).
 *
 * Every refresh that stores an app's tools writes the current `LISTING_REVISION` from
 * `plugins/store.ts`; rows stored before this column existed are 0. 0146 started recording a
 * Composio action with none of the read-only, destructive, create or update labels as
 * `unclassified`, where it had been recorded as a plain write, and a stored row cannot tell the two
 * apart, so nothing is rewritten here. Instead each broker app that is behind is listed again once
 * at the next start of a deployment that has Composio configured.
 */
ALTER TABLE "public"."mcp_servers" ADD COLUMN IF NOT EXISTS "listing_revision" integer DEFAULT 0 NOT NULL;
