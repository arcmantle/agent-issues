import { sql } from "drizzle-orm";
import { foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const metadata = sqliteTable("metadata", {
	key: text("key").primaryKey(),
	value: text("value").notNull()
});

export const counters = sqliteTable(
	"counters",
	{
		tenantId: text("tenant_id").notNull(),
		kind: text("kind").notNull(),
		nextValue: integer("next_value").notNull()
	},
	(table) => [primaryKey({ columns: [table.tenantId, table.kind] })]
);

export const entities = sqliteTable(
	"entities",
	{
		tenantId: text("tenant_id").notNull(),
		id: text("id").notNull(),
		kind: text("kind").notNull(),
		title: text("title").notNull(),
		status: text("status").notNull(),
		body: text("body").notNull().default(""),
		bodySource: text("body_source").notNull().default("authored"),
		revision: integer("revision").notNull().default(1),
		contentHash: text("content_hash").notNull().default(""),
		tombstone: integer("tombstone", { mode: "boolean" }).notNull().default(false),
		projectId: text("project_id"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull()
	},
	(table) => [primaryKey({ columns: [table.tenantId, table.id] })]
);

export const relations = sqliteTable(
	"relations",
	{
		tenantId: text("tenant_id").notNull(),
		fromId: text("from_id").notNull(),
		toId: text("to_id").notNull(),
		type: text("type").notNull(),
		createdAt: text("created_at").notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.fromId, table.toId, table.type] }),
		foreignKey({
			columns: [table.tenantId, table.fromId],
			foreignColumns: [entities.tenantId, entities.id]
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.tenantId, table.toId],
			foreignColumns: [entities.tenantId, entities.id]
		}).onDelete("cascade"),
		index("relations_tenant_to_id_idx").on(table.tenantId, table.toId)
	]
);

export const contexts = sqliteTable(
	"contexts",
	{
		tenantId: text("tenant_id").notNull(),
		key: text("key").notNull(),
		scopeEntityId: text("scope_entity_id"),
		title: text("title").notNull(),
		summary: text("summary").notNull(),
		revision: integer("revision").notNull().default(1),
		contentHash: text("content_hash").notNull().default(""),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.key] }),
		foreignKey({
			columns: [table.tenantId, table.scopeEntityId],
			foreignColumns: [entities.tenantId, entities.id]
		}).onDelete("cascade"),
		uniqueIndex("contexts_tenant_scope_entity_id_idx")
			.on(table.tenantId, table.scopeEntityId)
			.where(sql`scope_entity_id IS NOT NULL`)
	]
);

export const contextTerms = sqliteTable(
	"context_terms",
	{
		tenantId: text("tenant_id").notNull(),
		contextKey: text("context_key").notNull(),
		term: text("term").notNull(),
		definition: text("definition").notNull(),
		avoidTerms: text("avoid_terms").notNull(),
		revision: integer("revision").notNull().default(1),
		contentHash: text("content_hash").notNull().default(""),
		tombstone: integer("tombstone", { mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.contextKey, table.term] }),
		foreignKey({
			columns: [table.tenantId, table.contextKey],
			foreignColumns: [contexts.tenantId, contexts.key]
		}).onDelete("cascade"),
		index("context_terms_tenant_context_key_idx").on(table.tenantId, table.contextKey)
	]
);

// Append-only audit log (ADR8/ADR16). Deliberately has NO foreign key to
// `entities`: a history entry must survive deletion of the entity it
// documents, so an audit trail remains queryable even for deleted entities.
// Only a whole-tenant wipe (deleteTenant) removes these rows, via an explicit
// DELETE alongside the other tenant-scoped tables.
export const historyEntries = sqliteTable(
	"history_entries",
	{
		id: text("id").primaryKey(),
		tenantId: text("tenant_id").notNull(),
		entityId: text("entity_id").notNull(),
		version: integer("version").notNull(),
		author: text("author").notNull(),
		title: text("title").notNull(),
		body: text("body").notNull(),
		bodySource: text("body_source").notNull(),
		status: text("status").notNull(),
		parentId: text("parent_id"),
		createdAt: text("created_at").notNull()
	},
	// Not unique (ISS57/ADR16): a synchronize merge can legitimately union two
	// history entries for the same entity at the same version number - the
	// concurrent-edit case, where both sides independently produced their own
	// next version with no shared latest. Both entries must remain queryable
	// (the losing one stays in history); only the entry's own `id` is unique.
	(table) => [index("history_entries_tenant_entity_version_idx").on(table.tenantId, table.entityId, table.version)]
);

