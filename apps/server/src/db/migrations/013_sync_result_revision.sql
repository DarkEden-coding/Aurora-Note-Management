-- Keep the result of a successful edit so its replay can advance the next edit
-- without adopting revisions written by another device in the meantime.
ALTER TABLE operations ADD COLUMN result_revision integer;
