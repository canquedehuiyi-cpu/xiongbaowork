-- Ticket 002 left this catalogue written by hand into the development database only, so every other
-- database this fork is installed into — a test database, a second deployment — fails the first time
-- somebody signs up: provisioning opens a subscription on plan `free`, and `subscriptions_plan_id_plans_id_fk`
-- refuses a row that was never seeded. The plan rows are deployment-owned, not tenant-owned (`plans` has
-- no tenant_id and no row-level security), so one seed serves every tenant.
INSERT INTO "plans" ("id", "name", "limits") VALUES
	('free', 'Free', '{"wakers": 2, "devices": 1, "customModels": false, "tasksPerMonth": 50}'),
	('pro', 'Pro', '{"wakers": 10, "devices": 5, "customModels": true, "tasksPerMonth": 1000}')
ON CONFLICT ("id") DO NOTHING;
