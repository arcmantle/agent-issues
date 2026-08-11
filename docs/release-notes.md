# Release notes

## Compact JSON default

This breaking release changes the default JSON response shape for entity commands:

- Entity commands using `--json` now return compact projections by default.
- Mutation acknowledgements are compact by default.
- `list` JSON returns `{ items, total }`, where `total` is the filtered count before `--limit` is applied.
- Pass `--view full` to restore the former full-fidelity entity, relation, or bundle response, including authored body content.
- Human-readable output is unchanged.
- `list` filters and limits, plus relation type and direction filters, execute in storage so large trackers do not fetch records that will be discarded.

Scripts that depend on complete entity records or the former list array shape must add `--view full` or migrate to the compact response shape.