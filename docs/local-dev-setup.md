# Local development setup: local auth, no Azure required

This guide covers `LocalAuthProvider`, the dev-only second implementation of
the auth-provider seam (ADR12, ADR21). It lets you exercise `agent-issues
auth login`/`logout`/`status`/`switch` end to end without a real Entra ID
tenant, a human browser step, or any network call.

If you're looking for the production Entra ID setup instead, see
[`docs/auth-entra-id-setup.md`](auth-entra-id-setup.md).

## Why this exists

The cloud path (auth seam, cloud API, Postgres) is otherwise only
verifiable against real Azure infrastructure: a tenant app registration and
a human completing an interactive device-code login. That's a real barrier
for local development, CI, and AFK agent work. `LocalAuthProvider` behind
the same `AuthProvider` seam removes that barrier for anything that isn't a
production deployment.

**`LocalAuthProvider` is dev-only tooling.** It must never be wired up as
the default provider in a deployed environment - only ever behind an
explicit opt-in.

## Using it today

```bash
agent-issues auth login --local --secret <any-shared-secret>
agent-issues auth status
agent-issues auth switch <tenantId>
agent-issues auth logout
```

- `--local` skips the Entra device-code flow entirely and issues a
  locally-signed dev credential instead - no network call, no Azure tenant.
- `--secret` is required, with no default, so this path can never be
  reached without an explicit opt-in. You can also set it via the
  `AGENT_ISSUES_LOCAL_AUTH_SECRET` environment variable.
- `--tenant-id` defaults to `local-dev` (or `AGENT_ISSUES_LOCAL_AUTH_TENANT_ID`).
- `--user-id` defaults to your OS username (or `AGENT_ISSUES_LOCAL_AUTH_USER_ID`).
- The resulting session is cached exactly like an Entra session, under
  `~/.agent-issues/auth.json`; `auth status`/`auth switch`/`auth logout`
  all work identically regardless of which provider issued the session.

Example:

```bash
$ agent-issues auth login --local --secret dev-only-secret
Logged in as roen (tenant local-dev)
Session expires: 2026-07-09T13:22:21.198Z

$ agent-issues auth status
Logged in as roen (tenant local-dev)
Session expires: 2026-07-09T13:22:21.198Z
```

## What this does not cover yet

Running the cloud API and Postgres locally (so the whole dual-mode cloud
path - not just the auth seam - runs without any Azure dependency) was
tracked under ISS39 (cloud API single Postgres gate) and ISS40
(HttpStore/backend switch). Both are now complete: `PgStore`, the Express
JSON-RPC gate, the change/event stream, and `cloud bind`/`unbind`/`status`
plus `synchronize` all work end to end against the local Postgres started
below (see "Local Postgres"). There's no bundled long-running local cloud
API server yet, though - starting one for manual testing still means
writing a small script that calls `createApiServer` directly with a
`LocalAuthProvider`.

One known gap: `synchronize` currently replicates the `entities` and
`history_entries` tables but not `relations`, so data that depends on
relations (e.g. derived initiative status) can disagree between the local
and cloud copies of the same project until that's fixed (tracked as ISS60).

## Local Postgres (ISS39, partial)

```bash
docker compose up -d
```

This starts a single Postgres 16 container (`agent-issues-local-postgres`,
port 5433, named volume `agent-issues-postgres-data`) with two roles,
created by `docker/postgres-init/01-app-role.sql` the first time the
container initializes its data volume:

- `agent_issues` / `agent_issues_dev_only` - a Postgres **superuser**
  (created automatically by the official image's `POSTGRES_USER`). Used
  only to run migrations (`migratePgDatabase`). **Never use this role for
  application queries** - Postgres superusers bypass row-level security
  unconditionally, even with `FORCE ROW LEVEL SECURITY` set, so RLS
  (ADR9) would silently do nothing.
- `agent_issues_app` / `agent_issues_app_dev_only` - an ordinary,
  non-superuser role with table-level `SELECT`/`INSERT`/`UPDATE`/`DELETE`
  grants (via `ALTER DEFAULT PRIVILEGES`, so future migrations don't need
  this script updated). `PgStore` always connects as this role, so RLS
  actually applies in local dev the same way it will for the real Azure
  Managed Identity role in production.

Connection strings (plain connection string, matching ADR21's commitment -
no code branching vs. the Azure Managed Identity path):

```
postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues       # migrations only
postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues  # PgStore
```

If you already had a container from before this role was introduced, the
init script won't retroactively run - reset the volume once:
`docker compose down -v && docker compose up -d`.

## Browsing the local Postgres data (pgAdmin)

`docker compose up -d` also starts
[pgAdmin 4](https://www.pgadmin.org/) (`agent-issues-local-pgadmin`,
port 8978) - a web UI for browsing tables, running ad-hoc SQL, and
inspecting data without a desktop client.

```
http://localhost:8978
```

The container runs pgAdmin in **desktop mode** (`PGADMIN_CONFIG_SERVER_MODE=False`),
so the normal pgAdmin login screen is skipped entirely for this local-only
setup. It also disables pgAdmin's master-password prompt
(`PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED=False`) and supplies the database
passwords through `docker/pgadmin/pgpass`, so the bundled connections can
open immediately without any extra credential entry.

Two connections are pre-configured from `docker/pgadmin/servers.json` and
re-applied on every startup (`PGADMIN_REPLACE_SERVERS_ON_STARTUP=True`):

- **agent-issues (admin, bypasses RLS)** - connects as the `agent_issues`
  superuser. Use this to see all tenants' data at once (RLS doesn't apply to
  superusers - see above).
- **agent-issues (app role, RLS enforced)** - connects as `agent_issues_app`,
  the same role `PgStore` uses. Use this to see exactly what a given
  session/tenant sees.

If you reset the pgAdmin volume (`docker compose down -v` or manually
removing `agent-issues-pgadmin-data`), these connections are rebuilt
automatically on next startup - nothing to reconfigure by hand.

If you were already running the old CloudBeaver service, refresh with
`docker compose up -d --remove-orphans` once so Docker cleans up the old
container.
