/*
 * A tool its vendor listed and said nothing about: an MCP server gave it neither `readOnlyHint` nor
 * `destructiveHint`, or Composio gave it none of its read-only, destructive, create or update labels.
 *
 * Kept apart from `destructive`, which stays the vendor's own word and makes every call ask. Such a
 * tool is recorded as a write that is not destructive; background reads (the connection probe and
 * the like) keep away from it as they do from a destructive one. Recorded only where no catalogue
 * list covers the tool, so a catalogue entry's read and write classification is unchanged.
 *
 * `false` for every existing row; each app's next refresh records it.
 */
ALTER TABLE mcp_tools ADD COLUMN IF NOT EXISTS unclassified boolean NOT NULL DEFAULT false;
