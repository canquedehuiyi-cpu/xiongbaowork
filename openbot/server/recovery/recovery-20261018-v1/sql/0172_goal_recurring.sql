/*
 * 上游 0081：职责（goal）可以重复执行。
 */
ALTER TABLE "responsibilities" ADD COLUMN "recurring" boolean DEFAULT false NOT NULL;
