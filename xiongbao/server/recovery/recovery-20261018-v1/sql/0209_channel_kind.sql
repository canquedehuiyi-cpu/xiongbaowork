-- P4-4b（能力与资源页面并联第二批）：`channels.kind` 团队标记落库。
--
-- 一个包的专家团（`teams.yaml`）物化为 `channels` 行，和 `channels.yaml` 的普通对话落同一张表
-- ——复用就是设计。但 `engineering` 也挂三个员工，不加标记的话资源页分不清团队与多员工对话。
-- 装包同步按声明来源写 `team` / `channel`；列默认 `channel`，旧部署在下次同步时被盖上真话。
ALTER TABLE "channels" ADD COLUMN "kind" text NOT NULL DEFAULT 'channel';
