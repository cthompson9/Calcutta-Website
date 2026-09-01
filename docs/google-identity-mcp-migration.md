# Google Identity and Scoped MCP Migration

## Decision summary

Adopt Google OpenID Connect (OIDC) for human sign-in, behind a server-side
identity/session layer. Store the provider's immutable `iss` + `sub` pair as
the external identity key. Do not use an email address, display name, MCP
client ID, or bidder name as an identity key.

Keep the existing static credentials as separate service principals during the
migration:

- `MCP_API_KEY` remains a legacy ordinary MCP principal. It is not a human
  identity and cannot approve trades or perform commissioner mutations.
- `ADMIN_API_KEY` remains a separate static commissioner automation principal.
  It is never entered into the OAuth approval page, issued as an OAuth token,
  or accepted as a tool argument.
- A Google-authenticated user receives a web session or an MCP OAuth token
  carrying the same application principal. The token identifies the user; it
  does not itself grant commissioner access.
- Commissioner access is an explicit server-side role/capability assignment
  with reauthentication (and MFA if the selected identity layer supports it).
  It is not granted because a client asks for an `admin` scope.

Introduce user-to-bidder links before allowing identity-bound trade actions.
The link is an authorization relationship, not an automatic merge of people
with similarly named bidder rows. Existing bidder IDs, ownership, consortium
membership, trade history, and historical rosters remain authoritative.

Add counterparty acceptance and an append-only event history additively.
Existing `trades.status` values and the current commissioner approval boundary
continue to work for legacy records and clients. New identity-bound proposals
must receive acceptance from the linked counterparty before a commissioner can
approve them. No pending or accepted proposal changes positions, ownership,
standings, or returns.

## Current system constraints

The migration must preserve these observed contracts and invariants:

1. `/api/mcp` is stateless streamable HTTP. OAuth access tokens and
   `MCP_API_KEY` are ordinary principals; the distinct `ADMIN_API_KEY` is
   required for commissioner-only MCP tools.
2. The current OAuth flow is a public-client authorization-code flow using
   PKCE S256. Its only scope is `mcp`, its authorization page verifies the
   shared `MCP_API_KEY`, and the OAuth token tables currently do not carry a
   human subject.
3. `create_trade` is the intentional ordinary-principal write exception. It
   resolves existing bidders by unambiguous name and inserts a `pending`
   trade. Existing REST `POST /api/trades` has the same pending behavior and
   currently accepts bidder IDs supplied by the caller.
4. Commissioner status changes are protected separately. A pending trade may
   become `approved` or `rejected`; an approved trade may be corrected to
   `rejected` or `voided`. Voiding requires an explicit reason and preserves
   the audit fields.
5. Only approved trades create signed position legs. Rejected and voided
   trades do not affect the position ledger. Approved-trade decisions and
   ownership-affecting changes use the per-season PostgreSQL advisory lock.
6. Bidder rows are named economic participants. Consortium membership is
   attached to a bidder over a date interval, with at most one active
   consortium per bidder. Consortium membership is not a login credential.
7. Historical roster records may retain a bidder link, but source labels and
   historical as-of membership are evidence that must not be rewritten by a
   later login or consortium change.

These constraints make a direct replacement of the shared OAuth bootstrap
unsafe: it would either make old OAuth tokens ambiguous or accidentally turn a
human login into a commissioner credential.

## Identity provider and stable identifiers

### Provider choice

Use Google OIDC as the upstream human identity provider, with the application
consuming verified server-side OIDC claims through one identity/session
adapter. A managed identity layer such as Clerk may provide the web session
and Google connection, but the domain model must not depend on a provider's
mutable email or display-name fields. The adapter should expose the same
verified principal shape whether the first implementation uses a managed
provider or a direct Google OIDC client.

The adapter must:

- validate issuer, audience, signature, nonce, state, redirect URI, and
  authorization-code PKCE according to the selected OIDC library;
- accept only claims from the configured Google tenant/client;
- use the authorization-code flow; never accept an ID token posted by the
  browser as proof of identity;
- treat `email`, `email_verified`, name, avatar, and locale as profile
  attributes, not primary keys;
- normalize no identity by fuzzy name matching;
- support account disablement and session/token revocation;
- log authentication events without logging raw ID tokens, access tokens,
  refresh tokens, authorization codes, or cookies.

### External identity key

The durable key is:

