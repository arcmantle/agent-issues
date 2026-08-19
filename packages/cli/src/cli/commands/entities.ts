import { Option } from "clipanion";

import { ALLOWED_RELATIONS, computeContextContentHash, computeContextTermContentHash, computeEntityContentHash, isEntityKind, isValidStatus, projectPlanEntries, type RelationDirection, type RelationType } from "@agent-issues/core";

import {
	toCompactCreateAcknowledgement,
	toCompactContextRestoreAcknowledgement,
	toCompactContextTermRestoreAcknowledgement,
	toCompactDeleteAcknowledgement,
	toCompactEditAcknowledgement,
	toCompactEntityDetails,
	toCompactEntityList,
	toCompactEntityRestoreAcknowledgement,
	toCompactInitiativeBundle,
	toCompactLinkAcknowledgement,
	toCompactMoveAcknowledgement,
	toCompactStatusAcknowledgement
} from "../../entity-projection.js";
import { renderEntityDetails, renderEntityList, renderInitiativeBundle, renderOptionalEntityList, renderPlanDetails } from "../renderers.js";
import { BodyTenantCommand, TenantCommand, parseCsvOption, parseEntityView, parsePositiveIntegerOption, requireOption, requirePositional, withStore } from "../shared.js";

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

	public category = Option.String("--category");
	public links = Option.Array("--link", { arity: 2 });
	public parent = Option.String("--parent");
	public positionals = Option.Rest();
	public priority = Option.String("--priority");
	public statusValue = Option.String("--status");
	public title = Option.String("--title");
	public entityType = Option.String("--type");
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		const view = parseEntityView(this.view);
		const kind = requirePositional(this.positionals, 0, "create <kind>");
		if (!isEntityKind(kind)) {
			throw new Error(`Unknown entity kind: ${kind}`);
		}

		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entity = await store.createEntity({
				body: await this.resolveBody(),
				category: this.category,
				kind,
				links: this.links?.map(([relationType, targetId]) => ({ relationType, targetId })),
				parentId: this.parent,
				priority: this.priority,
				status: this.statusValue,
				title: requireOption(this.title, "--title is required for create."),
				type: this.entityType
			});

			this.print(this.asJson && view === "compact" ? toCompactCreateAcknowledgement(entity) : entity, `${entity.reference} ${entity.kind} ${entity.status} ${entity.title}`);
			return 0;
		});
	}
}

export class EditCommand extends BodyTenantCommand {
	public static paths = [["edit"]];

	public category = Option.String("--category");
	public positionals = Option.Rest();
	public priority = Option.String("--priority");
	public title = Option.String("--title");
	public entityType = Option.String("--type");
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		const view = parseEntityView(this.view);
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "edit <id> (--title <text> | --body-file <path|->)");
			const body = await this.resolveBody();
			if (this.title === undefined && body === undefined && this.category === undefined && this.priority === undefined && this.entityType === undefined) {
				throw new Error("--title, --body-file, --category, --priority, or --type is required for edit.");
			}
			const { entity: current } = await store.getEntityDetails(entityId);
			const entity = await store.updateEntity({ body, category: this.category, entityId, priority: this.priority, title: this.title, type: this.entityType, expectedRevision: current.revision, expectedContentHash: current.contentHash });

			this.print(this.asJson && view === "compact" ? toCompactEditAcknowledgement(entity) : entity, `Updated ${entity.id} ${entity.kind} ${entity.title}`);
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
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		const view = parseEntityView(this.view);
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
						expectedContentHash: computeContextTermContentHash(head.term, head.definition, head.avoid, head.tombstone)
					});
					this.print(this.asJson && view === "compact" ? toCompactContextTermRestoreAcknowledgement(restored) : restored, `Restored ${restored.contextKey} term ${restored.term} revision ${revision} as revision ${restored.headRevision}`);
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
				this.print(this.asJson && view === "compact" ? toCompactContextRestoreAcknowledgement(restored) : restored, `Restored ${restored.contextKey} context revision ${revision} as revision ${restored.headRevision}`);
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
			this.print(this.asJson && view === "compact" ? toCompactEntityRestoreAcknowledgement(restored) : restored, `Restored ${entityId} revision ${revision} as revision ${restored.headRevision}`);
			return 0;
		});
	}
}

export class ArchiveCommand extends PositionalsTenantCommand {
	public static paths = [["archive"]];
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		const view = parseEntityView(this.view);
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "archive <id>");
			const result = await store.archiveEntity({ entityId });

			this.print(this.asJson && view === "compact" ? toCompactStatusAcknowledgement("archive", result) : result, `Archived ${result.entity.id} from ${result.previousStatus} to ${result.entity.status}`);
			return 0;
		});
	}
}

export class DeleteCommand extends PositionalsTenantCommand {
	public static paths = [["delete"]];
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		const view = parseEntityView(this.view);
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "delete <id>");
			const result = await store.deleteEntity({ entityId });

			this.print(this.asJson && view === "compact" ? toCompactDeleteAcknowledgement(result) : result, `Deleted ${result.entity.id} ${result.entity.kind} ${result.entity.title}`);
			return 0;
		});
	}
}

