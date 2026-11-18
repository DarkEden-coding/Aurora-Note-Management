-- Session grading policy for Claude, and the browser-measured layout of each question card's labelled elements.
ALTER TABLE practice_sessions ADD COLUMN grading jsonb;
ALTER TABLE practice_questions ADD COLUMN card_regions jsonb;
