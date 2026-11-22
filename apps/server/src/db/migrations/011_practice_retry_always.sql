-- Retry is no longer a session option: every graded question offers it. Drop the stored flag.
UPDATE practice_sessions
SET options = options #- '{feedback,retry}'
WHERE options -> 'feedback' ? 'retry';
