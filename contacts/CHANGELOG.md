# Changelog

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
