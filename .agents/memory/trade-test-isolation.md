---
name: Trade test isolation
description: Keeps trade integration fixtures from altering report totals in later cases.
---

Approved trades affect season-wide ownership and owner-report aggregates, even when a test only asserts a single team's position. Use distinct bidders (and, when needed, teams) for approval-audit fixtures, or isolate scenarios by season.

**Why:** A shared fixture can make a later report assertion fail through a valid aggregate position change, obscuring the behavior actually under test.

**How to apply:** When adding a test that approves a trade, check whether subsequent tests calculate totals for either participant. Give the new scenario its own temporary bidders and ensure cleanup follows the season fixture.