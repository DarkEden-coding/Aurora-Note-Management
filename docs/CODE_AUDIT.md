<!-- Audits Aurora's architecture, maintainability, dead code, and implementation risks as of 2026-09-04. -->

# Code audit

Date: 2026-09-04

## Executive summary

Aurora has sensible top-level boundaries and unusually clear architecture notes for a project of this size. Type checking, all 119 tests, and the production build pass. The main problem is not the workspace layout. It is that several important contracts are only partly implemented.

The most urgent issue is destructive: the cleanup job considers uploaded images unreferenced because image objects store a URL while cleanup searches for a `fileId`. Running cleanup can delete the metadata needed to serve every canvas image. Backups and snapshot restoration also promise more than they preserve. The sync client has race windows that can replace newer IndexedDB state with stale hydration responses.

The server contains a real owner-isolation hole, although Aurora currently presents itself as a one-person app. A bootstrap race can create multiple users, and an object UUID collision or disclosure can then let one owner overwrite another owner's row. Fixing this at the database write boundary is small and worthwhile.

## Scope and method

Reviewed all tracked project files, excluding installed packages and build output. The audit covered:

- `apps/server/src`, tests, and SQL migrations
- `apps/web/src`, PWA files, and tests
- `packages/shared`
- root manifests, Docker configuration, README files, and `docs/ARCHITECTURE.md`
- imports, callers, exports, dependency use, file size, and documented boundaries

Validation run:

- `npm run check`: passed, 119 tests across 18 test files
- `npm run build`: passed
- Vite reported a 1,357.68 kB minified application chunk, 415.80 kB gzip
- No PostgreSQL-backed test suite or CI workflow exists, so database concurrency findings are based on code and schema inspection

Severity means:

- Critical: likely data loss or a direct security boundary failure in a normal supported operation
- High: broken core contract, serious consistency risk, or incomplete recovery path
- Medium: maintainability problem, deployment hazard, or user-visible failure with a narrower trigger
- Low: dead code, drift, or cleanup that should be handled opportunistically

## Ranked findings

### 1. Critical: cleanup breaks uploaded canvas images

Evidence:

- `apps/web/src/features/canvas/CanvasWorkspace.tsx:145-159, 466-490` uploads an image, then persists only `payload.src = "/api/files/<id>"`.
- `apps/server/src/jobs/cleanup.ts:54-75` treats a file as referenced only when an object has `payload.fileId` or a note has `pdf_file_id`.
- The same function deletes the `files` row but intentionally leaves bytes on disk.

Impact: the first cleanup run can remove metadata for every uploaded image. `/api/files/:id` then returns not found, while the orphaned bytes remain on disk with no metadata from which to recover the relationship.

Recommendation: store `fileId` in image payloads and derive the download URL when rendering. Before enabling deletion, migrate existing `src` values or make cleanup recognize the current URL form. Delete metadata and bytes as one coordinated operation.

### 2. High: snapshot restore does not restore the snapshot

Evidence:

- `apps/server/src/history/snapshots.ts:31-35, 60-105` records note metadata, pages, and objects.
- `apps/server/src/history/snapshots.ts:127-190` restores only canvas objects. It does not restore the note title, kind, canvas mode, background, folder, or pages.
- The function comment says the note should match the recorded state exactly.

Impact: a successful restore can leave the note in a mixed state assembled from different points in time. Paged content is especially risky because restored objects may refer to pages that were not restored.

Recommendation: either restore all fields and pages transactionally, or narrow snapshots to objects and say so in the API and UI. The current middle ground is misleading.

### 3. High: backup output cannot recover the dataset

Evidence:

- `apps/server/src/backup/export.ts:49-179` exports projects, folders, notes, pages, objects, and file metadata through separate queries.
- It omits uploaded bytes, `notes.pdf_file_id`, note links, and snapshots.
- There is no restore/import path.
- The queries do not share a repeatable-read transaction, so concurrent edits can produce an internally inconsistent export.

Impact: the endpoint named "backup" cannot restore attachments, PDFs, links, or history. Operators could discover this only after data loss.

Recommendation: either rename it to metadata export, or produce a versioned archive containing a consistent relational snapshot and content-addressed file bytes. Add one round-trip restore test before calling it a backup.

### 4. High: owner isolation fails at the canvas upsert boundary

Evidence:

