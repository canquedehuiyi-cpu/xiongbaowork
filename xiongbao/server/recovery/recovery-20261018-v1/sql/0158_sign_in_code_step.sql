/*
 * 私密登录先问密码、网站要验证码时再问（上游 0056，#780）：`sign_in_requests.status` 允许
 * `code_required`。本分叉的约束与上游 0056 之前相同（drizzle 0049），所以原样放宽。
 */
ALTER TABLE "sign_in_requests" DROP CONSTRAINT "sign_in_requests_status_check";--> statement-breakpoint
ALTER TABLE "sign_in_requests" ADD CONSTRAINT "sign_in_requests_status_check" CHECK ("sign_in_requests"."status" IN ('pending', 'filling', 'code_required', 'taken_over', 'signed_in', 'failed', 'cancelled', 'expired'));
