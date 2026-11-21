<!-- Guided practice: how Claude drives a handwritten practice session in Aurora over MCP, and the contracts both runtimes implement. -->

# Guided practice

Claude (running in Claude Code / T3 Code) runs a practice session through an
MCP server hosted by Aurora. Each question appears on a page of a practice
note. You write your answer with the pen and press **Done**. Claude receives
a rendered image of the page, grades it, and draws red marks on your work.
Then you press **Next** (or **Retry** when allowed).

## Connecting Claude

The endpoint is `POST /mcp` (MCP Streamable HTTP, stateless, JSON responses).
Like the rest of Aurora it has no login: it is reachable only inside the
tailnet, and the app-wide origin guard rejects foreign browser origins.

```sh
claude mcp add --transport http aurora https://power-server.tail14d560.ts.net:8443/mcp
```

All MCP actions act as the single Aurora owner.

## Data model

Migration `006_practice.sql`:

- `practice_sessions(id, owner_id, note_id UNIQUE, title, total_questions,
status 'active'|'complete', status_text, options jsonb, created_at, updated_at)`
- `practice_questions(id, session_id, owner_id, idx, page_index, state, attempt,
max_points, points, latest_points, topics text[], prompt_object_id,
created_at, updated_at)`; `state` is one of `awaiting_work`, `submitted`,
  `graded`, `closed`; `UNIQUE(session_id, idx)`
- `practice_events(id bigserial, session_id, question_id, type
'submitted'|'next'|'retry', attempt, created_at, consumed_at)` — the queue
  `practice_wait` drains in order. Persisted so a server restart or a dropped
  MCP call never loses a Done press.

Migration `010_practice_grading_layout.sql` adds `practice_sessions.grading
jsonb` (the session grading policy `{ leniency, rubric? }`, null when unset) and
`practice_questions.card_regions jsonb` (the card layout the browser measured on
the latest Done press).

Shared wire types live in `packages/shared/src/practice.ts`
(`PracticeSession`, `PracticeQuestion`, `PracticeOptions`, `PracticeGrading`,
`practiceSubmitSchema`, `practiceActionSchema`).

## Page geometry

The note uses `canvas_mode = 'paged'`. Page `i` occupies world bounds
`x=0, y=i*(1056+24), width=816, height=1056` (see
`apps/web/src/features/canvas/pageLayout.ts`). The first question uses page 0;
every later question and the summary append a new page row after the note's
last page. Each question stores its `page_index`; inserting a page with "add
page below" shifts the stored indexes of later questions along with their
objects. Adding pages broadcasts `library-changed` so devices reload page counts.

**All MCP coordinates are page-relative** (origin at the page's top-left,
816 × 1056 units). The server adds the page's world offset.

## Canvas objects created by practice

All practice objects are server-created, `locked: true`, and carry
`payload.practice = { questionId | null, attempt, role }` where `role` is
`prompt | mark | label | feedback | solution | summary`.

- `practice-card` (new object kind). Payload `{ variant, html, practice }`,
  `variant` = `prompt | feedback | solution | label | summary`. The web app
  sanitizes `html` with DOMPurify (no scripts, no event handlers, no external
  URLs except `data:` images), renders `$…$` / `$$…$$` / `\(…\)` / `\[…\]` with
  KaTeX, and mounts it in a shadow root with Aurora's practice card base
  stylesheet. Pen input passes through cards (`pointer-events: none`), except
  the solution card's show/hide toggle. The solution card starts collapsed on
  every device (local UI state). `label` cards render as red handwriting-style
  text with a transparent background.
- Ink marks use existing kinds with color `#ff5c5c`:
  - `circle` → `ellipse` (no fill, strokeWidth 3)
  - `box` → `rectangle` (no fill, strokeWidth 3)
  - `underline` / `strike` → `line`
  - `arrow` → `arrow`
  - `check` / `cross` / `path` → `stroke` with generated points (pressure 0.5, baseWidth 3)
  - `text` → `practice-card` variant `label`

Every object insert/delete goes through the canvas object module, bumps the
note revision, and broadcasts `objects-changed` so all devices update live.
Every session/question change broadcasts `practice-changed { noteId, sessionId }`.

## Browser HTTP routes

- `GET /api/practice/notes/:noteId` → `PracticeSession` or 404.
- `POST /api/practice/questions/:questionId/submit` body `{ regions? }` →
  requires `awaiting_work`; sets `submitted`, status text "Grading…", queues a
  `submitted` event, and stores `regions` when sent. Returns `PracticeSession`.
  `regions` are the question card's labelled elements (`[data-option]`,
  `[data-region]`, `.final-answer`) measured in the browser
  (`apps/web/src/features/practice/cardLayout.ts`) in card-relative units, with
  KaTeX turned back into `$TeX$` text. Older clients send `{}`.
