<!-- This file gives operators and contributors the shortest path to understanding and running Aurora. -->

# Aurora

Aurora is a self-hosted, dark-only spatial note app for one person using desktop Chrome and Android Chrome with a stylus.

The repository is built from the contracts in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Layout

- `apps/web` — React PWA; talks only to `/api/...` HTTP routes and `/sync/ws`.
- `apps/server` — authoritative Fastify service; owns auth, library, canvas, sync, files, search, snapshots, backups.
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
at container start. For non-localhost hosts, terminate TLS in a reverse proxy
(for example Caddy/nginx) that forwards `/`, `/api`, and `/sync/ws` to the app
service, and set `AURORA_ORIGIN`/`AURORA_RP_ID` accordingly — passkeys require a
secure context.

## Checks

```sh
npm run check        # typecheck + tests for all workspaces
npm run build        # production web build
```
