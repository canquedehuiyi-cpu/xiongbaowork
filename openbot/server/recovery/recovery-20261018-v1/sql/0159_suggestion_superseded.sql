/*
 * 上游 0061（#929）：建议可以被新的取代，`proactive_suggestions.status` 允许 `superseded`。
 */
ALTER TABLE "proactive_suggestions" DROP CONSTRAINT "proactive_suggestions_status_check";--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD CONSTRAINT "proactive_suggestions_status_check" CHECK ("proactive_suggestions"."status" IN ('open', 'dismissed', 'started', 'superseded'));
