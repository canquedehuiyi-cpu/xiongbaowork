/*
 * 角色预设 (0204): the 45 宝小熊 role faces join the five expressions as named presets.
 *
 * WHAT THIS CHANGES. One check, and nothing else; migrations 0144 and 0203 are not touched.
 *
 * - `portraits_preset`: the check that names the faces a portrait may store grows from the five
 *   expressions (`naughty` 调皮, `cute` 可爱, `cool` 帅气, `happy` 开心, `sweet` 卖萌) to those
 *   five plus the 45 role faces (职业形象 01-05, 内置员工形象 01-05, OPC 员工形象 06-10). A
 *   role face is stored by its slug exactly like an expression is: the picture itself lives in
 *   the app bundle (`app/src/assets/brand/bao-presets/<slug>.png`), so no row grows and no
 *   existing row changes — every stored preset stays valid under the wider check.
 * - No backfill: no portrait stored a role face before this, because the route refused them.
 */
ALTER TABLE "public"."portraits" DROP CONSTRAINT "portraits_preset";
--> statement-breakpoint
ALTER TABLE "public"."portraits" ADD CONSTRAINT "portraits_preset" CHECK ("preset" IS NULL OR "preset" IN ('naughty', 'cute', 'cool', 'happy', 'sweet', 'doctor', 'teacher', 'chef', 'tech-engineer', 'financial-advisor', 'lawyer', 'construction-engineer', 'farmer', 'courier', 'pilot', 'firefighter', 'tour-guide', 'journalist', 'creative-designer', 'fitness-coach', 'general-manager', 'accountant', 'operations-director', 'designer', 'director', 'programmer', 'social-media-operator', 'actor', 'singer', 'product-manager', 'data-analyst', 'marketing-director', 'hr-manager', 'legal-advisor', 'customer-service-manager', 'founder-assistant', 'project-manager', 'admin-specialist', 'sales-consultant', 'business-development', 'customer-success', 'copywriter', 'brand-planner', 'ad-specialist', 'store-manager', 'live-stream-operator', 'private-domain-operator', 'automation-engineer', 'test-engineer', 'security-officer'));
