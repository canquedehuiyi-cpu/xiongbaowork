/*
 * 上游 0076（#999）：每段对话可以选内置员工用的模型。
 */
ALTER TABLE "intelligence_channel_mappings" ADD COLUMN "model_selection" jsonb;
