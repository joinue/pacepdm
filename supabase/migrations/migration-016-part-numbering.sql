-- PACE PDM Migration 016: Per-tenant part number sequence
-- Adds an atomic counter so the server can hand out PRT-00001, PRT-00002, ...
-- The prefix, zero-padding width, and AUTO/MANUAL mode live in tenants.settings JSONB:
--   { "partNumberMode": "AUTO" | "MANUAL", "partNumberPrefix": "PRT-", "partNumberPadding": 5 }
-- Run this in Supabase SQL Editor.

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "partNumberSequence" INTEGER NOT NULL DEFAULT 0;
