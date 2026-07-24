import { formatTenantDisplayName, sanitizePathSegment, type Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

type ProjectMigrationRow = {
	tenant_id: string;
	legacy_tenant_id: string;
	project_id: string;
};

type ProjectRow = {
	tenant_id: string;
	id: string;
	title: string;
};

export const removeProjectMigrationLedgersMigration: Migration = {
	id: "0030-remove-project-migration-ledgers",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("Project migration ledger removal requires the SQLite dialect.");
		}

		const mappings = await conn.all<ProjectMigrationRow>(sql`SELECT tenant_id, legacy_tenant_id, project_id FROM project_migrations`);
		const projects = await conn.all<ProjectRow>(sql`SELECT tenant_id, id, title FROM entities WHERE kind = 'project' AND tombstone = 0`);
		for (const mapping of mappings) {
			const selector = sanitizePathSegment(formatTenantDisplayName(mapping.legacy_tenant_id));
			const matches = projects.filter(
				(project) => project.tenant_id === mapping.tenant_id && sanitizePathSegment(project.title) === selector
			);
			if (matches.length !== 1 || matches[0]!.id !== mapping.project_id) {
				throw new Error(`Cannot uniquely preserve project mapping for ${mapping.legacy_tenant_id}.`);
			}
		}

		await conn.run(sql`DROP TABLE project_migrations`);
		await conn.run(sql`DROP TABLE IF EXISTS __drizzle_migrations`);
	}
};