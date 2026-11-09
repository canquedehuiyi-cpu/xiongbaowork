/*
 * 上游 0063：按对话查未完成工作项的索引。
 */
CREATE INDEX "work_items_open_thread_idx" ON "work_items" USING btree ("kind",("payload"->>'threadId')) WHERE "work_items"."finished_at" IS NULL;
