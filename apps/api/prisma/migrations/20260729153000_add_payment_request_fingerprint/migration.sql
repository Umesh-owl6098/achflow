-- Legacy migration retained for databases that recorded this migration before
-- the Payment table migration was introduced. The column is added by the later
-- 20260729203000 migration after Payment has been created.
SELECT 1;
