-- Restore prelude for the production Calcutta database.
-- The backup workflow injects this immediately after pg_dump recreates
-- schema public, before tables and their constraints are restored.
--
-- Production extension inventory (2026-09-02):
--   plpgsql    1.0  (PostgreSQL procedural-language dependency)
--   btree_gist 1.7  (consortium_memberships_no_overlap exclusion constraint)
CREATE EXTENSION IF NOT EXISTS plpgsql WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;