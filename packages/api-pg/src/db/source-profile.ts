import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import type { SourceProfileResult } from "@agent-issues/core";

const CURRENT_FINAL_SCHEMA_SIGNATURE = "7338aea98e85ac93de5fcfc938d424ba8aa7a75727be17e9bfc39a57c425cde8";
const LEGACY_V7_SCHEMA_SIGNATURE = "a56ad7487ddca6b9095b9af7e197da17507f541bd714b627e70cedca54e5f2da";

type CatalogColumn = {
	column_default: string | null;
	column_name: string;
	data_type: string;
	is_nullable: string;
	ordinal_position: number;
	table_name: string;
	udt_name: string;
};

type CatalogConstraint = {
	constraint_name: string;
	constraint_type: string;
	definition: string;
	table_name: string;
};

type SchemaObject = {
	object_kind: string;
	object_name: string;
};

/**
 * Rewrites schema-qualified references (`public.entities`) so the same schema
 * hashes identically wherever it is installed - production runs in `public`,
 * the migration tests each create their own schema.
 *
 * Only the fields that can carry a qualified name are rewritten. Replacing the
 * schema name throughout the serialized catalog instead also rewrites values
 * that merely happen to equal it: `pg_policies.roles` is `{public}` for a
 * policy with no explicit `TO` clause, which every `tenant_isolation` policy
 * here relies on, so an install in `public` hashed differently from an
 * identical one in a test schema and was rejected as an unsupported profile.
 */
function normalizeSchemaReferences(value: string | null, schemaName: string): string | null {
	return value === null ? null : value.split(`${schemaName}.`).join("<current_schema>.");
}

