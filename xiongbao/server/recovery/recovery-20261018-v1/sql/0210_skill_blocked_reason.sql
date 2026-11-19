-- P5+（L4-1 人工验收「点开有原因」）：skills 表补 blocked 档位的原因与引文。
--
-- `runnable` 徽章（0208）只回答"能不能跑"，R18 要求的是"点进去能看到缺什么"：规则 id 给
-- 运维与测试按名检索，引文给用户一句人话（"正文给出可执行的 shell 命令… ← \"git init …\""）。
-- 包同步从 `_porting.reason` / `_porting.reason_ref` 原样搬运；`full` 与人工写的技能保持
-- null——null 是"没审过"，不是"没原因"。
ALTER TABLE "skills" ADD COLUMN "blocked_reason" text;
ALTER TABLE "skills" ADD COLUMN "blocked_reason_ref" text;
