import { Option } from "clipanion";

import { ensureDatabase } from "../../database.js";
import { isEntityKind } from "../../domain.js";
import {
	archiveEntity,
	createEntity,
	deleteEntity,
	getEntityDetails,
	getInitiativeBundle,
	linkEntities,
	listEntities,
	listOrphans,
	moveEntity,
	setEntityBody,
	unlinkEntities,
	updateEntityStatus
} from "../../store.js";

import { renderEntityDetails, renderEntityList, renderInitiativeBundle, renderOptionalEntityList } from "../renderers.js";
import { BodyTenantCommand, TenantCommand, requireOption, requirePositional } from "../shared.js";

abstract class PositionalsTenantCommand extends TenantCommand {
	public positionals = Option.Rest();
}

export class CreateCommand extends BodyTenantCommand {
	public static paths = [["create"]];

	public parent = Option.String("--parent");
	public positionals = Option.Rest();
	public statusValue = Option.String("--status");
	public title = Option.String("--title");

	public async execute(): Promise<number> {
		const kind = requirePositional(this.positionals, 0, "create <kind>");
		if (!isEntityKind(kind)) {
			throw new Error(`Unknown entity kind: ${kind}`);
		}

		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const entity = createEntity(db, {
				body: this.resolveBody(),
				kind,
				parentId: this.parent,
				status: this.statusValue,
				title: requireOption(this.title, "--title is required for create.")
			});

			this.print(entity, `${entity.id} ${entity.kind} ${entity.status} ${entity.title}`);
			return 0;
		} finally {
			db.close();
		}
	}
}

export class EditCommand extends BodyTenantCommand {
	public static paths = [["edit"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const entityId = requirePositional(this.positionals, 0, "edit <id> (--body <markdown> | --body-file <path|->)");
			const entity = setEntityBody(db, {
				body: this.requireBody("--body or --body-file is required for edit."),
				entityId
			});

			this.print(entity, `Updated body for ${entity.id} ${entity.kind} ${entity.title}`);
			return 0;
		} finally {
			db.close();
		}
	}
}

export class ArchiveCommand extends PositionalsTenantCommand {
	public static paths = [["archive"]];

	public async execute(): Promise<number> {
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const entityId = requirePositional(this.positionals, 0, "archive <id>");
			const result = archiveEntity(db, { entityId });

			this.print(result, `Archived ${result.entity.id} from ${result.previousStatus} to ${result.entity.status}`);
			return 0;
		} finally {
			db.close();
		}
	}
}

export class DeleteCommand extends PositionalsTenantCommand {
	public static paths = [["delete"]];

	public async execute(): Promise<number> {
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const entityId = requirePositional(this.positionals, 0, "delete <id>");
			const result = deleteEntity(db, { entityId });

			this.print(result, `Deleted ${result.entity.id} ${result.entity.kind} ${result.entity.title}`);
			return 0;
		} finally {
			db.close();
		}
	}
}

export class MoveCommand extends PositionalsTenantCommand {
	public static paths = [["move"]];

	public async execute(): Promise<number> {
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const entityId = requirePositional(this.positionals, 0, "move <id> <newParentId>");
			const newParentId = requirePositional(this.positionals, 1, "move <id> <newParentId>");
			const result = moveEntity(db, { entityId, newParentId });

			this.print(
				result,
				`Moved ${result.entity.id} from ${result.previousParentId ?? "none"} to ${result.newParentId} as ${result.relationType}`
			);
			return 0;
		} finally {
			db.close();
		}
	}
}

export class LinkCommand extends PositionalsTenantCommand {
	public static paths = [["link"]];

	public async execute(): Promise<number> {
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const fromId = requirePositional(this.positionals, 0, "link <fromId> <relationType> <toId>");
			const relationType = requirePositional(this.positionals, 1, "link <fromId> <relationType> <toId>");
			const toId = requirePositional(this.positionals, 2, "link <fromId> <relationType> <toId>");
			const result = linkEntities(db, { fromId, relationType, toId });

			this.print(
				result,
				result.created
					? `Linked ${fromId} -> ${toId} as ${relationType}`
					: `Relation already existed: ${fromId} -> ${toId} as ${relationType}`
			);
			return 0;
		} finally {
			db.close();
		}
	}
}

export class UnlinkCommand extends PositionalsTenantCommand {
	public static paths = [["unlink"]];

	public async execute(): Promise<number> {
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const fromId = requirePositional(this.positionals, 0, "unlink <fromId> <relationType> <toId>");
			const relationType = requirePositional(this.positionals, 1, "unlink <fromId> <relationType> <toId>");
			const toId = requirePositional(this.positionals, 2, "unlink <fromId> <relationType> <toId>");
			const result = unlinkEntities(db, { fromId, relationType, toId });

			this.print(
				result,
				result.removed
					? `Unlinked ${fromId} -> ${toId} as ${relationType}`
					: `Relation did not exist: ${fromId} -> ${toId} as ${relationType}`
			);
			return 0;
		} finally {
			db.close();
		}
	}
}

export class StatusCommand extends PositionalsTenantCommand {
	public static paths = [["status"]];

	public async execute(): Promise<number> {
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const entityId = requirePositional(this.positionals, 0, "status <id> <status>");
			const status = requirePositional(this.positionals, 1, "status <id> <status>");
			const result = updateEntityStatus(db, { entityId, status });

			this.print(result, `Updated ${result.entity.id} from ${result.previousStatus} to ${result.entity.status}`);
			return 0;
		} finally {
			db.close();
		}
	}
}

export class BundleCommand extends PositionalsTenantCommand {
	public static paths = [["bundle"]];

	public async execute(): Promise<number> {
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const initiativeId = requirePositional(this.positionals, 0, "bundle <initiativeId>");
			const bundle = getInitiativeBundle(db, initiativeId);

			this.print(bundle, renderInitiativeBundle(bundle));
			return 0;
		} finally {
			db.close();
		}
	}
}

export class RelationsCommand extends PositionalsTenantCommand {
	public static paths = [["relations"]];

	public async execute(): Promise<number> {
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const entityId = requirePositional(this.positionals, 0, "relations <id>");
			const details = getEntityDetails(db, entityId);

			this.print(details, renderEntityDetails(details));
			return 0;
		} finally {
			db.close();
		}
	}
}

export class OrphansCommand extends PositionalsTenantCommand {
	public static paths = [["orphans"]];

	public async execute(): Promise<number> {
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const kind = this.positionals[0];
			const entities = kind ? listOrphans(db, kind) : listOrphans(db);

			this.print(entities, renderOptionalEntityList("orphaned", entities));
			return 0;
		} finally {
			db.close();
		}
	}
}

export class ShowCommand extends PositionalsTenantCommand {
	public static paths = [["show"]];

	public async execute(): Promise<number> {
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const entityId = requirePositional(this.positionals, 0, "show <id>");
			const details = getEntityDetails(db, entityId);

			if (details.entity.kind === "initiative") {
				const bundle = getInitiativeBundle(db, entityId);
				this.print(bundle, renderInitiativeBundle(bundle));
				return 0;
			}

			this.print(details, renderEntityDetails(details));
			return 0;
		} finally {
			db.close();
		}
	}
}

export class ListCommand extends PositionalsTenantCommand {
	public static paths = [["list"]];

	public async execute(): Promise<number> {
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const kind = requirePositional(this.positionals, 0, "list <kind>");
			const entities = listEntities(db, kind);

			this.print(entities, renderEntityList(kind, entities));
			return 0;
		} finally {
			db.close();
		}
	}
}
