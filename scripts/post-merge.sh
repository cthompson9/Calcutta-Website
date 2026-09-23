#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Schema changes are applied by the API's versioned, additive migration runner
# on startup. Never run drizzle-kit push automatically on a populated ledger.
