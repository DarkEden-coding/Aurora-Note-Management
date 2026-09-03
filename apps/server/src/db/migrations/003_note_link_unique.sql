-- Adds the uniqueness guarantee required by idempotent note-link creation.
-- The coalesce expression makes a NULL target_page_index participate in uniqueness.

CREATE UNIQUE INDEX note_links_source_target_idx
  ON note_links (source_note_id, target_note_id, coalesce(target_page_index, -1));
