-- P4（能力与资源页面并联）数据链第二环：`skills.runnable` 落库。
--
-- `skills.yaml` 每条技能的 `runnable` 档位（`full | degraded | blocked`，移植方案 R3）在
-- 装包同步时写进这一列；徽章从列表 API 读它。null 是诚实值而不是遗漏：一个员工在这里写的
-- 技能从没被移植审计过，徽章读 null 画「未评估」。
ALTER TABLE "skills" ADD COLUMN "runnable" text;