// Append-only reverse-delta chain (ADR55/ISS257). Each row stores the
// predecessor title/body for one atomic title/body edit so ISS261's history
// materializer can walk back from the current head one step at a time.
// The UNIQUE constraint on (tenant_id, entity_id, revision) enforces the
// linear chain: one delta per revision per entity, no branches allowed.
export const entityDeltaEntries = sqliteTable(
	"entity_delta_entries",
	{
		id: text("id").primaryKey(),
		tenantId: text("tenant_id").notNull(),
		entityId: text("entity_id").notNull(),
		revision: integer("revision").notNull(),
		author: text("author").notNull(),
		priorTitle: text("prior_title").notNull(),
		priorBody: text("prior_body").notNull(),
		priorBodySource: text("prior_body_source").notNull(),
		priorStatus: text("prior_status"),
		priorParentId: text("prior_parent_id"),
		priorParentChanged: integer("prior_parent_changed", { mode: "boolean" }).notNull().default(false),
		priorTombstone: integer("prior_tombstone", { mode: "boolean" }),
		restoredFromRevision: integer("restored_from_revision"),
		createdAt: text("created_at").notNull()
	},
	(table) => [
		index("entity_delta_entries_tenant_entity_revision_idx").on(table.tenantId, table.entityId, table.revision),
		uniqueIndex("entity_delta_entries_tenant_id_entity_id_revision_key").on(table.tenantId, table.entityId, table.revision)
	]
);

// Append-only reverse-delta chain (ADR55/ISS259). Each row stores the
// predecessor title/summary for one atomic context title/summary edit.
// The UNIQUE constraint on (tenant_id, context_key, revision) enforces the
// linear chain: one delta per revision per context, no branches allowed.
export const contextDeltaEntries = sqliteTable(
	"context_delta_entries",
	{
		id: text("id").primaryKey(),
		tenantId: text("tenant_id").notNull(),
		contextKey: text("context_key").notNull(),
		revision: integer("revision").notNull(),
		author: text("author").notNull(),
		priorTitle: text("prior_title").notNull(),
		priorSummary: text("prior_summary").notNull(),
		restoredFromRevision: integer("restored_from_revision"),
		createdAt: text("created_at").notNull()
	},
	(table) => [
		index("context_delta_entries_tenant_key_revision_idx").on(table.tenantId, table.contextKey, table.revision),
		uniqueIndex("context_delta_entries_tenant_key_revision_key").on(table.tenantId, table.contextKey, table.revision)
	]
);

export const contextTermDeltaEntries = sqliteTable(
	"context_term_delta_entries",
	{
		id: text("id").primaryKey(),
		tenantId: text("tenant_id").notNull(),
		contextKey: text("context_key").notNull(),
		term: text("term").notNull(),
		revision: integer("revision").notNull(),
		author: text("author").notNull(),
		priorDefinition: text("prior_definition").notNull(),
		priorAvoidTerms: text("prior_avoid_terms").notNull(),
		priorTombstone: integer("prior_tombstone", { mode: "boolean" }).notNull(),
		restoredFromRevision: integer("restored_from_revision"),
		createdAt: text("created_at").notNull()
	},
	(table) => [
		index("context_term_delta_entries_tenant_term_revision_idx").on(table.tenantId, table.contextKey, table.term, table.revision),
		uniqueIndex("context_term_delta_entries_tenant_term_revision_key").on(table.tenantId, table.contextKey, table.term, table.revision)
	]
);

// Records that a legacy per-folder tenant (the old one-tenant-per-workspace
// scheme, ADR7) has already been folded into a `project` entity under a
// shared tenant (ISS63, correcting ISS34's incomplete migration). Keyed by
// the legacy tenant's own id so re-opening the same workspace - or re-running
// the explicit admin command against the same stray tenant id - is a no-op
// rather than creating a duplicate project.
export const projectMigrations = sqliteTable(
	"project_migrations",
	{
		tenantId: text("tenant_id").notNull(),
		legacyTenantId: text("legacy_tenant_id").notNull(),
		projectId: text("project_id").notNull(),
		createdAt: text("created_at").notNull()
	},
	(table) => [primaryKey({ columns: [table.tenantId, table.legacyTenantId] })]
);

export const schema = {
	metadata,
	counters,
	entities,
	relations,
	contexts,
	contextTerms,
	contextDeltaEntries,
	contextTermDeltaEntries,
	historyEntries,
	entityDeltaEntries,
	projectMigrations
};

export type EntityRow = typeof entities.$inferSelect;
export type RelationRow = typeof relations.$inferSelect;
export type ContextRow = typeof contexts.$inferSelect;
export type ContextTermRow = typeof contextTerms.$inferSelect;
export type ContextDeltaEntryRow = typeof contextDeltaEntries.$inferSelect;
export type ContextTermDeltaEntryRow = typeof contextTermDeltaEntries.$inferSelect;
export type CounterRow = typeof counters.$inferSelect;
export type MetadataRow = typeof metadata.$inferSelect;
export type HistoryEntryRow = typeof historyEntries.$inferSelect;
export type EntityDeltaEntryRow = typeof entityDeltaEntries.$inferSelect;
export type ProjectMigrationRow = typeof projectMigrations.$inferSelect;
