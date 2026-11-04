/*
 * Story F1, stage 3: a notebook (S3) and a connector (S4) as information sources of a person's 分身
 * (spec 2026-11-02-f1-avatar-info-sources §3, D1: S3 with RES1, S4 through the connector catalogue).
 *
 * WHAT IS ADDED. The two columns each new kind points with, and nothing else of the table changes:
 * the kinds were named in 0130, and its row security, its own-分身 check and its limits still hold.
 *
 * - `notebook_id`: one of the person's own knowledge notebooks (RES1, `knowledge_notebooks`). The
 *   source is the person's record of the attachment; what lets the 分身 read is the RES1 binding the
 *   same save writes (`knowledge_bindings`, read only), and the knowledge tools read through that
 *   binding alone. No second store of the notebook's text exists or is made.
 * - `server_id`: one of the deployment's connector rows (ADR-0002, `mcp_servers.id`) the person has
 *   connected their own account to. What lets the 分身 call it is the plugin grants the same save
 *   writes, so every call still goes through the plugin store, the SEC1 rules and the approval gate.
 *   The package-level `knowledgeSources` stays unread: nothing here touches it.
 *
 * Each kind carries exactly its own pointer and no other (`avatar_sources_kind_refs`), so a
 * declaration can never be mistaken for an attachment. The pointers are real foreign keys with
 * CASCADE: a notebook or a connector row that is gone takes its source with it, rather than leaving
 * a row that names nothing. A soft-deleted notebook and a removed binding or grant are read as "no
 * longer held" by the store instead (see `avatar-sources.ts`).
 *
 * ONE ACTIVE ROW PER THING. Two saves of the same notebook or connector at once land one row: the
 * partial unique indexes below admit a second only after the first is removed.
 *
 * Whose notebook or connection it is cannot be said by a foreign key (a key does not look at row
 * security), so the store asks it in the person's own frame before it writes; RES1's binding and the
 * plugin grant are written through their own stores, which ask it again.
 */
ALTER TABLE "public"."avatar_sources" ADD COLUMN "notebook_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."avatar_sources" ADD COLUMN "server_id" text;
--> statement-breakpoint
ALTER TABLE "public"."avatar_sources" ADD CONSTRAINT "avatar_sources_notebook_id_knowledge_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."knowledge_notebooks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."avatar_sources" ADD CONSTRAINT "avatar_sources_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."avatar_sources" ADD CONSTRAINT "avatar_sources_kind_refs" CHECK (
  ("kind" = 'notebook') = ("notebook_id" IS NOT NULL)
  AND ("kind" = 'connector') = ("server_id" IS NOT NULL)
  AND ("kind" = 'local_folder' OR ("device_id" IS NULL AND "root_ref" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "avatar_sources_active_notebook_idx" ON "public"."avatar_sources" ("agent_id", "notebook_id") WHERE "revoked_at" IS NULL AND "notebook_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "avatar_sources_active_connector_idx" ON "public"."avatar_sources" ("agent_id", "server_id") WHERE "revoked_at" IS NULL AND "server_id" IS NOT NULL;
