-- Migration: Add two-factor authentication columns to users table
-- Run this to add 2FA support to existing database

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS two_factor_secret TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT FALSE;
