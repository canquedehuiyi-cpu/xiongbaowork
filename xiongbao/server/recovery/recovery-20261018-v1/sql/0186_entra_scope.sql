/*
 * 上游 0073（#931）：以登录人身份访问的自定义 MCP 服务器。
 *
 * `entra_scope` 是管理员给按 URL 添加的服务器标的 Microsoft Entra scope（例如
 * `api://hr-api/.default`）。有值时，每次调用都用 Entra 代表提问人换来的 token（OBO），不再用部署
 * 保存的凭据；为空就是原来的样子。可空、无回填：这之前没有服务器被这样标记。
 *
 * 只加一列，不新增表；`mcp_servers` 现有的 tenant_id、RLS 策略和授权不变，这一列随行受同样的约束。
 */
ALTER TABLE "public"."mcp_servers" ADD COLUMN IF NOT EXISTS "entra_scope" text;
