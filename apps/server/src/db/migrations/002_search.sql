-- Adds generated tsvector columns and GIN indexes backing Aurora's PostgreSQL full-text search.
ALTER TABLE notes
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', title)) STORED;
CREATE INDEX notes_search_idx ON notes USING gin(search_vector);

ALTER TABLE files
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', original_name)) STORED;
CREATE INDEX files_search_idx ON files USING gin(search_vector);

CREATE INDEX canvas_objects_text_search_idx ON canvas_objects
  USING gin (to_tsvector('english', coalesce(payload ->> 'text', '')))
  WHERE kind IN ('rich-text', 'sticky-note');
