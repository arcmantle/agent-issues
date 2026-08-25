# Release notes

## Fixed Entity JSON Contracts

This breaking release removes entity `--view` selection and gives each command one JSON response shape:

- `show <id> --json` returns complete entity content; `show <initiativeId> --json` returns the complete initiative graph.
- `list` and `relations` return summary projections without authored bodies.
- Mutations return compact acknowledgements.
- `list` JSON returns `{ items, total }`, where `total` is the filtered count before `--limit` is applied.
- The redundant `bundle` command is removed; use `show <initiativeId>`.
- Human-readable output is unchanged.
- `list` filters and limits, plus relation type and direction filters, execute in storage so large trackers do not fetch records that will be discarded.

Scripts that need complete entity content must use `show <id>`. Scripts that consume list or relation output must use their summary response shapes.