- `apps/server/src/sync/ingest.ts:121-171` loads an existing object only within the current owner scope.
- `apps/server/src/canvas/objects.ts:125-181` then uses `ON CONFLICT (id) DO UPDATE` without requiring the existing row's owner to match.
- `apps/server/src/db/migrations/001_core.sql:39-170` uses global UUID primary keys but does not enforce owner consistency between projects, folders, notes, pages, objects, files, conflicts, and operations.

Impact: if two owner rows exist and one client submits another owner's object ID, the conflict path can update the other owner's object while retaining its old `owner_id`. This corrupts both owners' relationships and breaks the documented ownership boundary.

Recommendation: make the upsert reject owner mismatch in SQL and check that a row was returned. Add owner-consistent composite keys or constraints for parent relationships. Test cross-owner IDs against every mutation route.

### 5. High: overlapping hydration can replace newer local state

Evidence:

- `apps/web/src/sync/hydrate.ts:36-103` applies every response with unconditional `bulkPut`, then deletes cached objects absent from that response.
- `apps/web/src/sync/engine.ts:206-230` does not cancel, order, or version hydration requests.
- A WebSocket update can be stored before an older HTTP request finishes.

Impact: a slow, stale viewport response can overwrite a newer revision or delete an object received from WebSocket. The canvas may show the wrong state until another hydration happens, and IndexedDB keeps the stale result across reloads.

Recommendation: allow only the newest hydration generation for a note to mutate the cache. Also merge objects by revision. Deletion needs a server watermark or snapshot token so absence can be interpreted safely.

### 6. High: offline library state cannot reconstruct the library

Evidence:

- `apps/web/src/sync/db.ts:48-65` persists notes but has no project or folder tables.
- `apps/web/src/features/library/LibraryContext.tsx:84-111` falls back to cached notes after a failed library request while leaving projects and folders empty.
- `apps/web/src/features/library/LibrarySidebar.tsx:327-370` renders notes through the project tree.

Impact: on an offline launch, cached notes generally have no route into the UI. This conflicts with the documented offline-first behavior.

Recommendation: persist the project and folder summaries beside notes, then load all three before the network refresh. One cached library snapshot would also be enough for this single-user app.

### 7. High: note metadata edits silently lose failures

Evidence:

- `apps/web/src/features/library/LibraryContext.tsx:241-283` updates favorite, trash, restore, and title locally, then discards API errors.
- These mutations do not use the durable canvas outbox and do not roll back.
- `apps/web/src/shell/AuthenticatedShell.tsx:22-31` treats title commit as fire-and-forget.

Impact: an offline or failed edit looks successful but can disappear on refresh. Trashing a note can remove it from the visible list even though the server rejected the operation.

Recommendation: either queue metadata edits durably or await the request and roll back with a visible error. Do not silently catch these failures.

### 8. Medium: retention cleanup is not scheduled

Evidence:

- `apps/server/package.json` exposes cleanup only as `npm run jobs:cleanup`.
- `compose.yaml` and `Dockerfile` start only the application process.
- `apps/server/src/jobs/cleanup.ts` contains no scheduler.
- `docs/ARCHITECTURE.md` describes cleanup as part of the persistence lifecycle.

Impact: trash, expired sessions, old operations, snapshots, and file metadata remain indefinitely unless an operator separately schedules the command. The server README implies upload bytes are cleaned, but they are not.

Recommendation: document an explicit host cron requirement, or add a small scheduled container. Fix finding 1 before scheduling it.

### 9. Medium: the singleton bootstrap is not atomic

Evidence:

- `apps/server/src/auth/bootstrap.ts:17-26` selects the oldest user and inserts when absent without a lock or singleton constraint.
- `apps/server/src/db/migrations/001_core.sql:6-12` permits any number of users.
- Login and status paths continue selecting the oldest user.

Impact: concurrent first starts or setup requests can create multiple owners. A passkey may attach to one row while later login targets another. This also makes finding 4 reachable despite the single-user product assumption.

Recommendation: represent the one owner with a fixed key or singleton constraint and create it atomically.

### 10. Medium: migrations race during multi-instance startup

Evidence:

- `apps/server/src/index.ts:29-39` runs migrations in every application process.
- `apps/server/src/db/migrate.ts:26-55` reads applied names and runs non-idempotent DDL without an advisory lock.

Impact: two instances starting against a fresh or upgrading database can both select a migration as pending. One then fails after the other creates the objects.

Recommendation: hold a PostgreSQL advisory lock while reading and applying migrations. A separate deployment migration step is also valid.

### 11. Medium: the main canvas module has become the architecture

