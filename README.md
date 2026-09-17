<!-- This file gives operators and contributors the shortest path to understanding and running Aurora. -->

# Aurora

Aurora is a self-hosted, dark-only spatial note app for one person using desktop Chrome and Android Chrome with a stylus.

The repository is built from the contracts in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Layout

- `apps/web` — React PWA; talks only to `/api/...` HTTP routes and `/sync/ws`.
- `apps/server` — authoritative Fastify service; owns auth, library, canvas, sync, files, search, snapshots, and metadata exports.
- `packages/shared` — the single transport contract (zod schemas) used by both runtimes.

## Local development

```sh
npm install
# start PostgreSQL and point the server at it (see apps/server/env.example)
cp apps/server/env.example apps/server/.env   # then edit DATABASE_URL etc.
npm run dev
```

The web dev server (5173) proxies `/api` and `/sync/ws` to the server (8787), so the browser stays same-origin for cookies and WebAuthn.

First run: the server applies migrations automatically at startup and prints a one-time setup token. Enter it in the web UI to create a passkey; afterwards sign in with the passkey.

## Production (Docker Compose)

```sh
cp .env.example .env    # set POSTGRES_PASSWORD, AURORA_COOKIE_SECRET, AURORA_ORIGIN
docker compose up --build -d
```

One image serves both the API and the built web app (`AURORA_WEB_DIST`), with
uploads on the `aurora-uploads` volume and data on `aurora-db`. Migrations run
at container start. Compose also starts a separate, stdlib-only Python runner;
rebuild it with `docker compose up --build -d python` (or rebuild everything
with the command above). The app reaches it only through the root-owned `0600`
Unix socket on the `aurora-python-run` volume—there is no Docker socket,
runner app-data volume, secret mount, or runner network.

The runner accepts a local `POST /run` JSON request (`{"code":"..."}`) and
returns `{"success":boolean,"output":string}`. It accepts at most 16,000
source characters, roughly 16 KB combined output, and a 100 KB JSON response
envelope, runs one request at a time, and kills the script process group on
cancellation, timeout, or finish. Scripts run as `nobody` with no supplemental
groups, a read-only filesystem, a bounded `/tmp`, and CPU/memory/process/file
limits. The process limit is zero: scripts cannot create subprocesses or
threads. This is isolation, not a Python-language sandbox: only stdlib Python
is installed, and untrusted code must stay in this container. To run the
runner's framework-free checks:

```sh
docker compose run --rm python python3 /opt/aurora-python/check.py
```

For non-localhost hosts, terminate TLS in a reverse proxy
(for example Caddy/nginx) that forwards `/`, `/api`, and `/sync/ws` to the app
service, and set `AURORA_ORIGIN`/`AURORA_RP_ID` accordingly — passkeys require a
secure context.

### Retention and exports

Compose starts the application only; it does **not** schedule retention cleanup. If
retention is desired, an operator must explicitly schedule
`docker compose exec -T app npm run jobs:cleanup -w @aurora/server` from the
host (for example, with cron or a platform scheduler). Validate file references
and test the command against a copy of production data before automating it.

`GET /api/export` produces an NDJSON metadata export, not a restorable
backup. It does not include uploaded file bytes and Aurora has no import or
restore workflow. Maintain separate, tested PostgreSQL and upload-volume
backups for disaster recovery.

## Checks

```sh
npm run check        # typecheck + tests for all workspaces
npm run build        # production web build
```
