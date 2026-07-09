-- Cloud-tier isolation (ADR9): enable Postgres RLS as defense-in-depth on
-- every tenant-scoped table, keyed on a per-transaction
-- SET LOCAL app.tenant_id (checked via current_setting('app.tenant_id', true)).
-- App-layer `WHERE tenant_id` filtering in PgStore remains in place; RLS
-- backstops a forgotten filter. `metadata` carries no tenant_id and is
-- intentionally excluded - it is not tenant-scoped.
--
-- FORCE ROW LEVEL SECURITY so the isolation also applies to the table
-- owner/connection role the API itself uses - RLS is otherwise bypassed
-- for the owner by default, which would defeat the "never solely the API"
-- guarantee (ADR9).
--> statement-breakpoint
ALTER TABLE "counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "counters" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "counters" USING ("tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "entities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "entities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "entities" USING ("tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "relations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "relations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "relations" USING ("tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "contexts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "contexts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contexts" USING ("tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "context_terms" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "context_terms" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "context_terms" USING ("tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "handoffs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "handoffs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "handoffs" USING ("tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "history_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "history_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "history_entries" USING ("tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true));
