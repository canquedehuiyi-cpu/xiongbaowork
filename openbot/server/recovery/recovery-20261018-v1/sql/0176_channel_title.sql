/*
 * 上游 0086：对话可以由本人改名（#1393），`channels.title` 存本人起的名字，空表示沿用自动生成的名字。
 */
ALTER TABLE "channels" ADD COLUMN "title" text;