export async function inspectPgSourceProfile(client: Pick<PoolClient, "query">, expectedLedgerIds: string[]): Promise<SourceProfileResult> {
	const schemaResult = await client.query<{ current_schema: string }>("SELECT current_schema() AS current_schema");
	const schemaName = schemaResult.rows[0]?.current_schema ?? "public";
	const objects = await client.query<SchemaObject>(
		`SELECT object_kind, object_name FROM (
			SELECT CASE relation.relkind
				WHEN 'r' THEN 'table'
				WHEN 'p' THEN 'partitioned table'
				WHEN 'v' THEN 'view'
				WHEN 'm' THEN 'materialized view'
				WHEN 'S' THEN 'sequence'
				WHEN 'f' THEN 'foreign table'
			END AS object_kind, relation.relname AS object_name
			FROM pg_class AS relation
			JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = $1 AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_class'::regclass
						AND dependency.objid = relation.oid AND dependency.deptype = 'e'
				)
				AND (relation.relkind <> 'S' OR NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_class'::regclass
						AND dependency.objid = relation.oid AND dependency.deptype IN ('a', 'i')
				))
			UNION ALL
			SELECT 'function', procedure.proname || '(' || pg_get_function_identity_arguments(procedure.oid) || ')'
			FROM pg_proc AS procedure
			JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_proc'::regclass
						AND dependency.objid = procedure.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT CASE type_row.typtype
				WHEN 'c' THEN 'composite type'
				WHEN 'd' THEN 'domain'
				WHEN 'e' THEN 'enum type'
				WHEN 'm' THEN 'multirange type'
				WHEN 'r' THEN 'range type'
			END, type_row.typname
			FROM pg_type AS type_row
			JOIN pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
			LEFT JOIN pg_class AS relation ON relation.oid = type_row.typrelid
			WHERE namespace.nspname = $1
				AND (type_row.typtype IN ('d', 'e', 'm', 'r') OR (type_row.typtype = 'c' AND relation.relkind = 'c'))
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_type'::regclass
						AND dependency.objid = type_row.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'collation', collation_row.collname
			FROM pg_collation AS collation_row
			JOIN pg_namespace AS namespace ON namespace.oid = collation_row.collnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_collation'::regclass
						AND dependency.objid = collation_row.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'conversion', conversion_row.conname
			FROM pg_conversion AS conversion_row
			JOIN pg_namespace AS namespace ON namespace.oid = conversion_row.connamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_conversion'::regclass
						AND dependency.objid = conversion_row.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'text search configuration', configuration.cfgname
			FROM pg_ts_config AS configuration
			JOIN pg_namespace AS namespace ON namespace.oid = configuration.cfgnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_ts_config'::regclass
						AND dependency.objid = configuration.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'text search dictionary', dictionary.dictname
			FROM pg_ts_dict AS dictionary
			JOIN pg_namespace AS namespace ON namespace.oid = dictionary.dictnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_ts_dict'::regclass
						AND dependency.objid = dictionary.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'text search parser', parser.prsname
			FROM pg_ts_parser AS parser
			JOIN pg_namespace AS namespace ON namespace.oid = parser.prsnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_ts_parser'::regclass
						AND dependency.objid = parser.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'text search template', template.tmplname
			FROM pg_ts_template AS template
			JOIN pg_namespace AS namespace ON namespace.oid = template.tmplnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_ts_template'::regclass
						AND dependency.objid = template.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'operator', operator_row.oprname || '(' ||
				CASE WHEN operator_row.oprleft = 0 THEN 'NONE' ELSE format_type(operator_row.oprleft, NULL) END || ', ' ||
				CASE WHEN operator_row.oprright = 0 THEN 'NONE' ELSE format_type(operator_row.oprright, NULL) END || ')'
			FROM pg_operator AS operator_row
			JOIN pg_namespace AS namespace ON namespace.oid = operator_row.oprnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_operator'::regclass
						AND dependency.objid = operator_row.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'operator class', operator_class.opcname
			FROM pg_opclass AS operator_class
			JOIN pg_namespace AS namespace ON namespace.oid = operator_class.opcnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_opclass'::regclass
						AND dependency.objid = operator_class.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'operator family', operator_family.opfname
			FROM pg_opfamily AS operator_family
			JOIN pg_namespace AS namespace ON namespace.oid = operator_family.opfnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_opfamily'::regclass
						AND dependency.objid = operator_family.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'extension', extension.extname
			FROM pg_extension AS extension
			JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
			WHERE namespace.nspname = $1
		) AS schema_objects
		ORDER BY object_kind, object_name`,
		[schemaName]
	);
	const tables = await client.query(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = $1 AND table_type = 'BASE TABLE'
		 ORDER BY table_name`,
		[schemaName]
	);
	const columns = await client.query<CatalogColumn>(
		`SELECT table_name, column_name, ordinal_position, data_type, udt_name, is_nullable, column_default
		 FROM information_schema.columns
		 WHERE table_schema = $1
		 ORDER BY table_name, ordinal_position`,
		[schemaName]
	);
	const constraints = await client.query<CatalogConstraint>(
		`SELECT relation.relname AS table_name, constraint_row.conname AS constraint_name,
			constraint_row.contype AS constraint_type, pg_get_constraintdef(constraint_row.oid, true) AS definition
		 FROM pg_constraint AS constraint_row
		 JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
		 JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		 WHERE namespace.nspname = $1
		 ORDER BY relation.relname, constraint_row.conname`,
		[schemaName]
	);
	const indexes = await client.query(
		`SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition
		 FROM pg_indexes WHERE schemaname = $1
		 ORDER BY tablename, indexname`,
		[schemaName]
	);
	const policies = await client.query(
		`SELECT tablename AS table_name, policyname AS policy_name, permissive, roles, cmd, qual, with_check
		 FROM pg_policies WHERE schemaname = $1 ORDER BY tablename, policyname`,
		[schemaName]
	);
	const tableSecurity = await client.query(
		`SELECT relation.relname AS table_name, relation.relrowsecurity, relation.relforcerowsecurity
		 FROM pg_class AS relation
		 JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		 WHERE namespace.nspname = $1 AND relation.relkind = 'r'
		 ORDER BY relation.relname`,
		[schemaName]
	);
	const canonicalCatalog = JSON.stringify({
		columns: columns.rows.map((row) => ({ ...row, column_default: normalizeSchemaReferences(row.column_default, schemaName) })),
		constraints: constraints.rows,
		indexes: indexes.rows.map((row) => ({ ...row, definition: normalizeSchemaReferences(row.definition, schemaName) })),
		objects: objects.rows,
		policies: policies.rows,
		tableSecurity: tableSecurity.rows,
		tables: tables.rows
	});
	const schemaSignature = createHash("sha256").update(canonicalCatalog).digest("hex");
	const ledgerExists = await client.query<{ exists: boolean }>(
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = $1 AND table_name = 'schema_migrations' AND table_type = 'BASE TABLE'
		) AS exists`,
		[schemaName]
	);
	const hasLedger = ledgerExists.rows[0]?.exists === true;
	const ledgerShapeMismatch = hasLedger ? inspectLedgerShape(columns.rows, constraints.rows) : undefined;
	const ledgerIds = hasLedger
		? ledgerShapeMismatch === undefined
			? (await client.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY applied_at, id")).rows.map(({ id }) => id)
			: []
		: [];
	const evidence = { dialect: "postgres" as const, ledgerIds, schemaSignature };
	if (ledgerShapeMismatch !== undefined) {
		return unsupported(evidence, objects.rows, ledgerShapeMismatch);
	}

	const applicationObjects = objects.rows.filter(({ object_kind, object_name }) => object_kind !== "table" || object_name !== "schema_migrations");
	if (applicationObjects.length === 0 && !hasLedger) {
		return { evidence, profile: "empty", supported: true };
	}
	if (schemaSignature === LEGACY_V7_SCHEMA_SIGNATURE && !hasLedger) {
		return { evidence, profile: "legacy-postgres-v7", supported: true };
	}
	if (schemaSignature === CURRENT_FINAL_SCHEMA_SIGNATURE && ledgerIds.length === 1 && expectedLedgerIds.includes(ledgerIds[0]!)) {
		return { evidence, profile: "current-final", supported: true };
	}
	return unsupported(evidence, applicationObjects);
}

function inspectLedgerShape(columns: CatalogColumn[], constraints: CatalogConstraint[]): string | undefined {
	const ledgerColumns = columns.filter(({ table_name }) => table_name === "schema_migrations");
	const ledgerConstraints = constraints.filter(({ table_name }) => table_name === "schema_migrations");
	const expectedColumns = [
		{ column_default: null, column_name: "id", data_type: "text", is_nullable: "NO", ordinal_position: 1, table_name: "schema_migrations", udt_name: "text" },
		{ column_default: "now()", column_name: "applied_at", data_type: "timestamp with time zone", is_nullable: "NO", ordinal_position: 2, table_name: "schema_migrations", udt_name: "timestamptz" }
	];
	const hasCanonicalPrimaryKey = ledgerConstraints.length === 1
		&& ledgerConstraints[0]?.constraint_type === "p"
		&& ledgerConstraints[0].definition === "PRIMARY KEY (id)";
	const hasCanonicalColumns = ledgerColumns.length === expectedColumns.length
		&& ledgerColumns.every((column, index) => {
			const expected = expectedColumns[index];
			return expected !== undefined
				&& column.column_default === expected.column_default
				&& column.column_name === expected.column_name
				&& column.data_type === expected.data_type
				&& column.is_nullable === expected.is_nullable
				&& column.ordinal_position === expected.ordinal_position
				&& column.table_name === expected.table_name
				&& column.udt_name === expected.udt_name;
		});
	if (hasCanonicalColumns && hasCanonicalPrimaryKey) {
		return undefined;
	}
	return `migration ledger shape does not match required columns, nullability, defaults, primary key, and constraints: ${JSON.stringify({ columns: ledgerColumns, constraints: ledgerConstraints })}`;
}

function unsupported(
	evidence: SourceProfileResult["evidence"],
	objects: SchemaObject[],
	ledgerShapeMismatch?: string
): SourceProfileResult {
	return {
		evidence,
		profile: "unsupported",
		reasons: [
			...(ledgerShapeMismatch === undefined ? [] : [ledgerShapeMismatch]),
			`schema signature ${evidence.schemaSignature} from objects: ${objects.map(({ object_kind, object_name }) => `${object_kind} ${object_name}`).join(", ") || "none"}`,
			`ordered schema_migrations IDs: ${evidence.ledgerIds.join(", ") || "none"}`
		],
		recoveryPaths: [
			"Keep the source unchanged and capture its catalog and row-count evidence.",
			"Repair and verify a copy manually, or migrate an empty schema."
		],
		supported: false
	};
}