```text
identity_provider = "google"
issuer = the validated OIDC issuer URL
subject = the validated OIDC `sub` claim
```

Enforce a unique constraint on `(issuer, subject)`. Keep `issuer` even when
there is only one Google tenant today: OIDC subject identifiers are scoped to
an issuer/client configuration, and retaining the issuer prevents a future
provider or tenant migration from silently colliding identities.

The application user is an internal random/serial ID. It is the foreign key
used by sessions, OAuth tokens, bidder links, roles, and audit events. Never
put the Google email in a foreign key or infer a bidder link from a matching
email.

### Proposed identity tables

These are migration targets, not a request to push the schema automatically:

```text
app_users
  id                 primary key
  status             active | suspended
  display_name       current profile attribute
  created_at
  updated_at

auth_identities
  id                 primary key
  user_id            -> app_users
  issuer             text
  subject            text
  email              nullable profile attribute
  email_verified     nullable profile attribute
  last_seen_at
  created_at
  unique (issuer, subject)

user_bidder_links
  id                 primary key
  user_id            -> app_users
  bidder_id          -> bidders
  link_status        pending | active | revoked
  link_role          owner | delegate
  linked_at
  linked_by          principal/audit reference
  revoked_at
  revoked_by
  unique (user_id, bidder_id) for active links

user_capability_grants
  id                 primary key
  user_id            -> app_users
  capability         read | propose_trade | accept_trade | commissioner
  scope_json         optional pool/season restriction
  status             active | revoked
  granted_at
  granted_by
  revoked_at
  revoked_by
```

`user_bidder_links` is deliberately many-to-many. One bidder may have multiple
authorized human accounts (for example, an owner and a delegate), and one
human may legitimately represent more than one bidder. A user should have a
selected bidder context for a proposal, but the server must verify that the
context is an active link and that the user cannot change it to an arbitrary
bidder ID.

Only a commissioner or a separate, audited account-linking workflow may create
or revoke a link. A user may request a link, but a self-asserted name,
email-domain match, or Google profile match is not sufficient proof.

## Bidder and consortium implications

### Bidder links

The bidder row remains the owner of economic history. A Google user is an
actor authorized to act for that bidder; it is not a replacement bidder row.
The server resolves these values as follows:

1. Authenticate the Google subject and load the internal `app_users` row.
2. Load active `user_bidder_links` for that user.
3. Require an explicit `actingBidderId` selected from those links for a
   proposal, or derive the only link when exactly one exists.
4. Verify the acting bidder is valid for the selected Calcutta and that the
   proposed trade's seller is that bidder.
5. Write the internal bidder ID into the trade. Never trust a caller-provided
   bidder name or a caller-provided unlinked bidder ID.

Existing duplicate-looking bidder names must be resolved by the existing
unambiguous rules and then explicitly linked. Identity migration must not
merge bidder rows or rename ownership history as a side effect.

### Consortiums

Consortiums remain shared economic/reporting identities. A consortium is not a
Google group, an authentication role, or an automatic delegation boundary.
Current and historical consortium membership continues to be determined by the
bidder's dated membership rows.

A user linked to a bidder may act for that bidder only. The link does not
automatically authorize the user to act for every member of the bidder's
consortium, to change consortium membership, or to view another member's
private account metadata. If consortium-level actions are ever needed, add an
explicit, dated consortium delegation with its own grant/revocation audit; do
not infer it from the reporting relationship.

When a bidder's consortium changes, existing user links do not move. Historical
reports continue to use each Calcutta's fixed as-of roster and membership
rules. A new login link cannot rewrite a historical consortium assignment.

### Legacy records

All existing bidder IDs, trade rows, position rows, auction results, and
historical rosters remain usable without an `app_users` row. Mark their actor
as `legacy_mcp`, `legacy_rest`, or `admin_api_key` when an audit event is
backfilled; do not invent a Google identity.

Backfill is limited to structural relationships that are provable:

- create no automatic user-to-bidder link from a name or email;
- retain existing `from_bidder_id` and `to_bidder_id`;
- treat old `pending` trades as legacy proposals that remain eligible for the
  current commissioner decision path;
- do not require counterparty acceptance retroactively;
- do not assign old OAuth tokens to a guessed user;
- leave historical roster `source_owner_label` and as-of membership intact.

After a human explicitly claims a bidder through an audited workflow, newly
created identity-bound actions can use that link. Claiming a bidder does not
change old actor attribution.

