# Changelog

## 0.4.0

### Added

- **`batch_get_contacts`** — retrieve full details of up to 250
  contacts in a single MCP call. Each entry returns the same
  `ContactRecord` as `get_contact`. All reads are executed in a
  single AppleScript process (no `save`; read-only).
  - Input: `{contact_ids: string[]}` — raw array or JSON-stringified
    array. 1-250 items.
  - Output: `{total, succeeded, failed, results}` where each result
    has `{index, status, contact_id, contact?, error?}`.
  - Partial success: not-found IDs are reported as errors without
    affecting other items.
  - No ALLOWED_GROUPS restriction (read-only; group filtering is the
    caller's responsibility via `list_contacts`).
  - Pre-validates each ID; empty strings are reported as errors
    without running AppleScript.

### Performance notes

| Batch size | Elapsed (iCloud-synced, macOS Sequoia) |
|---|---|
| 100 contacts | ~174s (~1.7s/contact) |

The per-contact cost is dominated by AppleScript's per-person property
reads. The single-process approach is still ~2x faster than calling
`get_contact` 100 times (which incurs 100 `osascript` launches).

`BATCH_GET_MAX` was initially set to 500 but lowered to 250 after
benchmarking: 500 contacts would take ~15min, exceeding osascript's
practical timeout on many systems.

## 0.3.0

### Added

- **`batch_create_contacts`** — create up to 100 contacts in a single
  MCP call. Each entry uses the same field schema as `create_contact`.
  All contacts are created in a single AppleScript execution (one
  `osascript` process, one `save`) for dramatically lower overhead
  compared to calling `create_contact` 100 times.
  - Returns per-item `{index, status, id, name, group_added}` or
    `{index, status, error}`.
  - Partial success: a failing entry does not roll back others.
  - ALLOWED_GROUPS auto-add is applied per item with individual
    `group_added` / `group_warning` reporting.
  - Pre-flight validation (at least one of first/last/organization) is
    checked per item before the AppleScript runs; invalid items are
    reported as errors without affecting others.
  - `contacts` array accepts raw array or JSON-stringified array (same
    `jsonOrArray` pattern as other multi-value fields).

- **`batch_update_contacts`** — update up to 100 contacts in a single
  MCP call. Each entry requires `contact_id` (or `id`) for unambiguous
  lookup; name-based matching is not supported in batch for safety.
  - Same per-item result shape; includes `updated_fields` on success.
  - Array fields (phones/emails/addresses/urls) REPLACE existing
    values, same as single `update_contact`.

### Performance

With batch tools, a 50-contact sync that previously required 50
`create_contact` calls (50 osascript processes + 50 `save` commands)
now uses a single call with one process and one save. Measured 5-10x
faster on a typical iCloud-synced setup.

## 0.2.2

### Fixed

- **`list_contacts` rejected `limit` / `offset` when the MCP client sent
  them as JSON strings.** Same root cause as the array→JSON-string fix
  in 0.2.0 — some clients flatten primitive args to strings. The
  `limit` and `offset` schemas now use `z.coerce.number()` so both
  numbers and numeric strings are accepted. The `summary` flag has its
  own union (avoiding `z.coerce.boolean`, which would treat the literal
  string `"false"` as `true`).

## 0.2.1

Follow-up fixes from a second BNM sync-workflow session on top of 0.2.0.

### Fixed

- **P1 (critical regression from 0.2.0)** — address subfields
  (`city`, `state`, `postal_code`, `country`) were still leaking the
  literal string `"missing value"`. 0.2.0 fixed the top-level optional
  fields but missed the address reader loop. Now guarded both in
  AppleScript (`is not missing value`) and in the JS parser via a
  shared `cleanField()` helper that also protects phones/emails/urls.
- **P2** — `create_contact` no longer requires both `first_name` and
  `last_name`. At least one of `first_name`, `last_name`, or
  `organization` must be provided. Single-name contacts (e.g. "Elvis")
  and organization-only entries are now allowed.

### Added

- **P3** — `get_contact` response now includes a synthesized `formatted`
  string on each address (joined `street, city, state, postal, country`).
  Makes round-trip easier for callers that wrote via `formatted`.
- **P5** — `list_contacts` gains a `summary: true` option that returns
  only `id` + `name` per item (~30B each, ~3× smaller payload). Useful
  for enumerating groups with hundreds of entries. Default `limit` also
  lowered from 100 → 50 to stay safely below MCP tool-output caps.
- **P6** — `update_contact` response now echoes `updated_fields: string[]`
  listing the keys the caller asked to change. Saves a follow-up
  `get_contact` when the caller just needs to confirm what landed.

### Skipped (intentionally)

- **P4** (partial-name fallback on `get_contact`) — id-based lookup is
  the recommended path and is already safe; adding another fallback
  adds ambiguity without clear benefit.

## 0.2.0

Bug fixes from real-world usage in the business-network-management Apple
Contacts sync workflow. Mostly back-compat; one shape change to
`list_contacts`.

### Fixed

- **Schema accepts JSON-stringified arrays.** `phones`, `emails`,
  `addresses`, `urls` now accept either a real array OR a JSON string of
  an array. Some MCP clients serialize complex args as strings; previously
  this raised `Expected array, received string` from zod.
- **`get_contact` no longer leaks the literal string `"missing value"`**
  for unset optional fields (prefix, suffix, nickname, department,
  organization, job_title, first/last name, note). They now return `null`
  as documented. Defensive null filter also added in JS.
- **`has_photo`** is now accurate (was always `true`). Apple Contacts'
  `image of p` returns `missing value` for photo-less contacts; the guard
  was missing.
- **Name lookup fallback.** `get_contact` / `update_contact` /
  `delete_contact` by `name` now try, in order:
  1. exact display-name match (existing behavior)
  2. `first name + last name` when input is two tokens
  3. substring match (`name contains`)
  Previously only #1 worked, so callers had to know the full display name
  including `prefix`/`suffix`.
- **Auto-add to ALLOWED_GROUPS surface failures.** When
  `ALLOWED_GROUPS=Business` is set, `create_contact` now:
  - Validates that the group exists BEFORE creating the contact (no more
    orphan contacts on misconfiguration).
  - Looks up the group via `first group whose name is "..."` for
    cross-account robustness.
  - Returns `{group_added: "..."}` on success or `{group_warning: "..."}`
    on failure (instead of swallowing every error in a `try`).
- **`add_contact_to_group` / `remove_contact_from_group`** now use the
  same `first group whose name is X` lookup form (more robust than
  `group "X"` when the group exists in a non-default account).

### Added

- **`contact_id` alias** on `get_contact`, `update_contact`,
  `delete_contact`. Existing `id` parameter still works. The new alias
  matches `add_contact_to_group` / `remove_contact_from_group`, which
  already used `contact_id`.
- **`list_contacts` pagination.** New params: `limit` (default 100, max
  500), `offset` (default 0). Response shape is now
  `{items, total, offset, limit, next_offset}`. The previous unbounded
  array would routinely exceed MCP token limits on groups with hundreds
  of entries.

### Changed (behavior)

- **`list_contacts` response shape is no longer a bare array.** This is
  the only intentional break from 0.1.x. Callers must read `.items`.
  See `ListContactsResult` in `dist/types.d.ts` for the full shape.

### Manual verification recipe (Issue 6 — auto-add)

The roundtrip script can't reliably auto-test the auto-add path because
it depends on a pre-existing group. To verify by hand on a real machine:

1. In Contacts.app, create a group named e.g. `Business`.
2. Set `ALLOWED_GROUPS=Business` in the MCP server's environment.
3. Restart Claude Desktop so the new env is picked up.
4. Call `create_contact` and verify the new contact appears in the
   `Business` group in Contacts.app.
5. If `group_warning` is returned, the message will identify the cause
   (group missing, cross-account, etc.).

## 0.1.0

Initial release. Fork of `@griches/apple-contacts-mcp` with the full
field schema needed for bidirectional sync.
