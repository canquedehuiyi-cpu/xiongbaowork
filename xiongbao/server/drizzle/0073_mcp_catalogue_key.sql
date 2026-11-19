ALTER TABLE "mcp_servers" ADD COLUMN "catalogue_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_tenant_catalogue_key" ON "mcp_servers" USING btree ("tenant_id","catalogue_key");--> statement-breakpoint
-- ADR-0002 option B, step 1 (expand only). Before this split, `id` WAS the catalogue key for every row
-- the deployment wrote from the curated catalogue, so copying it across is a faithful restatement of
-- what each row already meant -- including the custom and brokered rows, whose "key" is their own id
-- because no curated entry names them. New writes decide the key explicitly; nothing reads this column
-- yet, which is why this migration can land before the code that uses it.
UPDATE "mcp_servers" SET "catalogue_key" = "id" WHERE "catalogue_key" IS NULL;