Evidence:

- `apps/web/src/features/canvas/CanvasWorkspace.tsx` is 2,036 lines.
- It owns cache hydration, remote merge policy, upload transport, history, object creation, gesture state, keyboard commands, selection, drawing styles, viewport behavior, rendering, and custom scrollbars.
- Four hook dependency warnings are suppressed at lines 319, 649, 975, and 1,358.
- Most behavior tests target extracted geometry helpers, not the component's state transitions.

Impact: changes to input handling, persistence, and rendering collide in one closure-heavy component. The ref mirrors used to keep callbacks fresh make stale-state behavior hard to reason about. This is the clearest long-term maintenance problem in the web app.

Recommendation: split by existing responsibilities, not by arbitrary size. The useful seams are a canvas document/state hook, gesture controller, image import helper, and rendering component. Keep the pure geometry modules as they are.

### 12. Medium: critical database workflows lack integration tests

Evidence:

- Server tests cover environment parsing, file path helpers, library mapping, and sync classification.
- There are no database-backed tests for migrations, bootstrap concurrency, ownership, sync ingestion, conflict resolution, snapshot restore, backup, or cleanup.
- No `.github` workflow is tracked.

Impact: the passing test suite does not exercise the code behind the highest-severity findings.

Recommendation: add a small PostgreSQL integration suite for cleanup references, cross-owner object IDs, operation retry/idempotency, snapshot restore, and backup completeness. These few workflows matter more than broad unit coverage.

### 13. Medium: transport contracts are still redefined in both apps

Evidence:

- `docs/ARCHITECTURE.md:9-15, 22-23` says `packages/shared` is the single transport contract and neither app may redefine payloads.
- `apps/server/src/library/map.ts:11-36` defines `NoteJson` and `PageJson` locally.
- `apps/web/src/features/library/api.ts:20-52` defines separate project, folder, and note response shapes and manually maps them.
- `apps/server/src/canvas/objects.ts:9-14` and `apps/server/src/history/snapshots.ts:25-35` also keep response contracts server-local.

Impact: endpoint changes can type-check independently while client and server disagree. The shared tree contract avoids this problem, but the rest of the API does not follow the stated rule.

Recommendation: move only the payloads actually crossing the network into `packages/shared`. Parse responses at the client boundary where malformed server data would otherwise become trusted casts.

### 14. Medium: trash has no recovery path in the UI

Evidence:

- `apps/web/src/features/library/LibraryContext.tsx:257-276` implements `restoreNote`.
- `apps/web/src/features/library/LibrarySidebar.tsx:327-370` has no trash view and filters trashed notes out.
- `restoreNote` and `apps/web/src/features/library/api.ts:210-212` `deleteNoteForever` have no callers.

Impact: "Move to trash" behaves like deletion from the user's point of view. The advertised recovery mechanism is unreachable.

Recommendation: add a minimal Trash section with restore and permanent delete, or remove the unused recovery API and label deletion honestly.

### 15. Medium: uploaded SVG can be served as active same-origin content

Evidence:

- `apps/server/src/files/routes.ts:27-39` trusts the multipart MIME string after syntax cleanup.
- `apps/server/src/files/routes.ts:64-84` serves every `image/*`, including SVG, inline.
- `apps/server/src/app.ts:50-54` disables Content Security Policy.

Impact: an uploaded SVG opened directly can run as active content on the authenticated application origin. The present single-user model limits who can upload it, but imports and future sharing would make this a stored script injection path.

Recommendation: force SVG to download, reject it, or serve uploads from a separate origin with a restrictive policy. Do not classify inline safety by the `image/` prefix.

### 16. Low: the production bundle is monolithic

Evidence:

- The production build emitted one 1,357.68 kB minified JavaScript chunk, 415.80 kB gzip, and Vite warned about its size.
- `apps/web/src/features/canvas/ObjectRenderer.tsx` imports PDF and rich-text rendering into the always-loaded canvas path.

Impact: desktop may tolerate this, but Android PWA startup parses PDF.js and Tiptap code before those object types are needed.

Recommendation: lazy-load PDF and rich-text object renderers. Do this after correctness work, and only if startup measurement confirms the cost.

## Dead code and avoidable surface

These are confirmed by repository-wide caller searches.

