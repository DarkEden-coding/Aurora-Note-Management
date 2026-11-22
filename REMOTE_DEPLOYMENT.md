# Aurora remote deployment runbook

This runbook documents the current deployment on `dark@100.107.192.39`.
The production source directory is `/home/dark/apps/aurora`; it is not a Git
checkout. Docker Compose runs the `aurora` project from that directory and
publishes the app on host port `8788`. The public HTTPS proxy is
`https://power-server.tail14d560.ts.net:8443`.

Run the local commands from the Aurora repository root.

## 1. Validate and commit locally

```bash
npm ci
npm run check
npm run build
git status --short
git add <intended-files>
git commit -m "Describe the deployment"
git push -u origin <branch>
```

Do not commit `.env`, setup tokens, database contents, uploads, or deployment
backups.

## 2. Inspect the existing installation

```bash
ssh dark@100.107.192.39 'cd /home/dark/apps/aurora && docker compose ps'
```

Confirm that `/home/dark/apps/aurora/.env` exists. Never print that file into
logs or chat.

## 3. Create a rollback archive

Choose a new, explicit backup filename for each deployment:

```bash
ssh dark@100.107.192.39 'tar -czf /home/dark/apps/aurora-backup-YYYYMMDD-description.tar.gz -C /home/dark/apps aurora && chmod 600 /home/dark/apps/aurora-backup-YYYYMMDD-description.tar.gz'
```

The archive contains `.env`, so it must remain private (`0600`).

## 4. Transfer the committed source

This transfers exactly `HEAD` and preserves the remote `.env` and Compose
volumes because neither is tracked by Git:

```bash
git archive --format=tar HEAD | ssh dark@100.107.192.39 'tar -xf - -C /home/dark/apps/aurora'
```

For an ordinary deployment that preserves application data, rebuild in place:

```bash
ssh dark@100.107.192.39 'cd /home/dark/apps/aurora && docker compose up --build -d && docker compose ps'
```

## 5. Optional clean reset

Only run this when deletion of all Aurora notes, account/passkeys, uploads, and
database state is explicitly intended:

```bash
ssh dark@100.107.192.39 'cd /home/dark/apps/aurora && docker compose down -v --remove-orphans && docker compose up --build -d && docker compose ps'
```

`docker compose down -v` permanently removes the `aurora-db` and
`aurora-uploads` volumes. A clean reset generates a new one-time setup token.

## 6. Read startup status and a fresh setup token

```bash
ssh dark@100.107.192.39 'cd /home/dark/apps/aurora && docker compose logs --no-color --tail=120 app'
```

Look for successful migrations, both server-listening messages, and—after a
clean reset—the `Aurora setup token:` line. Treat that token as a secret and do
not save it in this runbook or Git.

## 7. Verify the deployment

```bash
ssh dark@100.107.192.39 'curl -sS -o /dev/null -w "library_http=%{http_code}\n" http://127.0.0.1:8788/api/library
curl -sS -o /dev/null -w "glass_asset_http=%{http_code} bytes=%{size_download}\n" http://127.0.0.1:8788/assets/aurora-glass-bg.png'
```

There is no login (access is limited to the tailnet), so `library_http=200` is
expected. The static asset should return `200`. Check the startup log for
`Aurora migrations applied at startup: ...` when the release adds migrations,
and hard-refresh the public HTTPS URL in Brave to verify the app visually.

When a release adds migrations that change data, also keep a private database
dump next to the source archive before rebuilding:

```bash
ssh dark@100.107.192.39 'cd /home/dark/apps/aurora && umask 077 && docker compose exec -T db sh -c "pg_dump -U \$POSTGRES_USER -d \$POSTGRES_DB" | gzip > /home/dark/apps/aurora-db-YYYYMMDD-description.sql.gz'
```

## 8. Roll back

Stop the current Compose project, move the failed source directory aside, and
restore the chosen archive. Preserve the current `.env` if it changed after the
backup.

```bash
ssh dark@100.107.192.39 'cd /home/dark/apps/aurora && docker compose down'
ssh dark@100.107.192.39 'mv /home/dark/apps/aurora /home/dark/apps/aurora-failed && tar -xzf /home/dark/apps/aurora-backup-YYYYMMDD-description.tar.gz -C /home/dark/apps'
ssh dark@100.107.192.39 'cd /home/dark/apps/aurora && docker compose up --build -d && docker compose ps'
```

After rollback, inspect `docker compose logs --no-color --tail=120 app` and
repeat the endpoint checks.