- `POST /api/practice/questions/:questionId/action` body `{ action }` →
  requires `graded`. `next` → `closed`, status "Writing the next question…"
  (or "Writing your summary…" after the last question). `retry` (only when
  `options.feedback.retry`) → `awaiting_work`, `attempt + 1`. Both queue an
  event. Returns `PracticeSession`.

The web client drains the note's sync outbox before calling submit, so the
server renders the strokes the user sees.

## MCP tools

| Tool                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `practice_html_template`  | Returns the full HTML wrapper (base CSS incl. `.final-answer`, KaTeX from CDN) so Claude can preview a card with T3's `html_preview` at 816 px wide before sending it.                                                                                                                                                                                                                                                                     |
| `practice_list_locations` | `{}` → the user's projects with their folder paths, to offer when asking where the note goes.                                                                                                                                                                                                                                                                                                                                              |
| `practice_start`          | `{ title, totalQuestions, project, folder?, options?, grading? }` → finds or creates the project and folder path (case-insensitive), then a paged note and the session. `grading = { leniency: strict \| standard \| lenient, rubric? }`. Returns `{ sessionId, noteId, appUrl }`.                                                                                                                                                         |
| `practice_post_question`  | `{ sessionId, html, height, maxPoints, topics[] }` → places the prompt card at page `(32, 32)`, width 752. Allowed when no question is open.                                                                                                                                                                                                                                                                                               |
| `practice_wait`           | `{ sessionId, timeoutSeconds? = 50 (max AURORA_PRACTICE_WAIT_MAX_SECONDS, default 900), image? }` → blocks until the next queued event, then consumes it. `submitted` returns the submission metadata plus the page PNG (and a final-answer close-up). `next`/`retry` return text. Returns `{ event: "timeout" }` when nothing happens. A request with `_meta.progressToken` gets an SSE response with a progress notification every 15 s. |
| `practice_get_submission` | `{ questionId, image? }` → re-renders the page (same metadata and images) without consuming events.                                                                                                                                                                                                                                                                                                                                        |
| `practice_grade`          | `{ questionId, points, marks[], feedback?, solution?, statusText?, dryRun?, image? }` → requires `submitted`, or `graded` to re-grade before the user presses Next/Retry. Deletes the question's earlier marks/labels/feedback/solution on that page, adds the new ones, records score (`points` only on attempt 1), sets `graded`. `dryRun: true` saves nothing and returns the page image with the proposed marks.                       |
| `practice_set_grading`    | `{ sessionId, grading \| null }` → changes the session grading policy.                                                                                                                                                                                                                                                                                                                                                                     |
| `practice_set_status`     | `{ sessionId, text \| null }` → status line in the practice bar.                                                                                                                                                                                                                                                                                                                                                                           |
| `practice_finish`         | `{ sessionId, summaryHtml, height }` → summary card on the page after the last question; session `complete`.                                                                                                                                                                                                                                                                                                                               |
| `practice_get_session`    | `{ sessionId? }` → state of the given session (any, including completed) or the most recent active one, including `grading`, for resuming after an interrupted chat.                                                                                                                                                                                                                                                                       |
| `practice_list_sessions`  | `{ status?, limit? }` → every session, newest activity first, with questions posted/graded and first-attempt score.                                                                                                                                                                                                                                                                                                                        |