- `delete:` `RecentNote` is unused. Remove it. [`apps/web/src/features/library/types.ts:11-15`]
- `delete:` `deleteNoteForever` and `restoreNote` are unreachable without a trash UI. Either add that UI or remove them. [`apps/web/src/features/library/api.ts:210-212`, `apps/web/src/features/library/LibraryContext.tsx:268-276`]
- `delete:` `deleteFileBytes` has no caller. It currently suggests cleanup support that does not exist. [`apps/server/src/files/store.ts:196-203`]
- `delete:` `connectionCount`, `migrationStatus`, and `pruneExpiredSnapshots` have no production or test callers. Cleanup separately duplicates snapshot pruning. [`apps/server/src/sync/ws.ts:29-34`, `apps/server/src/db/migrate.ts:61-78`, `apps/server/src/history/snapshots.ts:207-214`]
- `delete:` seven schemas in `apps/server/src/library/request-schemas.ts:20-66` have no callers.
- `shrink:` `canvasObjectKindSchema` is imported but unused by the library routes. [`apps/server/src/library/routes.ts:6-11`]
- `shrink:` `noteKindSchema` redefines the shared enum while the file says shared schemas are authoritative. Re-export `noteKindSchema` from `@aurora/shared`. [`apps/server/src/library/request-schemas.ts:3-14`]
- `shrink:` `apps/web/src/features/canvas/index.ts` exports nearly the entire feature internals, although production has one external consumer, `MainEditor`, which needs only `CanvasWorkspace`. Keep test imports direct and reduce the barrel to the actual boundary.
- `delete:` `zod` is a direct dependency of `@aurora/web` but web source never imports it. The shared workspace already owns its own `zod` dependency. [`apps/web/package.json`]

Likely cleanup: about 100 to 160 lines and one direct dependency. This is not the main payoff. The recovery and sync fixes matter much more.

## What is working well

- Workspace ownership is clear: web, server, and shared contracts have distinct jobs.
- SQL is kept in server domain modules rather than leaking into route composition.
- Canvas geometry and sync classification are mostly pure and well tested.
- Sync operations have explicit IDs, revisions, device IDs, and persisted outbox rows.
- File paths are content-derived and guarded against traversal.
- Shared Zod schemas cover the most important canvas and sync payloads.
- Strict TypeScript settings are enabled, including unchecked index access and exact optional properties.

## Recommended order

1. Fix image file references and add a cleanup regression test. Do not schedule cleanup before this.
2. Make canvas upserts owner-safe and make bootstrap singleton creation atomic.
3. Decide what "snapshot" and "backup" mean, then make their behavior match those names.
4. Serialize or version hydration cache writes.
5. Make metadata edits recoverable and persist the complete offline library tree.
6. Add five focused PostgreSQL integration workflows around the failure modes above.
7. Split `CanvasWorkspace` along its current responsibilities.
8. Remove dead exports, unused schemas, and the unused web `zod` dependency.

## Verified follow-up status

Fixed and checked on 2026-09-04:

- [x] Image objects persist `fileId`, cleanup recognizes both new and legacy references, and unreferenced bytes are reclaimed under a digest lock.
- [x] Snapshot restore now restores note metadata, pages, and objects in one transaction.
- [x] `/api/export` is an explicitly metadata-only, repeatable-read export. Disaster recovery still requires PostgreSQL and upload-volume backups.
- [x] Canvas upserts reject cross-owner UUID conflicts. Bootstrap creation and migrations use PostgreSQL advisory locks.
- [x] Hydration uses per-note generations, revision-aware merges, and start-of-request deletion snapshots.
- [x] IndexedDB stores projects and folders. Trash, restore, permanent delete, and metadata mutation failures are visible in the library UI.
- [x] Canvas outbox persistence failures are visible instead of becoming unhandled rejections.
- [x] `CanvasScrollbars` was extracted from `CanvasWorkspace`. PDF and rich-text renderers load in separate chunks.
- [x] Rectangle and ellipse fills default to transparent and support persisted fill opacity.
- [x] SVG downloads use attachment disposition.
- [x] Confirmed dead imports, schemas, exports, types, and the web workspace's unused `zod` dependency were removed. TypeScript now checks unused locals and parameters.
- [x] CI runs type checking, tests, and the production build.
- [x] Full PDF-note creation is rejected until its storage and resolution workflow exists; direct PDF page-reference rendering remains supported.
- [ ] PostgreSQL-backed integration tests remain desirable. Current database hardening tests check pure behavior and SQL source contracts because the local test suite has no managed PostgreSQL fixture.

## Over-engineering tally

`net: -100 to -160 lines, -1 direct dependency possible.`
