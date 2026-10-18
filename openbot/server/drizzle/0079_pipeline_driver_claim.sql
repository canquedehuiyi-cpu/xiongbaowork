ALTER TABLE "group_task_runs" ADD COLUMN "advance_owner" text;
--> statement-breakpoint
ALTER TABLE "group_task_runs" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;
