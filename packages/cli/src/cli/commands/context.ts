import { Option } from "clipanion";

import {
	renderContextDetails,
	renderContextForgetResult,
	renderContextList,
	renderContextOutput,
	renderContextSearchTermsOnly,
	renderContextTermResult,
	toContextSearchTermsOnly
} from "../../context-cli.js";

import {
	CONTEXT_SUBCOMMANDS,
	TenantCommand,
	parseContextView,
	parseCsvOption,
	requireOption,
	requirePositional,
	withStore
} from "../shared.js";

export class ContextCommand extends TenantCommand {
	public static paths = [["context"]];

	public avoid = Option.String("--avoid");
	public definition = Option.String("--definition");
	public positionals = Option.Rest();
	public query = Option.String("--query");
	public scope = Option.String("--scope");
	public summary = Option.String("--summary");
	public termsOnly = Option.Boolean("--terms-only", false);
	public title = Option.String("--title");
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		return withStore(this.dbPath, { tenant: this.tenant }, async (store) => {
			const firstPositional = this.positionals[0];
			const subcommand = !firstPositional || CONTEXT_SUBCOMMANDS.has(firstPositional) ? firstPositional ?? "show" : "show";
			const showScopeRef = subcommand === "show"
				? this.scope ?? (firstPositional && !CONTEXT_SUBCOMMANDS.has(firstPositional) ? firstPositional : this.positionals[1])
				: this.scope;
			const contextView = parseContextView(this.view);

			if (subcommand === "list") {
				const result = await store.listContexts();
				this.print(result, renderContextList(result));
				return 0;
			}

			if (subcommand === "show") {
				if (showScopeRef && (this.query || contextView !== "all")) {
					throw new Error("`context show <scope>` does not support --query or --view. Use `context search` for filtered project-wide discovery.");
				}

				const context = showScopeRef
					? await store.getContextDetails({ scopeRef: showScopeRef })
					: await store.queryContextDirectory({ query: this.query, view: contextView });
				this.print(context, renderContextOutput(context));
				return 0;
			}

			if (subcommand === "search") {
				const query = this.query ?? this.positionals[1];
				if (!query) {
					throw new Error("Missing argument. Usage: context search <query> [--view <all|global|initiatives>]");
				}

				const result = await store.queryContextDirectory({ query, view: contextView });
				if (this.termsOnly) {
					const compactResult = toContextSearchTermsOnly(result);
					this.print(compactResult, renderContextSearchTermsOnly(compactResult));
					return 0;
				}

				this.print(result, renderContextOutput(result));
				return 0;
			}

			if (this.termsOnly) {
				throw new Error("`--terms-only` is only supported for `context search`.");
			}

			if (subcommand === "conflicts") {
				if (contextView === "global") {
					throw new Error("`context conflicts` does not support --view global because shared-only context cannot conflict across scopes.");
				}

				const result = await store.queryContextDirectory({
					conflictsOnly: true,
					query: this.query ?? this.positionals[1],
					view: contextView
				});
				this.print(result, renderContextOutput(result));
				return 0;
			}

			if (subcommand === "set") {
				const result = await store.upsertContext({
					scopeRef: this.scope,
					title: requireOption(this.title, "--title is required for context set."),
					summary: requireOption(this.summary, "--summary is required for context set.")
				});

				this.print(result, renderContextDetails(result));
				return 0;
			}

			if (subcommand === "define") {
				const term = requirePositional(this.positionals, 1, "context define <term> --definition <definition> [--avoid <comma-separated terms>]");
				const result = await store.defineContextTerm({
					scopeRef: this.scope,
					term,
					definition: requireOption(this.definition, "--definition is required for context define."),
					avoid: parseCsvOption(this.avoid)
				});

				this.print(result, renderContextTermResult(result));
				return 0;
			}

			if (subcommand === "forget") {
				const term = requirePositional(this.positionals, 1, "context forget <term>");
				const result = await store.forgetContextTerm({ scopeRef: this.scope, term });

				this.print(result, renderContextForgetResult(result));
				return 0;
			}

			throw new Error(`Unknown context subcommand: ${subcommand}`);
		});
	}
}
