<!-- This document defines Aurora's module boundaries, data ownership, and contracts before implementation. -->

# Aurora architecture

## Runtime shape

Aurora has three workspaces:

- `apps/web` is a React PWA. It renders only objects near the viewport, writes edits to IndexedDB first, and synchronizes an ordered outbox over HTTP and WebSocket.
- `apps/server` is the authoritative Fastify service. It owns authentication, authorization, object revisions, regional reads, uploads, search, snapshots, and broadcasts.
- `packages/shared` contains transport schemas and domain types. Neither app may redefine an API payload locally.

A single deployment runs the web/server image with PostgreSQL and a mounted upload directory. PostgreSQL stores relations and one row per canvas object. Uploaded bytes stay on disk under content-derived names.

## Hard boundaries

1. Every persisted record has an `ownerId`, even while the product has one user.
2. The browser never treats local authentication state as authority. The server validates the secure session cookie for every private HTTP or WebSocket request.
3. A note read is regional. The web app requests an axis-aligned viewport plus overscan; no API endpoint returns every canvas object by default.
4. Every mutation carries an operation ID, device ID, object base revision, and client timestamp. The server makes operation IDs idempotent and assigns authoritative revisions.
5. Offline edits enter IndexedDB before network transmission. An acknowledged operation leaves the outbox only after its resulting revision is stored locally.
6. Binary uploads never enter sync messages. Sync carries file metadata and references only.
7. PDF notes retain the original PDF. Annotations use page-relative coordinates, and embedded page references resolve live against the source note.
8. Theme tokens affect presentation only. Persisted canvas coordinates and dimensions do not depend on theme CSS.

## Web modules

- `app`: routing, authenticated shell, error boundaries, and composition only.
- `features/library`: projects, nested folders, notes, favorites, archive, trash, and search.
- `features/canvas`: viewport transforms, four canvas modes, culling, selection, object rendering, pen input, page layout, and exports.
- `features/editor`: rich-text blocks and tables. It exposes serialized ProseMirror JSON, never editor instances.
- `features/pdf`: PDF page rendering, annotation coordinates, and live page-reference objects.
- `features/auth`: setup-token enrollment, passkey login, logout, and reset guidance.
- `sync`: IndexedDB cache, durable outbox, HTTP hydration, WebSocket subscription, retry, and conflict presentation.
- `theme`: the three dark token sets and account-level selection.

Feature modules can depend on `packages/shared` and small shared UI primitives. They must not import server code or reach into another feature's internal state.

## Server modules

- `auth`: one-time bootstrap token, WebAuthn registration/authentication, sessions, and reset command.
- `library`: project, folder, note, archive, favorite, trash, and link operations.
- `canvas`: regional object queries and authoritative object mutation transactions.
- `sync`: idempotent operation ingestion, conflict records, revision acknowledgements, and owner-scoped WebSocket broadcasts.
- `files`: size-limited streaming uploads, content hashing, metadata, and safe downloads.
- `pdf`: PDF-note metadata and source-page reference resolution.
- `search`: PostgreSQL full-text search over permitted text and filenames.
- `history`: 30-day snapshots and restoration.
- `export`: native backup archives plus note export jobs.

Route handlers validate shared schemas, call one domain function, and translate known domain errors. SQL stays in its owning server module.

## Persistence model

Core tables are users, passkey credentials, sessions, projects, folders, notes, pages, canvas objects, files, operations, conflicts, snapshots, and note links. Folders use an adjacency-list parent ID with a transaction check that prevents cycles. Canvas objects store bounds in indexed numeric columns and type-specific payload in JSONB. Object and note revisions increase monotonically inside the same mutation transaction.

Files use immutable content-derived disk paths. Metadata rows control ownership and references. Deleting a note first moves it to trash. A cleanup job removes expired trash, unreferenced bytes, expired sessions, old operations, and snapshots older than 30 days.

## Rendering and performance

The canvas combines an SVG scene for strokes and shapes with positioned HTML for text and media. A simple bounding-box scan is acceptable in the local cache at the target ceiling of 1,000 objects per note. The server uses indexed bounds for regional reads. Rich-text editors mount only for visible or actively edited blocks. Images and PDF pages decode lazily. Pointer movement updates local visuals immediately and persists coalesced operations rather than sending every event.

The practical target is 1,000 objects per note, 1,000 notes total, 25 MB per upload, and visible remote edits within 500 ms on a healthy network.

## Conflict rule

Operations against the current object revision apply normally. An operation against an old revision creates a conflict containing both complete object versions. Independent objects continue syncing. The client presents both versions and sends an explicit resolution operation. Aurora does not attempt character-level rich-text merging.

## File comments

Every source, stylesheet, SQL, shell, YAML, and Markdown file starts with one short comment stating its responsibility or contract. Formats that reject comments, including JSON, are exempt.