## One principal and capability model

Every request is converted once into an immutable server-side principal
before a route or MCP tool performs side effects. Capabilities are checked
from that principal and from resource ownership, never from tool arguments.

```text
Principal {
  kind: "user" | "service"
  principalId: internal app_user ID or stable service name
  authSource: "google_session" | "mcp_oauth" |
              "mcp_api_key" | "admin_api_key"
  userId: optional internal app_user ID
  linkedBidderIds: resolved active links, user principals only
  capabilities: server-derived set
  tokenId/sessionId: optional revocation handle
  requestId: correlation ID
}
```

The capability names below are policy names, not OAuth scope strings. OAuth
scopes are a coarse transport consent mechanism; the server still performs
resource and role checks for every request.

| Transport | Principal | Default capabilities | Explicit prohibitions |
| --- | --- | --- | --- |
| Web session | Google user | `pool:read`; `trade:propose` for linked bidder; `trade:accept` for linked counterparty | no arbitrary bidder selection; no commissioner mutation |
| Ordinary MCP OAuth | Google user after OAuth consent | same capabilities as the linked web user, limited to granted `mcp`/trade scopes | no admin capability from requested scope; no unlinked bidder actions |
| Legacy `MCP_API_KEY` | service `legacy_mcp` | existing read tools and legacy `trade:propose` compatibility | no counterparty acceptance, no commissioner mutation, no human attribution |
| Static `ADMIN_API_KEY` | service `commissioner_automation` | existing commissioner API/MCP mutations | no bidder identity, no web session, no OAuth issuance; cannot be supplied as a tool argument |
| Commissioner OAuth | Google user with explicit commissioner grant | ordinary user capabilities plus `commissioner:approve` and only explicitly granted commissioner capabilities | role is checked server-side; Google sign-in alone is insufficient |

The existing rule that equal `MCP_API_KEY` and `ADMIN_API_KEY` do not produce
admin access remains mandatory. Key rotation must support overlap only through
an intentional server-side key version/rotation mechanism, not by treating
both values as equivalent.

### OAuth changes

Keep the current dynamic public-client registration and PKCE protections.
Extend the OAuth records rather than replacing them:

```text
mcp_oauth_clients
  ... existing fields ...
  client_status active | revoked

mcp_oauth_authorization_codes
  ... existing fields ...
  user_id -> app_users, nullable during legacy transition
  principal_kind user | legacy_service

mcp_oauth_tokens
  ... existing fields ...
  user_id -> app_users, nullable for legacy rows
  principal_kind user | legacy_service
  capability_snapshot or granted_scope
  last_used_at
```

Legacy OAuth rows with `user_id IS NULL` remain ordinary, read-only
transport principals. New user OAuth authorization must authenticate Google
before issuing the code. The token endpoint must bind the resulting code to
the same user and client; refresh must preserve the user binding and
capability ceiling. A refresh token must never gain capabilities because the
user's role changed; role revocation must be enforced during access-token
verification or by revoking the token family.

Do not issue a commissioner OAuth scope through the public dynamic registration
flow. If commissioner OAuth is needed, use a separately allowlisted client
and server-side role check, require recent reauthentication, and record the
approval grant. The static admin automation path remains available for jobs
that do not have a human identity.

## Trade proposal and acceptance state machine

### State representation

The current `trades.status` column should remain compatible while the new
workflow is introduced. Add explicit proposal/counterparty fields and an
append-only event table first:

```text
trades (additive fields)
  proposal_expires_at
  proposed_at
  proposed_by_principal
  counterparty_accepted_at
  counterparty_accepted_by_principal
  counterparty_rejected_at
  counterparty_rejected_by_principal
  workflow_version

trade_events
  id                 monotonic primary key
  trade_id           -> trades
  event_type         proposed | counterparty_accepted |
                     counterparty_rejected | expired |
                     commissioner_approved | commissioner_rejected |
                     commissioner_voided | legacy_decision
  from_status        nullable compatibility status
  to_status          nullable compatibility status
  actor_principal    stable internal actor reference
  actor_kind         user | service
  channel            web | mcp_oauth | mcp_api_key |
                     admin_api_key | system
  reason             nullable
  request_id         nullable
  occurred_at
  metadata_json      non-sensitive context only
```

