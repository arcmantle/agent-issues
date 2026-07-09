# Context Record Format

The canonical glossary lives in the `agent-issues` database, not in a raw file.

Initiative-scoped context is the database equivalent of `CONTEXT.md` files inside initiative folders.

Read the relevant initiative glossary with `agent-issues context show <entityOrInitiativeId> --json`.

When you need project-wide discovery across shared and initiative scopes, use `agent-issues context search <query> --json`.

When you suspect the same label already exists in another scope, use `agent-issues context conflicts --json` before you add or rename a term.

Use `agent-issues context list --json` only when you need the raw list of stored scopes.

Initialize or update the shared context with:

```bash
agent-issues context set --scope INIT1 --title "Payments Context" --summary "Glossary of initiative-specific terms for Payments." --json
```

Add or update a term with:

```bash
agent-issues context define "Order" --scope INIT1 --definition "A customer request accepted and tracked by the system." --avoid "purchase, transaction" --json
```

## Structure

```json
{
	"context": {
			"key": "INIT1",
			"scopeKind": "initiative",
			"scopeEntityId": "INIT1",
			"scopeLabel": "Payments",
			"title": "Payments Context",
			"summary": "Glossary of initiative-specific terms for Payments.",
		"exists": true
	},
	"terms": [
		{
			"term": "Order",
			"definition": "A customer request accepted and tracked by the system.",
			"avoid": ["Purchase", "Transaction"]
		},
		{
			"term": "Invoice",
			"definition": "A request for payment sent to a customer after delivery.",
			"avoid": ["Bill", "Payment request"]
		}
	]
}
```

## Rules

- Be opinionated. When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- Keep definitions tight. One or two sentences max. Define what it is, not what it does.
- Only include terms specific to this project's context. General programming concepts do not belong.
- Group terms under subheadings when natural clusters emerge. If all terms belong to a single cohesive area, a flat list is fine.
- Keep initiative context in the database. Do not duplicate it into a raw markdown file.

The current `agent-issues` context model is initiative-scoped by default, with an optional shared default context. Read the relevant initiative context first, use project-wide search only when needed to disambiguate, then update the scoped glossary term by term as the vocabulary becomes precise.