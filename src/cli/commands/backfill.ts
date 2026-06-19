import { Option } from "clipanion";

import { backfillBodies, parseBackfillableBodyKinds } from "../../body-backfill.js";
import { ensureDatabase, listTenants } from "../../database.js";

import { renderBackfillBodies } from "../renderers.js";
import { MutableTenantCommand, parseCsvOption } from "../shared.js";

export class BackfillBodiesCommand extends MutableTenantCommand {
	public static paths = [["backfill-bodies"]];

	public allTenants = Option.Boolean("--all-tenants", false);
	public dryRun = Option.Boolean("--dry-run", false);
	public kinds = Option.String("--kinds");

	public async execute(): Promise<number> {
		if (this.allTenants && this.tenant) {
			throw new Error("`backfill-bodies --all-tenants` cannot be combined with `--tenant`.");
		}

		const { db, dbPath } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const kinds = parseBackfillableBodyKinds(parseCsvOption(this.kinds));
			const tenantIds = this.allTenants ? listTenants(db).map((tenant) => tenant.id) : [db.tenantId];
			const tenants = tenantIds.map((tenantId) => {
				if (tenantId === db.tenantId) {
					return backfillBodies(db, { dryRun: this.dryRun, force: this.force, kinds });
				}

				const { db: tenantDb } = ensureDatabase(this.dbPath, { tenant: tenantId });
				try {
					return backfillBodies(tenantDb, { dryRun: this.dryRun, force: this.force, kinds });
				} finally {
					tenantDb.close();
				}
			});

			const result = {
				command: "backfill-bodies" as const,
				dbPath,
				dryRun: this.dryRun,
				force: this.force,
				kinds,
				scope: this.allTenants ? ("all-tenants" as const) : ("current-tenant" as const),
				tenants
			};

			this.print(result, renderBackfillBodies(result));
			return 0;
		} finally {
			db.close();
		}
	}
}
