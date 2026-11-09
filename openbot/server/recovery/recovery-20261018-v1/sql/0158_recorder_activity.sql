/*
 * 上游 0067：Recorder 连接的最近活动。
 */
ALTER TABLE "recorder_connections" ADD COLUMN "activity" jsonb;--> statement-breakpoint
ALTER TABLE "recorder_connections" ADD COLUMN "activity_at" timestamp with time zone;
