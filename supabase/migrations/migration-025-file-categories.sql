-- Expand FileCategory enum with additional engineering document types.
-- Postgres requires each ADD VALUE to be its own statement.
ALTER TYPE "FileCategory" ADD VALUE IF NOT EXISTS 'DRAWING_2D';
ALTER TYPE "FileCategory" ADD VALUE IF NOT EXISTS 'MODEL_3D';
ALTER TYPE "FileCategory" ADD VALUE IF NOT EXISTS 'SIMULATION';
ALTER TYPE "FileCategory" ADD VALUE IF NOT EXISTS 'FIRMWARE';
ALTER TYPE "FileCategory" ADD VALUE IF NOT EXISTS 'SOFTWARE';
-- PURCHASED was already in the schema but not exposed in the UI; no ADD needed.
