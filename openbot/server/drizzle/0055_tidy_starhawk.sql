CREATE TABLE "thread_run_events" (
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_run_events_thread_id_run_id_seq_pk" PRIMARY KEY("thread_id","run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "thread_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"parent_run_id" text,
	"event_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
	"agent_id" text NOT NULL,
	"name" text,
	"messages_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thread_run_events" ADD CONSTRAINT "thread_run_events_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_runs" ADD CONSTRAINT "thread_runs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_run_events_thread_idx" ON "thread_run_events" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "thread_runs_thread_idx" ON "thread_runs" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "threads_tenant_created_idx" ON "threads" USING btree ("tenant_id","created_at");