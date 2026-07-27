import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import type { SourceProfileResult } from "@agent-issues/core";
import type { SqliteInternalConnection } from "./sqlite-executor.js";

type SchemaObject = {
	name: string;
	sql: string | null;
	type: string;
};

type LedgerColumn = {
	cid: number;
	dflt_value: string | null;
	name: string;
	notnull: number;
	pk: number;
	type: string;
};

type LedgerIndex = {
	origin: string;
	partial: number;
	unique: number;
};

const LEGACY_V7_SCHEMA_SIGNATURES = new Set([
	"c0efb8fd9cb7f1fffcf946eb63c325e5b595a48ea6fdeca1dab3bbc08989b723",
	"ce2a73dc63ee1baeb7a53be50f5117cbacf46e70791cd80f98c1d25bf3d26685"
]);

const CURRENT_FINAL_SCHEMA_SIGNATURE = "50d7513e53b59d56788432fd20496ec41eaf468627853792af78ee8feb5ba2c9";
const DIRECT_FINAL_SCHEMA_SIGNATURE = "892a43c929f85fd4f71f334c02aa664bc7e8a5f2203929654a10e11229d541ff";

export function inspectSqliteSourceProfile(database: SqliteInternalConnection, expectedLedgerIds: string[]): SourceProfileResult {
	const schemaObjects = database.drizzle.all<SchemaObject>(
		sql`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
	);
	const applicationObjects = schemaObjects.filter(({ name }) => name !== "schema_migrations");
	const schemaSignature = createHash("sha256").update(JSON.stringify(schemaObjects)).digest("hex");
	const finalSchemaSignature = createHash("sha256")
		.update(JSON.stringify(schemaObjects
			.filter(({ name }) => !name.startsWith("legacy_v7_"))
			.map((object) => object.name === "schema_migrations"
				? { ...object, sql: object.sql?.replace("CREATE TABLE schema_migrations", "CREATE TABLE IF NOT EXISTS schema_migrations") ?? null }
				: object)))
		.digest("hex");
	const ledgerMetadata = schemaObjects.find(({ name }) => name === "schema_migrations");
	const ledgerShapeMismatch = ledgerMetadata === undefined
		? undefined
		: ledgerMetadata.type === "table"
			? inspectLedgerShape(database)
			: `migration ledger metadata must be a table, found ${ledgerMetadata.type}: ${JSON.stringify(ledgerMetadata)}`;
	const ledgerIds = ledgerMetadata !== undefined
		? ledgerShapeMismatch === undefined
			? database.drizzle.all<{ id: string }>(sql`SELECT id FROM schema_migrations ORDER BY rowid`).map(({ id }) => id)
			: []
		: [];
	const evidence = { dialect: "sqlite" as const, ledgerIds, schemaSignature };
	if (ledgerShapeMismatch !== undefined) {
		return unsupported(evidence, applicationObjects, ledgerShapeMismatch);
	}

	if (applicationObjects.length === 0 && ledgerMetadata === undefined) {
		return { evidence, profile: "empty", supported: true };
	}
	if (LEGACY_V7_SCHEMA_SIGNATURES.has(schemaSignature) && ledgerMetadata === undefined) {
		return { evidence, profile: "legacy-sqlite-v7", supported: true };
	}
	if (schemaSignature === CURRENT_FINAL_SCHEMA_SIGNATURE && ledgerIds.join("\0") === expectedLedgerIds.join("\0")) {
		return { evidence, profile: "current-final", supported: true };
	}
	if (finalSchemaSignature === DIRECT_FINAL_SCHEMA_SIGNATURE
		&& !schemaObjects.some(({ name }) => name.startsWith("legacy_v7_"))
		&& ledgerIds.length === 1
		&& ledgerIds[0] === "legacy-v7-direct") {
		return { evidence, profile: "current-final", supported: true };
	}

	return unsupported(evidence, applicationObjects);
}

function inspectLedgerShape(database: SqliteInternalConnection): string | undefined {
	const columns = database.drizzle.all<LedgerColumn>(sql.raw("PRAGMA table_info('schema_migrations')"));
	const indexes = database.drizzle.all<LedgerIndex>(sql.raw("PRAGMA index_list('schema_migrations')"));
	const foreignKeys = database.drizzle.all(sql.raw("PRAGMA foreign_key_list('schema_migrations')"));
	const expectedColumns = [
		{ cid: 0, dflt_value: null, name: "id", notnull: 0, pk: 1, type: "TEXT" },
		{ cid: 1, dflt_value: null, name: "applied_at", notnull: 1, pk: 0, type: "TEXT" }
	];
	const hasCanonicalPrimaryKey = indexes.length === 1
		&& indexes[0]?.origin === "pk"
		&& indexes[0].partial === 0
		&& indexes[0].unique === 1;
	const hasCanonicalColumns = columns.length === expectedColumns.length
		&& columns.every((column, index) => {
			const expected = expectedColumns[index];
			return expected !== undefined
				&& column.cid === expected.cid
				&& column.dflt_value === expected.dflt_value
				&& column.name === expected.name
				&& column.notnull === expected.notnull
				&& column.pk === expected.pk
				&& column.type === expected.type;
		});
	if (hasCanonicalColumns && hasCanonicalPrimaryKey && foreignKeys.length === 0) {
		return undefined;
	}
	return `migration ledger shape does not match required columns, nullability, defaults, primary key, and constraints: ${JSON.stringify({ columns, foreignKeys, indexes })}`;
}

function unsupported(
	evidence: SourceProfileResult["evidence"],
	applicationObjects: SchemaObject[],
	ledgerShapeMismatch?: string
): SourceProfileResult {
	return {
		evidence,
		profile: "unsupported",
		reasons: [
			...(ledgerShapeMismatch === undefined ? [] : [ledgerShapeMismatch]),
			`schema signature ${evidence.schemaSignature} from objects: ${applicationObjects.map(({ name }) => name).join(", ") || "none"}`,
			`ordered schema_migrations IDs: ${evidence.ledgerIds.join(", ") || "none"}`
		],
		recoveryPaths: [
			"Keep the source unchanged and take a byte-for-byte copy for inspection.",
			"Repair and verify a copy manually, or start with an empty database."
		],
		supported: false
	};
}