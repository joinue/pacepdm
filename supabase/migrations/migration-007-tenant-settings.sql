-- PACE PDM Migration 007: Tenant Settings JSON Column
-- Run this in Supabase SQL Editor

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "settings" JSONB NOT NULL DEFAULT '{}';
