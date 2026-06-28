import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Option } from "clipanion";

import { getContextDetails } from "../../context-store.js";
import { ensureDatabase } from "../../database.js";
import { writeInitiativeDirectoryExport, writeProjectDirectoryExport } from "../../export-files.js";
import { renderInitiativeMarkdownExport, renderProjectMarkdownExport } from "../../export-markdown.js";
import { getDatabaseSnapshot, getInitiativeBundle, listHandoffs } from "../../store.js";

import { requirePositional } from "../shared.js";
import { MutableTenantCommand } from "../shared.js";

export class ExportCommand extends MutableTenantCommand {
	public static paths = [["export"]];

	public output = Option.String("--output");
	public positionals = Option.Rest();
	public singleFile = Option.Boolean("--single-file", false);

	public async execute(): Promise<number> {
		const { db } = ensureDatabase(this.dbPath, { tenant: this.tenant });

		try {
			const target = requirePositional(this.positionals, 0, "export <initiativeId|project>");
			const snapshot = getDatabaseSnapshot(db);

			if (target === "project") {
				const handoffs = listHandoffs(db);
				const markdown = renderProjectMarkdownExport({ handoffs, snapshot });

				if (this.singleFile) {
					return this.emitSingleFileExport({
						markdown,
						payload: {
							generatedAt: snapshot.generatedAt,
							markdown,
							mode: "single-file",
							scope: "project"
						},
						target
					});
				}

				const result = writeProjectDirectoryExport({
					snapshot,
					handoffs,
					outputPath: this.resolveOutputPath(target),
					force: this.force
				});

				this.print(
					result,
					renderDirectorySummary(result)
				);
				return 0;
			}

			const bundle = getInitiativeBundle(db, target);
			const relations = snapshot.relations;
			const context = getContextDetails(db, { scopeRef: target });
			const markdown = renderInitiativeMarkdownExport({ bundle, context, relations });

			if (this.singleFile) {
				return this.emitSingleFileExport({
					markdown,
					payload: {
						initiativeId: bundle.initiative.id,
						markdown,
						mode: "single-file",
						scope: "initiative"
					},
					target
				});
			}

			const result = writeInitiativeDirectoryExport({
				bundle,
				context,
				outputPath: this.resolveOutputPath(target),
				relations,
				force: this.force
			});

			this.print(
				result,
				renderDirectorySummary(result)
			);
			return 0;
		} finally {
			db.close();
		}
	}

	protected emitSingleFileExport(input: {
		markdown: string;
		payload: { markdown: string; mode: "single-file"; scope: "initiative" | "project"; initiativeId?: string; generatedAt?: string };
		target: string;
	}): number {
		if (!this.output) {
			this.print(input.payload, input.markdown);
			return 0;
		}

		const outputPath = path.resolve(this.context.cwd, this.output);
		mkdirSync(path.dirname(outputPath), { recursive: true });
		writeFileSync(outputPath, `${input.markdown.trimEnd()}\n`, "utf8");

		this.print(
			{ ...input.payload, outputPath },
			`Exported ${input.payload.scope} ${input.target} to ${outputPath}`
		);
		return 0;
	}

	protected resolveOutputPath(target: string): string {
		return path.resolve(this.context.cwd, this.output ?? path.join("agent-issues-export", target));
	}
}

function renderDirectorySummary(result: { scope: "initiative" | "project"; outputPath: string; files: string[] }): string {
	return [
		`Exported ${result.scope} to ${result.outputPath}`,
		`Files: ${result.files.length}`
	].join("\n");
}