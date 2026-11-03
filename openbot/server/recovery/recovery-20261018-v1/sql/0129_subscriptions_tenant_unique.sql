/*
 * One subscription row per tenant (audit defect #7, remainder).
 *
 * `subscriptions` had only a plain index on `tenant_id`, so nothing stopped a tenant from holding two
 * rows: provisioning read "no row yet" and then inserted, so two first calls racing (the user-create
 * hook and the organization store, or a retried hook) both wrote a Free row; and a plan switch on a
 * workspace whose only row was canceled inserted a second row beside it. The quota and model-pool
 * readers resolved duplicates by ordering, but the administrator's tenant list joins on `tenant_id`
 * and listed such a tenant twice, and every reader had to repeat the same tie-break to agree.
 *
 * WHICH ROW IS KEPT. Per tenant, the row every reader already resolves to: the most recent ACTIVE row
 * (`updated_at` desc, then `created_at` desc, then `id` desc, the order `quota/limits.ts` and
 * `models/runtime-resolver.ts` read with). A tenant with no active row keeps its most recent canceled
 * one by the same order; both readers answer Free for it before and after, because they read only
 * active rows. So no tenant's effective plan changes: the rows removed are exactly the ones no reader
 * could ever pick. Nothing references `subscriptions.id` (no foreign key points at it), and each plan
 * switch already left its own `plan.changed` audit row, so the removed duplicates carry no history
 * that is not kept elsewhere.
 *
 * Then `subscriptions_tenant_unique` makes a second row impossible; the application now provisions
 * with ON CONFLICT (tenant_id) DO NOTHING and switches plans with ON CONFLICT (tenant_id) DO UPDATE.
 * The plain index is dropped because the constraint's own index serves every `tenant_id` lookup it did.
 *
 * WHY THE FRAME. `subscriptions` has FORCE ROW LEVEL SECURITY (0053/0059), which binds the table owner
 * too: with no `app.tenant_id` the DELETE policy (0072) admits no row, the DELETE would remove nothing,
 * and the constraint below would then fail on the first duplicate. The platform writer is admitted for
 * every row, so the data statement runs as `platform`; the setting is transaction-local and is
 * cleared at the end, because the migrator applies every pending migration in one transaction. A
 * superuser or BYPASSRLS migrator is unaffected by the frame and removes the same rows.
 */
SELECT set_config('app.tenant_id', 'platform', true);
--> statement-breakpoint
DELETE FROM public.subscriptions s
 USING (
   SELECT id,
          row_number() OVER (
            PARTITION BY tenant_id
            ORDER BY (status = 'active') DESC, updated_at DESC, created_at DESC, id DESC
          ) AS position
     FROM public.subscriptions
 ) ranked
 WHERE s.id = ranked.id
   AND ranked.position > 1;
--> statement-breakpoint
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_tenant_unique UNIQUE (tenant_id);
--> statement-breakpoint
DROP INDEX IF EXISTS public.subscriptions_tenant_idx;
--> statement-breakpoint
SELECT set_config('app.tenant_id', '', true);