The event table is append-only. Database permissions and application code
must prevent updates/deletes, except for controlled retention operations that
do not remove financial audit evidence.

For new proposals, the effective workflow is:

```text
PROPOSED
  ├─ counterparty accepts ───────────────> COUNTERPARTY_ACCEPTED
  ├─ counterparty rejects ───────────────> COUNTERPARTY_REJECTED (terminal)
  ├─ proposer cancels before acceptance ─> CANCELLED (optional future state)
  └─ expiry worker/read-time transition ─> EXPIRED (terminal)

COUNTERPARTY_ACCEPTED
  ├─ commissioner approves ──────────────> APPROVED
  ├─ commissioner rejects ────────────────> REJECTED (terminal)
  └─ expiry before decision ──────────────> EXPIRED (if policy permits)

APPROVED
  ├─ commissioner voids with reason ──────> VOIDED (terminal)
  └─ commissioner correcting reject ──────> REJECTED (terminal, audited)
```

Compatibility mapping:

- legacy `status = pending` means “awaiting the existing commissioner
  decision.” Legacy proposals bypass the new counterparty gate because there
  is no proof of who submitted or accepted them;
- new `PROPOSED` and `COUNTERPARTY_ACCEPTED` records may both expose
  `status = pending` to old clients, with an additive
  `counterpartyStatus`/`workflowState` field for new clients;
- `COUNTERPARTY_REJECTED` and commissioner rejection expose
  `status = rejected`, but their event type and actor role distinguish them;
- `EXPIRED` is additive. Until all clients understand it, a read response may
  expose `status = pending` plus `workflowState = expired`, while new
  mutation endpoints reject it. Once clients are migrated, add `expired` to
  the documented enum;
- `approved` and `voided` retain their current accounting meaning.

If a later schema migration replaces the compatibility column with one enum,
the externally documented aliases must remain until all API and MCP clients
have moved. Never reinterpret an existing approved row as an unapproved
proposal.

### Transition rules

**Propose**

- A Google user must have an active link to `fromBidderId`; the server derives
  the seller from the selected link.
- `toBidderId` must be an existing, unambiguous bidder and must not equal the
  seller.
- The team, selected Calcutta, percentage, price, and date use the existing
  validation rules.
- The proposal snapshot stores the resolved entry/team/bidder IDs. Later name
  changes do not redirect the trade.
- Default an expiration (for example, 72 hours) server-side and cap caller
  input. Never accept an already-expired proposal.
- Insert the trade and its `proposed` event in one transaction. No position
  rows are inserted.

**Counterparty acceptance**

- Only an active user link to `toBidderId` may accept.
- Acceptance must be a distinct human principal from the proposer. If one
  Google account is linked to both bidders, require commissioner handling or a
  separate verified second principal; do not let one session satisfy both
  sides.
- The accepting user confirms the exact team, percentage, price, and
  counterparty IDs. Any change requires a new proposal, not an in-place edit.
- Accept is idempotent for the same accepted event and rejects conflicting
  second acceptance. It does not create positions.

**Commissioner approval**

- A commissioner principal, static or OAuth, may approve only a fresh row
  whose compatibility status is pending and whose workflow is either a legacy
  proposal or `COUNTERPARTY_ACCEPTED`.
- Inside one transaction, acquire the existing per-season advisory lock,
  reload the row, lock/check its transition and expiry, revalidate the
  selected entry and ownership, append the decision event, update the trade,
  and insert both signed position legs. Commit all or none.
- If a primary ownership correction, another trade decision, or expiration
  wins the race, return a conflict and do not create position legs.

**Rejection and expiration**

- Counterparty rejection is terminal and requires an event; a commissioner
  cannot approve it.
- Commissioner rejection can occur from legacy pending or accepted workflow
  states. It has no position effect.
- Expiration is terminal for new proposals that have not been accepted. A
  scheduled worker is useful for cleanup, but every accept and approval path
  must check the timestamp itself so a delayed worker cannot grant a stale
  trade.
- Expiration and acceptance race through a row lock/conditional update. At
  most one terminal transition succeeds.

**Void/correction**

- Keep the current rule: an approved trade can be corrected to rejected or
  voided only by a commissioner. Voiding requires a non-empty reason,
  removes the trade-derived position legs in the same locked transaction, and
  preserves the original approval plus the void event.
