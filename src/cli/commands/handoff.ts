import { Option } from "clipanion";

import { ensureDatabase } from "../../database.js";
import { createHandoff, deleteHandoff, getHandoffDetails, updateHandoff } from "../../store.js";

import {
	renderHandoffCreateResult,
	renderHandoffDeleteResult,
	renderHandoffDetails,
	renderHandoffEditResult
} from "../renderers.js";
import { BodyTenantCommand, requirePositional } from "../shared.js";

export class HandoffCommand extends BodyTenantCommand {
	public static paths = [["handoff"]];

	public positionals = Option.Rest();
	public summary = Option.String("--summary");

	public async execute(): Promise<number> {
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const firstPositional = this.positionals[0];

			if (firstPositional === "create" || firstPositional === "write") {
				const entityId = requirePositional(this.positionals, 1, "handoff create <id> (--body <markdown> | --body-file <path|->) [--summary <text>]");
				const handoff = createHandoff(db, {
					body: this.requireBody("--body or --body-file is required for handoff create."),
					entityId,
					summary: this.summary
				});

				this.print(handoff, renderHandoffCreateResult(handoff));
				return 0;
			}

			if (firstPositional === "edit") {
				const handoffId = requirePositional(this.positionals, 1, "handoff edit <handoffId> [--summary <text>] [--body <markdown> | --body-file <path|->]");
				const body = this.resolveBody();

				if (this.summary === undefined && body === undefined) {
					throw new Error("--summary, --body, or --body-file is required for handoff edit.");
				}

				const handoff = updateHandoff(db, {
					body,
					handoffId,
					summary: this.summary
				});

				this.print(handoff, renderHandoffEditResult(handoff));
				return 0;
			}

			if (firstPositional === "delete") {
				const handoffId = requirePositional(this.positionals, 1, "handoff delete <handoffId>");
				const result = deleteHandoff(db, { handoffId });

				this.print(result, renderHandoffDeleteResult(result));
				return 0;
			}

			if (firstPositional === "show") {
				const entityId = requirePositional(this.positionals, 1, "handoff show <id>");
				const handoff = getHandoffDetails(db, entityId);

				this.print(handoff, renderHandoffDetails(handoff));
				return 0;
			}

			const entityId = requirePositional(this.positionals, 0, "handoff <id>");
			const handoff = getHandoffDetails(db, entityId);

			this.print(handoff, renderHandoffDetails(handoff));
			return 0;
		} finally {
			db.close();
		}
	}
}
