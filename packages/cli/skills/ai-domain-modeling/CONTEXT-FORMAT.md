# Context Record Format

The canonical glossary lives in the `agent-issues` database. It does not live in a raw file.

Initiative-scoped context is the database equivalent of a `CONTEXT.md` file inside an initiative folder.
Use the [Context Summary recipe](../../recipes/context-summary.md) for a context body and the [Context Term recipe](../../recipes/context-term.md) for a term definition.

Read the relevant initiative glossary with `agent-issues context show <entityOrInitiativeId> --json`.

For project-wide discovery across shared and initiative scopes, use `agent-issues context search <query> --json`.

Before you add or rename a term, check whether the same label already exists in another scope with `agent-issues context conflicts --json`.

Use `agent-issues context list --json` only when you need the raw list of stored scopes.

Set up or update the shared context with:

```bash
agent-issues context set --scope INIT1 --title "Payments Context" --body-file /tmp/payments-summary.md --json
```

Add or update a term with:

```bash
agent-issues context define "Order" --scope INIT1 --body-file /tmp/order-definition.md --avoid "purchase, transaction" --json
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

- Be decisive. When more than one word exists for the same idea, pick the best one. List the others under `avoid`.
- Keep each definition short: one or two sentences. Define what the term is, not what it does.
- Include only terms specific to this project's context. Do not include general programming concepts.
- Group terms under subheadings when a natural cluster forms. If all terms belong to one area, a flat list is fine.
- Keep initiative context in the database. Do not copy it into a raw markdown file.

The `agent-issues` context model is initiative-scoped by default, with an optional shared default context. Read the relevant initiative context first. Use project-wide search only when you need to resolve which term is correct. Then update the scoped glossary, one term at a time, as the vocabulary becomes precise.
