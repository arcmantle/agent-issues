import { Option } from "clipanion";

import {
	deleteTenant,
	ensureDatabase,
	listTenants,
	renameTenant,
	resolveDatabasePath,
	resolveTenantRootPath,
	resolveTenantSlug
} from "../../database.js";

import { renderCurrentTenant, renderDeleteTenant, renderRenameTenant, renderTenantList } from "../renderers.js";
import { MutableTenantCommand, TenantCommand, requirePositional } from "../shared.js";

export class InitCommand extends TenantCommand {
	public static paths = [["init"]];

	public async execute(): Promise<number> {
		const dbPath = resolveDatabasePath(this.dbPath, { tenant: this.tenant });
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		db.close();
		this.print(
			{
				command: "init",
				dbPath,
				status: "ok"
			},
			`Initialized data store at ${dbPath}`
		);
		return 0;
	}
}

export class CurrentTenantCommand extends TenantCommand {
	public static paths = [["current-tenant"]];

	public async execute(): Promise<number> {
		const result = {
			command: "current-tenant" as const,
			dbPath: resolveDatabasePath(this.dbPath, { tenant: this.tenant }),
			resolution: this.tenant ? ("explicit" as const) : ("derived" as const),
			tenantId: resolveTenantSlug({ tenant: this.tenant }),
			workspaceRoot: resolveTenantRootPath(this.context.cwd)
		};

		this.print(result, renderCurrentTenant(result));
		return 0;
	}
}

abstract class TenantAdminCommand extends MutableTenantCommand {
	public positionals = Option.Rest();
}

export class ListTenantsCommand extends TenantCommand {
	public static paths = [["list-tenants"]];

	public async execute(): Promise<number> {
		const { db, dbPath } = ensureDatabase(this.dbPath, {
			skipTenantBootstrap: true,
			tenant: this.tenant
		});

		try {
			const result = {
				command: "list-tenants" as const,
				currentTenantId: resolveTenantSlug({ tenant: this.tenant }),
				dbPath,
				tenants: listTenants(db)
			};

			this.print(result, renderTenantList(result));
			return 0;
		} finally {
			db.close();
		}
	}
}

export class DeleteTenantCommand extends TenantAdminCommand {
	public static paths = [["delete-tenant"]];

	public async execute(): Promise<number> {
		if (!this.force) {
			throw new Error("`delete-tenant` requires `--force`.");
		}

		const { db, dbPath } = ensureDatabase(this.dbPath, {
			skipTenantBootstrap: true,
			tenant: this.tenant
		});

		try {
			const rawTenantId = requirePositional(this.positionals, 0, "delete-tenant <tenantId> --force");
			const tenantId = resolveTenantSlug({ tenant: rawTenantId });
			const result = {
				command: "delete-tenant" as const,
				dbPath,
				...deleteTenant(db, tenantId)
			};

			this.print(result, renderDeleteTenant(result));
			return 0;
		} finally {
			db.close();
		}
	}
}

export class RenameTenantCommand extends TenantAdminCommand {
	public static paths = [["rename-tenant"]];

	public async execute(): Promise<number> {
		if (!this.force) {
			throw new Error("`rename-tenant` requires `--force`.");
		}

		const { db, dbPath } = ensureDatabase(this.dbPath, {
			skipTenantBootstrap: true,
			tenant: this.tenant
		});

		try {
			const rawPreviousTenantId = requirePositional(this.positionals, 0, "rename-tenant <tenantId> <newTenantId> --force");
			const rawNewTenantId = requirePositional(this.positionals, 1, "rename-tenant <tenantId> <newTenantId> --force");
			const previousTenantId = resolveTenantSlug({ tenant: rawPreviousTenantId });
			const newTenantId = resolveTenantSlug({ tenant: rawNewTenantId });
			const result = {
				command: "rename-tenant" as const,
				dbPath,
				...renameTenant(db, previousTenantId, newTenantId)
			};

			this.print(result, renderRenameTenant(result));
			return 0;
		} finally {
			db.close();
		}
	}
}