- Do not allow a proposer or counterparty to void an approved trade.
- Do not delete a trade or rewrite an event to repair history. Use a new
  correcting event/trade where the business meaning requires it.

## Backward-compatible API and MCP contracts

### REST

Keep these existing contracts during rollout:

- `GET /api/trades` continues returning the existing trade fields and
  `status` values. Add nullable workflow fields rather than removing or
  renaming current fields.
- `POST /api/trades` continues to create a pending legacy-compatible trade.
  New web clients should use an identity-bound endpoint that derives the
  seller from the session and never accepts an arbitrary `fromBidderId`.
- `PATCH /api/trades/:id/status` remains commissioner-only and continues to
  require the existing explicit confirmation and void reason. It may approve
  only new accepted proposals, while retaining the legacy exception for old
  pending rows.
- `PATCH /api/trades/:id` remains commissioner-only for legacy corrections.
  Identity-bound proposals should be immutable after acceptance.

Add versioned identity-bound operations, for example:

```text
POST /api/v2/trade-proposals
  body: { calcuttaId?, seasonYear, teamId, toBidderId,
          percentage?, price?, tradeDate, notes?, expiresAt? }
  seller: derived from authenticated selected bidder link

POST /api/v2/trade-proposals/:id/accept
POST /api/v2/trade-proposals/:id/reject
GET  /api/v2/trade-proposals/:id/events
```

The exact route names may follow the API package convention, but the
properties are mandatory: server-derived acting bidder, explicit state,
idempotency key for writes, and safe conflict responses (`409`) for stale
transitions. Return both the compatibility `status` and an additive
`workflowState`, `counterpartyStatus`, `expiresAt`, and event summary so old
generated clients continue to parse the response.

### MCP

Keep `create_trade` and `get_trade_status` available. For legacy static-key
clients, retain name resolution and `PENDING REVIEW` behavior. For a
Google-backed MCP OAuth principal:

- accept an optional `actingBidderId` or bidder selector only if it resolves
  to an active user link;
- reject a supplied seller name/ID that is not the linked acting bidder;
- add separate `accept_trade` and `reject_trade` tools whose handlers derive
  the counterparty authorization from the principal;
- keep `set_trade_status` commissioner-only and make its approval gate check
  counterparty acceptance for new workflow-version rows;
- return a structured workflow state in new tool responses while retaining
  the existing human-readable status text for old clients.

Never add a Google access token, admin key, or secret to an MCP tool schema.
Never treat a client-provided `userId`, `principalId`, `isAdmin`, or
`actingBidderId` as authorization evidence. The transport middleware should
resolve the principal once and pass it into the tool context.

## Staged rollout

### Phase 0 — inventory and guardrails

- Freeze the existing `MCP_API_KEY`/`ADMIN_API_KEY` separation as a regression
  contract.
- Add metrics for OAuth token issuance, legacy versus user principals,
  bidder-name trade proposals, and commissioner decisions.
- Add the identity, link, capability, and event tables using additive guarded
  migrations. Do not use an automatic schema push that could truncate
  ownership, MTM, or trade data.
- Keep all new tables empty and deploy read-only principal plumbing first.

### Phase 1 — Google sign-in and explicit linking

- Configure Google OIDC in the identity/session adapter.
- Add login/logout/session revocation and issuer+subject upsert.
- Build a commissioner-reviewed bidder-link flow. Show the exact bidder name
  and ID being claimed; do not auto-link by email or fuzzy name.
- Allow authenticated users to read only their linked bidder views.
- Audit link creation/revocation and test suspended users immediately lose
  capabilities.

### Phase 2 — user MCP OAuth

- Add `user_id`/principal binding to authorization codes and tokens.
- Keep the existing `mcp` scope as a compatibility scope; introduce narrower
  documented capabilities only when the client ecosystem can preserve unknown
  scope behavior.
- Issue user-bound ordinary MCP tokens only after Google authentication.
- Continue issuing legacy OAuth tokens without a user binding as ordinary
  read-only principals. Do not attempt token-to-person backfill.
- Verify that refresh, revocation, client binding, redirect URI validation,
  PKCE, and resource binding remain intact.

### Phase 3 — two-party proposals

- Deploy additive workflow fields and append-only trade events.
- Mark newly created identity-bound trades with a workflow version. Keep old
  REST/MCP trade creation on the legacy path.
