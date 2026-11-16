<!--
Aurora server package.
This package implements the authoritative, owner-scoped Fastify server for Aurora.
It must always run without a live database connection while type checking and running its pure Vitest checks.

Setup:
1. Copy env.example to .env and adjust DATABASE_URL and AURORA_ORIGIN.
2. Create the database schema once per deployment: npm run db:migrate
3. Start the server: npm run dev (or npm start). Aurora has no login; every request acts as the
   single owner, so expose it only through Tailscale Serve (tailnet only).

Useful commands:
- npm run typecheck: type-check without a live database (tsconfig uses noEmit).
- npm test: run pure Vitest checks (never requires a live database).
- npm run db:migrate: apply pending SQL migrations in order exactly once.
- npm run jobs:cleanup: retention cleanup of trash, snapshots, operations, and upload bytes.
-->
