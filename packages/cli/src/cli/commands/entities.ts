import { Option } from "clipanion";

import { computeContextContentHash, computeContextTermContentHash, computeEntityContentHash, isEntityKind } from "@agent-issues/core";

import { renderEntityDetails, renderEntityList, renderInitiativeBundle, renderOptionalEntityList } from "../renderers.js";
import { BodyTenantCommand, TenantCommand, requireOption, requirePositional, withStore } from "../shared.js";

abstract class PositionalsTenantCommand extends TenantCommand {
	public positionals = Option.Rest();
}

function parseRevision(value: string): number {
	const revision = Number(value);
	if (!Number.isInteger(revision) || revision < 1) {
		throw new Error(`Revision must be a positive integer: ${value}`);
	}
	return revision;
}

export class CreateCommand extends BodyTenantCommand {
	public static paths = [["create"]];

	public links = Option.Array("--link", { arity: 2 });
	public parent = Option.String("--parent");
	public positionals = Option.Rest();
	public statusValue = Option.String("--status");
	public title = Option.String("--title");

	public async execute(): Promise<number> {
		const kind = requirePositional(this.positionals, 0, "create <kind>");
		if (!isEntityKind(kind)) {
			throw new Error(`Unknown entity kind: ${kind}`);
		}

		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entity = await store.createEntity({
				body: this.resolveBody(),
				kind,
				links: this.links?.map(([relationType, targetId]) => ({ relationType, targetId })),
				parentId: this.parent,
				status: this.statusValue,
				title: requireOption(this.title, "--title is required for create.")
			});

			this.print(entity, `${entity.id} ${entity.kind} ${entity.status} ${entity.title}`);
			return 0;
		});
	}
}

export class EditCommand extends BodyTenantCommand {
	public static paths = [["edit"]];

	public positionals = Option.Rest();
	public title = Option.String("--title");

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "edit <id> (--title <text> | --body <markdown> | --body-file <path|->)");
			const body = this.resolveBody();
			if (this.title === undefined && body === undefined) {
				throw new Error("--title or --body is required for edit.");
			}
			const { entity: current } = await store.getEntityDetails(entityId);
			const entity = await store.updateEntity({ body, entityId, title: this.title, expectedRevision: current.revision, expectedContentHash: current.contentHash });

			this.print(entity, `Updated ${entity.id} ${entity.kind} ${entity.title}`);
			return 0;
		});
	}
}

export class HistoryCommand extends TenantCommand {
	public static paths = [["history"]];

	public contextScope = Option.String("--context");
	public positionals = Option.Rest();
	public revisionValue = Option.String("--revision", { required: true });
	public term = Option.String("--term");

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const revision = parseRevision(this.revisionValue);
			if (this.contextScope) {
				if (this.positionals.length > 0) {
					throw new Error("History accepts either an entity id or --context, not both.");
				}
				if (this.term) {
					const materialized = await store.materializeContextTermRevision({ scopeRef: this.contextScope, term: this.term, revision });
					this.print(materialized, `${materialized.contextKey} term ${materialized.term} revision ${materialized.targetRevision}/${materialized.headRevision}${materialized.tombstone ? " tombstoned" : ""}\n${materialized.definition}\nAvoid: ${materialized.avoid.join(", ") || "none"}`);
					return 0;
				}

				const materialized = await store.materializeContextRevision({ scopeRef: this.contextScope, revision });
				this.print(materialized, `${materialized.contextKey} context revision ${materialized.targetRevision}/${materialized.headRevision} ${materialized.title}\n${materialized.summary}`);
				return 0;
			}
			if (this.term) {
				throw new Error("--term requires --context <scope>.");
			}

			const entityId = requirePositional(this.positionals, 0, "history <id> --revision <revision>");
			const materialized = await store.materializeEntityRevision({ entityId, revision });
			this.print(
				materialized,
				`${materialized.entityId} revision ${materialized.targetRevision}/${materialized.headRevision} ${materialized.status} ${materialized.title}\n${materialized.body}`
			);
			return 0;
		});
	}
}

export class RestoreCommand extends PositionalsTenantCommand {
	public static paths = [["restore"]];

	public contextScope = Option.String("--context");
	public revisionValue = Option.String("--revision", { required: true });
	public term = Option.String("--term");

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const revision = parseRevision(this.revisionValue);
			if (this.contextScope) {
				if (this.positionals.length > 0) {
					throw new Error("Restore accepts either an entity id or --context, not both.");
				}
				if (this.term) {
					const source = await store.materializeContextTermRevision({ scopeRef: this.contextScope, term: this.term, revision });
					const head = await store.materializeContextTermRevision({ scopeRef: this.contextScope, term: this.term, revision: source.headRevision });
					const restored = await store.restoreContextTermRevision({
						scopeRef: this.contextScope,
						term: this.term,
						revision,
						expectedRevision: head.headRevision,
						expectedContentHash: computeContextTermContentHash(head.definition, head.avoid, head.tombstone)
					});
					this.print(restored, `Restored ${restored.contextKey} term ${restored.term} revision ${revision} as revision ${restored.headRevision}`);
					return 0;
				}

				const source = await store.materializeContextRevision({ scopeRef: this.contextScope, revision });
				const head = await store.materializeContextRevision({ scopeRef: this.contextScope, revision: source.headRevision });
				const restored = await store.restoreContextRevision({
					scopeRef: this.contextScope,
					revision,
					expectedRevision: head.headRevision,
					expectedContentHash: computeContextContentHash(head.title, head.summary)
				});
				this.print(restored, `Restored ${restored.contextKey} context revision ${revision} as revision ${restored.headRevision}`);
				return 0;
			}
			if (this.term) {
				throw new Error("--term requires --context <scope>.");
			}