- Release accept/reject endpoints and tools to linked users.
- Make commissioner approval require acceptance only for workflow-version rows.
- Add expiration checks and idempotency keys before enabling automated expiry.

### Phase 4 — deprecate unsafe legacy proposal inputs

- Warn on unauthenticated REST proposals and name-based `create_trade`.
- Provide a migration report listing legacy clients and unresolved bidder
  links; never silently assign them.
- After an announced cutoff, keep legacy reads and commissioner decisions but
  require a user principal for new human proposals.
- Retain static service principals for trusted automation until each job has
  its own scoped service identity and rotation plan.

### Rollback

At every phase, rollback means disabling the new route/capability gate, not
deleting identity or event rows. Existing legacy pending trades remain
decidable by commissioners. If a user-token migration is suspect, revoke the
new token family and leave static service paths unchanged. Do not roll back
financial schema or delete audit history as a first response.

## Security and concurrency test plan

### Identity and token tests

- Same Google `iss`+`sub` always resolves to one `app_users` row; changed email
  or display name does not create or move a bidder link.
- Same `sub` under a different issuer does not collide.
- Invalid issuer, audience, nonce, state, signature, redirect URI, or PKCE
  verifier cannot issue a session or code.
- Authorization code is single-use, expires, and is bound to client, redirect
  URI, resource, and user.
- Refresh-token rotation is single-use; revocation prevents future access;
  role/link revocation blocks subsequent capability checks.
- A legacy OAuth token has no user capabilities and cannot be upgraded by
  modifying client input.
- MCP and admin keys remain distinct, and equal configured values never grant
  admin access.
- Secrets and raw tokens never appear in events, tool responses, logs, or
  database columns intended for audit.

### Authorization tests

- A linked user can read their own bidder data but cannot select an unlinked
  seller, accept for an unlinked counterparty, alter consortium membership, or
  call commissioner tools.
- A user linked to multiple bidders must explicitly select the acting bidder.
- A delegate link has only the capabilities granted by its link/role policy.
- One user linked to both sides cannot satisfy two-party acceptance.
- A commissioner OAuth user without the explicit commissioner grant is
  denied; an explicit grant does not broaden ordinary users' bidder links.
- Static admin automation can approve/reject/void but has no human Google
  attribution and cannot issue or impersonate a user token.

### Trade state and race tests

- Propose creates exactly one pending trade and one `proposed` event; no
  positions are created.
- Duplicate accept requests are idempotent; accept after rejection,
  expiration, approval, or void returns a conflict without side effects.
- Counterparty rejection and commissioner rejection are distinguishable in
  events even if the compatibility status is `rejected`.
- Approval before acceptance is rejected for new workflow rows but remains
  available for explicitly marked legacy rows.
- Concurrent accept/expire permits exactly one winner.
- Concurrent approve/reject permits exactly one decision.
- Concurrent approval and primary ownership correction share the season lock;
  the losing operation re-reads and fails safely.
- Concurrent approval requests create one pair of position legs only.
- A void removes only the approved trade's derived legs, preserves the
  approval and void events, and is idempotently rejected on repeat.
- Expired proposals never affect positions, ownership, standings, or returns.

### Compatibility tests

- Existing MCP OAuth discovery, dynamic registration, approval, token,
  refresh, and revoke tests continue to pass.
- Existing `create_trade` and `get_trade_status` clients still understand
  `pending`, `approved`, and `rejected` responses.
- Existing REST trade create/list/status behavior remains unchanged for
  legacy rows.
- New response fields are nullable/optional in generated clients until the
  API schema is intentionally regenerated.
- Historical roster, dated consortium reports, auction results, signed
  positions, and MTM calculations are byte-for-byte or value-for-value
  unchanged by identity linking.

## Operational acceptance criteria

The migration is ready to move from design into implementation only when:

1. Every request path has one principal resolver and an explicit capability
   check; no tool derives authorization from names or input flags.
2. Google identity rows are keyed by issuer and subject, while bidder links
   are explicit, revocable, and audited.
3. Legacy static keys and legacy OAuth tokens remain limited to their stated
   compatibility behavior.
4. New proposals require two distinct linked human principals before
   commissioner approval, and the approval transaction preserves the existing
   season-lock and signed-position invariants.
5. Every state transition has an append-only event and safe idempotency/race
   behavior.
6. The security, state-machine, concurrency, and compatibility tests above
   pass in an isolated test database before enabling the new capabilities in
   production.