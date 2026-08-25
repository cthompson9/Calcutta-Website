---
name: Trade workflow
description: Lifecycle and audit constraints for commissioner trade decisions, corrections, and voids.
---

Trades always begin pending. A commissioner may approve or reject a pending
trade, and may correct an approved trade to rejected or voided. A void requires
an explicit confirmation and non-empty explanation; it preserves the original
approval audit and records a separate timestamp and trusted channel. A rejected
correction or void no longer contributes to signed positions, ownership, or
returns.
Deleting a pending trade is also a commissioner action: the server must require
the bearer credential, and the user interface must not expose the destructive
control until that key has passed read-only validation for the current session.

**Why:** The application authenticates one shared commissioner credential rather
than individual user accounts. Audit records can truthfully identify the trusted
channel that processed an action, but must not claim an individual identity or
store credentials.

**How to apply:** Keep status transitions serialized with season ownership
writes, preserve both decision and void audit records, and rebuild positions
after every ownership-affecting transition. Any API or MCP decision request
must require the commissioner credential and explicit confirmation.