			const entityId = requirePositional(this.positionals, 0, "restore <id> --revision <revision>");
			const source = await store.materializeEntityRevision({ entityId, revision });
			const head = await store.materializeEntityRevision({ entityId, revision: source.headRevision });
			const restored = await store.restoreEntityRevision({
				entityId,
				revision,
				expectedRevision: head.headRevision,
				expectedContentHash: computeEntityContentHash(head.title, head.body)
			});
			this.print(restored, `Restored ${entityId} revision ${revision} as revision ${restored.headRevision}`);
			return 0;
		});
	}
}

export class ArchiveCommand extends PositionalsTenantCommand {
	public static paths = [["archive"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "archive <id>");
			const result = await store.archiveEntity({ entityId });

			this.print(result, `Archived ${result.entity.id} from ${result.previousStatus} to ${result.entity.status}`);
			return 0;
		});
	}
}

export class DeleteCommand extends PositionalsTenantCommand {
	public static paths = [["delete"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "delete <id>");
			const result = await store.deleteEntity({ entityId });

			this.print(result, `Deleted ${result.entity.id} ${result.entity.kind} ${result.entity.title}`);
			return 0;
		});
	}
}

export class MoveCommand extends PositionalsTenantCommand {
	public static paths = [["move"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "move <id> <newParentId>");
			const newParentId = requirePositional(this.positionals, 1, "move <id> <newParentId>");
			const result = await store.moveEntity({ entityId, newParentId });

			this.print(
				result,
				`Moved ${result.entity.id} from ${result.previousParentId ?? "none"} to ${result.newParentId} as ${result.relationType}`
			);
			return 0;
		});
	}
}

export class LinkCommand extends PositionalsTenantCommand {
	public static paths = [["link"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const fromId = requirePositional(this.positionals, 0, "link <fromId> <relationType> <toId>");
			const relationType = requirePositional(this.positionals, 1, "link <fromId> <relationType> <toId>");
			const toId = requirePositional(this.positionals, 2, "link <fromId> <relationType> <toId>");
			const result = await store.linkEntities({ fromId, relationType, toId });

			this.print(
				result,
				result.created
					? `Linked ${fromId} -> ${toId} as ${relationType}`
					: `Relation already existed: ${fromId} -> ${toId} as ${relationType}`
			);
			return 0;
		});
	}
}

export class UnlinkCommand extends PositionalsTenantCommand {
	public static paths = [["unlink"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const fromId = requirePositional(this.positionals, 0, "unlink <fromId> <relationType> <toId>");
			const relationType = requirePositional(this.positionals, 1, "unlink <fromId> <relationType> <toId>");
			const toId = requirePositional(this.positionals, 2, "unlink <fromId> <relationType> <toId>");
			const result = await store.unlinkEntities({ fromId, relationType, toId });

			this.print(
				result,
				result.removed
					? `Unlinked ${fromId} -> ${toId} as ${relationType}`
					: `Relation did not exist: ${fromId} -> ${toId} as ${relationType}`
			);
			return 0;
		});
	}
}

export class StatusCommand extends PositionalsTenantCommand {
	public static paths = [["status"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "status <id> <status>");
			const status = requirePositional(this.positionals, 1, "status <id> <status>");
			const result = await store.updateEntityStatus({ entityId, status });

			this.print(result, `Updated ${result.entity.id} from ${result.previousStatus} to ${result.entity.status}`);
			return 0;
		});
	}
}

export class BundleCommand extends PositionalsTenantCommand {
	public static paths = [["bundle"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const initiativeId = requirePositional(this.positionals, 0, "bundle <initiativeId>");
			const bundle = await store.getInitiativeBundle(initiativeId);

			this.print(bundle, renderInitiativeBundle(bundle));
			return 0;
		});
	}
}

export class RelationsCommand extends PositionalsTenantCommand {
	public static paths = [["relations"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "relations <id>");
			const details = await store.getEntityDetails(entityId);

			this.print(details, renderEntityDetails(details));
			return 0;
		});
	}
}

export class OrphansCommand extends PositionalsTenantCommand {
	public static paths = [["orphans"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const kind = this.positionals[0];
			const entities = kind ? await store.listOrphans(kind) : await store.listOrphans();

			this.print(entities, renderOptionalEntityList("orphaned", entities));
			return 0;
		});
	}
}

export class ShowCommand extends PositionalsTenantCommand {
	public static paths = [["show"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "show <id>");
			const details = await store.getEntityDetails(entityId);

			if (details.entity.kind === "initiative") {
				const bundle = await store.getInitiativeBundle(entityId);
				this.print(bundle, renderInitiativeBundle(bundle));
				return 0;
			}

			this.print(details, renderEntityDetails(details));
			return 0;
		});
	}
}

export class ListCommand extends PositionalsTenantCommand {
	public static paths = [["list"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const kind = requirePositional(this.positionals, 0, "list <kind>");
			const entities = await store.listEntities(kind);

			this.print(entities, renderEntityList(kind, entities));
			return 0;
		});
	}
}
