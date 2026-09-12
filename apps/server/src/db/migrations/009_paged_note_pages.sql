-- Seed the page rows now used as the authoritative page count for paged notes.
INSERT INTO pages (owner_id, note_id, page_index, width, height, background)
SELECT note.owner_id, note.id, page_index, 816, 1056, note.background
FROM notes note
CROSS JOIN LATERAL generate_series(
  0,
  GREATEST(
    0,
    COALESCE(
      (
        SELECT floor(MAX(object.y + object.height - 1) / 1080)::integer
        FROM canvas_objects object
        WHERE object.owner_id = note.owner_id AND object.note_id = note.id
      ),
      0
    )
  )
) AS page_index
WHERE note.canvas_mode = 'paged'
ON CONFLICT (note_id, page_index) DO NOTHING;