`image` options: `crop: "page" | "ink"` (ink = the user's writing, card
regions and this question's marks plus `padding`, snapped to the 50-unit grid)
and `scale` (pixels per page unit, default 1.5).

### Marks

```jsonc
{ "type": "circle" | "box", "x": 0, "y": 0, "width": 0, "height": 0 }
{ "type": "underline" | "strike" | "arrow", "x1": 0, "y1": 0, "x2": 0, "y2": 0 }
{ "type": "check" | "cross", "x": 0, "y": 0, "size": 28 }
{ "type": "path", "points": [[0, 0], [10, 4]] }
{ "type": "text", "x": 0, "y": 0, "text": "sign error", "width"?: 220 }
```

`circle`, `box` and `text` are anchored at their top-left corner; `check` and
`cross` are centred on `(x, y)`. Marks, feedback and solution cards are
rejected when the session's options turned them off.

Practice cards render below the ink layer, so the user's writing and Claude's
marks stay visible on top of an opaque card. The runtime Docker image installs
`fonts-dejavu-core` so grid numbers and text labels appear in submission images.

## Library tools (notes_*)

The same MCP server also gives Claude read access to the whole library and a
few additive edits. Code: `apps/server/src/agent/`.

| Tool             | Purpose                                                                                                                                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notes_list`     | `{ project?, folder?, archived?, limit?, offset? }` → notes (newest update first) with title, project, folder path, canvas mode, created/updated times. Names match case-insensitively; a folder lists only the notes directly in it.                                                                 |
| `notes_search`   | `{ query, limit? }` → case-insensitive substring search over titles and typed text (rich text, sticky notes, practice cards), with snippets. Handwriting is not searchable.                                                                                                                           |
| `notes_read`     | `{ noteId, pages?, scale? = 1 }` → note metadata, each page's typed text with page-relative bounds, and PNG images of the requested pages (default the first 3, max 8), handwriting included. Practice notes also return `practiceSessionId` and per-page `practiceQuestionId`.                       |
| `notes_create`   | `{ title, project, folder?, canvasMode? = paged }` → new empty note; missing project/folders are created, as in `practice_start`.                                                                                                                                                                     |
| `notes_rename`   | `{ noteId, title }` → renames a note.                                                                                                                                                                                                                                                                 |
| `notes_add_page` | `{ noteId }` → appends a page to a paged note.                                                                                                                                                                                                                                                        |
| `notes_annotate` | `{ noteId, pageIndex, marks[], texts[], dryRun?, scale? }` → adds red marks and comments (same shapes as `practice_grade`) and typed text boxes `{ x, y, width, height?, text }` to one page. Added objects are unlocked so the user can move or delete them. Returns the new ids and the page image. |

There are no delete tools. Every note is read as 816 × 1056 pages in the same
page-relative coordinates and grid as submission images: paged notes use their
pages; infinite and fixed canvases are cut into page-sized tiles on a grid
anchored at the world origin, keeping only tiles with content, in reading
order. Each page reports its world `origin`. Typed text and cards are drawn as
plain text in the images. Uploaded images are embedded, and imported PDF pages
are rasterized with poppler's `pdftoppm` (installed in the Docker image; where
it is missing they are drawn as labelled boxes).

## Submission image

`apps/server/src/practice/render.ts` builds an SVG of one page (or a cropped
part of it) and rasterizes it with `@resvg/resvg-js` (1.5× by default):

- white page, user strokes/shapes in dark ink (light ink colors are darkened
  so they stay readable on white)
- prompt card drawn as a light grey box labelled "Question card", under the
  user's ink so writing on the card (a circled option) stays visible
- measured card regions as dashed blue boxes with their label (`A`, `B`,
  `final answer`, …) and text
- earlier attempts' marks in faded red (only during a retry)
- a faint coordinate grid every 50 units with labels every 100, in page units,
  on the top and left edges of whatever area the image shows

`apps/server/src/practice/submission.ts` and `geometry.ts` add the metadata,
all page-relative: `card`, `regions`, `ink { bounds, clusters }` (clusters
merge strokes within 24 units), `freeRegions` (empty rectangles at least
128 × 48, preferring large ones near the ink), `grading`, `image` (area and
scale of the first image) and `finalAnswerImage` (area of the 2× close-up of
the first `.final-answer` box, sent as a second image).

## Practice bar (web)

A practice note shows a slim bar below the canvas, with no panel or title of
its own (the note title is already in the top bar):

- the status line when `progress.status`
- **X of N** segmented bar; each finished segment is coloured by
  `latestPoints / maxPoints` (red → amber → green), current segment outlined
- running score `Σ points / Σ maxPoints` of graded questions when
  `progress.runningScore`
- per-topic mastery bars, expanding upward, when `progress.mastery`
- action button: **Done** (awaiting_work), "Grading…" (submitted, disabled),
  **Next** / **Retry** (graded; Retry only with `feedback.retry`)

When a new question appears, the canvas scrolls to its page.

## Running a session (Claude's checklist)

1. If the user has not said where the note goes, call
   `practice_list_locations`, ask them, and wait for the answer. Then
   `practice_start` with that project/folder and the options they asked for.
2. Draft the question HTML, preview it with `html_preview` +
   `practice_html_template` when layout matters, then `practice_post_question`.
3. `practice_wait` until `submitted` (re-call on `timeout`; use a long
   `timeoutSeconds` when the client allows it).
4. Read the image, `practice_grade` with marks in page coordinates, placed
   with `ink` and `freeRegions` and following `grading`. Use `dryRun` to
   preview; call it again to fix marks before the user moves on.
5. `practice_wait` for `next` (post the next question, adapting difficulty)
   or `retry` (wait for the next `submitted`).
6. After the last question, `practice_finish` with a summary.