export class MoveCommand extends PositionalsTenantCommand {
	public static paths = [["move"]];
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		const view = parseEntityView(this.view);
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "move <id> <newParentId>");
			const newParentId = requirePositional(this.positionals, 1, "move <id> <newParentId>");
			const result = await store.moveEntity({ entityId, newParentId });

			this.print(
				this.asJson && view === "compact" ? toCompactMoveAcknowledgement(result) : result,
				`Moved ${result.entity.id} from ${result.previousParentId ?? "none"} to ${result.newParentId} as ${result.relationType}`
			);
			return 0;
		});
	}
}

export class LinkCommand extends PositionalsTenantCommand {
	public static paths = [["link"]];
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		const view = parseEntityView(this.view);
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const fromId = requirePositional(this.positionals, 0, "link <fromId> <relationType> <toId>");
			const relationType = requirePositional(this.positionals, 1, "link <fromId> <relationType> <toId>");
			const toId = requirePositional(this.positionals, 2, "link <fromId> <relationType> <toId>");
			const result = await store.linkEntities({ fromId, relationType, toId });

			this.print(
				this.asJson && view === "compact" ? toCompactLinkAcknowledgement("link", result) : result,
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
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		const view = parseEntityView(this.view);
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const fromId = requirePositional(this.positionals, 0, "unlink <fromId> <relationType> <toId>");
			const relationType = requirePositional(this.positionals, 1, "unlink <fromId> <relationType> <toId>");
			const toId = requirePositional(this.positionals, 2, "unlink <fromId> <relationType> <toId>");
			const result = await store.unlinkEntities({ fromId, relationType, toId });

			this.print(
				this.asJson && view === "compact" ? toCompactLinkAcknowledgement("unlink", result) : result,
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
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		const view = parseEntityView(this.view);
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "status <id> <status>");
			const status = requirePositional(this.positionals, 1, "status <id> <status>");
			const result = await store.updateEntityStatus({ entityId, status });

			this.print(this.asJson && view === "compact" ? toCompactStatusAcknowledgement("status", result) : result, `Updated ${result.entity.id} from ${result.previousStatus} to ${result.entity.status}`);
			return 0;
		});
	}
}

export class BundleCommand extends PositionalsTenantCommand {
	public static paths = [["bundle"]];
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		const view = parseEntityView(this.view);
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const initiativeId = requirePositional(this.positionals, 0, "bundle <initiativeId>");
			const bundle = await store.getInitiativeBundle(initiativeId);

			this.print(this.asJson && view === "compact" ? toCompactInitiativeBundle(bundle) : bundle, renderInitiativeBundle(bundle));
			return 0;
		});
	}
}

export class RelationsCommand extends PositionalsTenantCommand {
	public static paths = [["relations"]];
	public directionValue = Option.String("--direction");
	public typeValues = Option.String("--type");
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		const view = parseEntityView(this.view);
		const direction = this.directionValue ?? "both";
		if (direction !== "incoming" && direction !== "outgoing" && direction !== "both") {
			throw new Error(`Unknown relation direction: ${direction}`);
		}
		const types = parseCsvOption(this.typeValues);
		const allowedTypes = new Set<string>(ALLOWED_RELATIONS.map(({ type }) => type));
		const invalidType = types.find((type) => !allowedTypes.has(type));
		if (invalidType) {
			throw new Error(`Unknown relation type: ${invalidType}`);
		}
		const entityId = requirePositional(this.positionals, 0, "relations <id>");
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const details = await store.queryEntityRelations({
				entityId,
				direction: direction as RelationDirection,
				types: types as RelationType[]
			});

			this.print(this.asJson && view === "compact" ? toCompactEntityDetails(details) : details, renderEntityDetails(details));
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
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		const view = parseEntityView(this.view);
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "show <id>");
			const details = await store.getEntityDetails(entityId);

			if (details.entity.kind === "initiative") {
				const bundle = await store.getInitiativeBundle(entityId);
				this.print(this.asJson && view === "compact" ? toCompactInitiativeBundle(bundle) : bundle, renderInitiativeBundle(bundle));
				return 0;
			}

			if (details.entity.kind === "plan") {
				const projection = projectPlanEntries(await store.listPlanEntries({ planId: details.entity.id }));
				const planDetails = { ...details, ...projection };
				this.print(planDetails, renderPlanDetails(planDetails));
				return 0;
			}

			this.print(this.asJson && view === "compact" ? toCompactEntityDetails(details) : details, renderEntityDetails(details));
			return 0;
		});
	}
}

export class ListCommand extends PositionalsTenantCommand {
	public static paths = [["list"]];
	public limit = Option.String("--limit");
	public parent = Option.String("--parent");
	public statusValues = Option.String("--status");
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		const view = parseEntityView(this.view);
		const limit = parsePositiveIntegerOption(this.limit, "--limit");
		const kind = requirePositional(this.positionals, 0, "list <kind>");
		if (!isEntityKind(kind)) {
			throw new Error(`Unknown entity kind: ${kind}`);
		}
		const statuses = parseCsvOption(this.statusValues);
		const invalidStatus = statuses.find((status) => !isValidStatus(kind, status));
		if (invalidStatus) {
			throw new Error(`Invalid ${kind} status: ${invalidStatus}`);
		}
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const result = await store.queryEntities({ kind, statuses, parentId: this.parent, limit });

			this.print(
				this.asJson
					? view === "compact"
						? toCompactEntityList(result.entities, result.total, result.openBlockers, result.parentGroups)
						: result.parentGroups ? result : result.entities
					: result.entities,
				renderEntityList(kind, result.entities, result.openBlockers, result.parentGroups)
			);
			return 0;
		});
	}
}
