# ADR Format

ADRs live as `adr` entities in `agent-issues`, not as filesystem documents unless the user explicitly requests one.

## Template

Use the ADR title for the short decision name and store the explanation in the entity body.

Suggested body shape:

```md
{1-3 sentences: what is the context, what did we decide, and why.}
```

That is enough. The value is in recording that a decision was made and why.

## Optional sections

Only include these when they add genuine value:

- `Status` frontmatter (`proposed | accepted | deprecated | superseded by ADR-NNNN`)
- `Considered Options`
- `Consequences`

## Identity

Let `agent-issues` assign the ADR id. Do not invent a parallel numbering scheme outside the tracker.

## When to offer an ADR

All three of these must be true:

1. Hard to reverse.
2. Surprising without context.
3. The result of a real trade-off.

If a decision is easy to reverse, skip it. If it is not surprising, nobody will wonder why. If there was no real alternative, there is nothing useful to record.

### What qualifies

- Architectural shape.
- Integration patterns between contexts.
- Technology choices that carry lock-in.
- Boundary and scope decisions.
- Deliberate deviations from the obvious path.
- Constraints not visible in the code.
- Rejected alternatives when the rejection is non-obvious.