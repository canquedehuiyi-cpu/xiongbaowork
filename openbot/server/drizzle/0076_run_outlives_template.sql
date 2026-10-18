ALTER TABLE "group_task_runs" DROP CONSTRAINT "group_task_runs_template_id_group_task_templates_id_fk";
--> statement-breakpoint
ALTER TABLE "group_task_runs" ALTER COLUMN "template_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "group_task_runs" ADD CONSTRAINT "group_task_runs_template_id_group_task_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."group_task_templates"("id") ON DELETE set null ON UPDATE no action;