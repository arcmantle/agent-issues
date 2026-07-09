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

export const handoffs = sqliteTable(
	"handoffs",
	{
		tenantId: text("tenant_id").notNull(),
		id: text("id").notNull(),
		entityId: text("entity_id").notNull(),
		initiativeId: text("initiative_id"),
		summary: text("summary").notNull().default(""),
		body: text("body").notNull(),
		createdAt: text("created_at").notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.id] }),
		foreignKey({
			columns: [table.tenantId, table.entityId],
			foreignColumns: [entities.tenantId, entities.id]
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.tenantId, table.initiativeId],
			foreignColumns: [entities.tenantId, entities.id]
		}).onDelete("cascade"),
		index("handoffs_tenant_initiative_id_idx").on(table.tenantId, table.initiativeId),
		index("handoffs_tenant_entity_id_idx").on(table.tenantId, table.entityId)
	]
);

export const schema = {
	metadata,
	counters,
	entities,
	relations,
	contexts,
	contextTerms,
	handoffs
};

export type EntityRow = typeof entities.$inferSelect;
export type RelationRow = typeof relations.$inferSelect;
export type ContextRow = typeof contexts.$inferSelect;
export type ContextTermRow = typeof contextTerms.$inferSelect;
export type HandoffRow = typeof handoffs.$inferSelect;
export type CounterRow = typeof counters.$inferSelect;
export type MetadataRow = typeof metadata.$inferSelect;
