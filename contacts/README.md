# apple-mcp-extended

Extended MCP server for Apple Contacts on macOS. **Fork of [griches/apple-mcp](https://github.com/griches/apple-mcp)** (`@griches/apple-contacts-mcp`, MIT). Built to support full bidirectional sync between a local single-source-of-truth `contacts.json` and Apple Contacts (Exchange "Contacts" group) — the upstream's schema is too thin for that.

Published on npm: **[`@gasf030304/apple-contacts-extended`](https://www.npmjs.com/package/@gasf030304/apple-contacts-extended)**.

## What this fork adds

| Concern | Upstream | This fork |
|---|---|---|
| Phone fields | single string, label hardcoded `mobile` | `phones[]` with labels `mobile`/`work`/`home`/`main`/`other` |
| Email fields | single string, label hardcoded `work` | `emails[]` with labels (note: Apple AppleScript ignores email labels — values round-trip cleanly, labels are best-effort) |
| Address | not in create/update; flat string in get | `addresses[]` with `street`/`city`/`state`/`postal_code`/`country`/`label` |
| URLs | none | `urls[]` with labels |
| Birthday | none | `birthday` (`YYYY-MM-DD` or `MM-DD`) |
| Photo | none | `photo` (base64 or absolute file path) |
| Name | first/last only | + `prefix` (Mr./Dr.), `suffix`, `nickname` |
| Org | organization, job_title | + `department` |
| `modification_date` | not exposed | exposed on `get_contact`, `list_contacts`, `batch_get_contacts` (ISO 8601 local time) |
| Note newlines | escaped to literal `\n` (upstream bug) | preserved as real newlines via `& linefeed &` |
| `get_contact` output | bare values, no labels | full structured `ContactRecord` with labels, ids, every field |
| Identifier | name only — silently picks first match | `id` (or `contact_id`) is the preferred identifier; name lookups disambiguated by `phone`/`email` and refuse on ambiguity |
| `delete_contact` safety | name only, picks first | requires `id` OR `name` + `phone`/`email`; errors if multiple matches |
| Group restriction | none | `ALLOWED_GROUPS` env var enforces a whitelist at the code level |
| Pagination | none — `list_contacts` returned everything | `{items, total, offset, limit, next_offset}` with `limit`/`offset` params |
| Change detection | none | `list_contacts` `changed_since` filter (AppleScript-level, no JS post-filter) |
| Bulk operations | none | `batch_create_contacts`, `batch_update_contacts`, `batch_get_contacts` (single AppleScript process for N items) |
| Token efficiency | n/a | `summary="minimal"` mode + `output_file` to bypass MCP token limits |
| Field clear | impossible (`""` was no-op) | `null` = explicit clear, `""` = no change |
| Phone label bug | upstream's `label:"mobile"` silently drops phones on macOS Sonoma+ | uses internal `_$!<Mobile>!$_` form |

## Install

### Option A — via npm (recommended)

No clone needed. Just point your MCP client at the npm package:

```json
{
  "mcpServers": {
    "apple-contacts": {
      "command": "npx",
      "args": ["-y", "@gasf030304/apple-contacts-extended"],
      "env": { "ALLOWED_GROUPS": "Contacts" }
    }
  }
}
```

For reproducible builds, pin a version: `"args": ["-y", "@gasf030304/apple-contacts-extended@0.6.0"]`.

### Option B — local build (for development)

```bash
git clone https://github.com/gasf909/apple-mcp-extended.git
cd apple-mcp-extended/contacts
npm install
npm run build

# Then in claude_desktop_config.json:
# "args": ["/Users/you/Projects/apple-mcp-extended/contacts/dist/index.js"]
```

Requires Node ≥ 18 and macOS with the Contacts app. First run will trigger a "Allow Terminal/Node to control Contacts" permission prompt.

After editing `claude_desktop_config.json`, **fully restart Claude Desktop** (Cmd+Q, then reopen).

## CLI flags

```bash
node dist/index.js                       # basic
node dist/index.js --read-only           # no delete tools registered
node dist/index.js --confirm-destructive # delete tools require confirm:true
ALLOWED_GROUPS=Contacts node dist/index.js
```

## Environment variables

| Var | Default | Effect |
|---|---|---|
| `ALLOWED_GROUPS` | (unset = all groups) | Comma-separated whitelist. When set: `list_contacts` requires a group; `search_contacts` filters results to allowed-group members; `create_contact` auto-adds new contacts to the first allowed group; `update_contact`/`delete_contact` refuse to touch contacts not in any allowed group; `create_group`/`delete_group` reject names not on the list. |

## Tools

| Tool | Purpose |
|---|---|
| `list_groups` | List groups (filtered by ALLOWED_GROUPS) |
| `list_contacts` | Paginated list, with optional `summary` mode and `changed_since` filter |
| `search_contacts` | Substring name search |
| `get_contact` | Full record by `contact_id` (or `id`/`name`) |
| `create_contact` | Single create with full field schema |
| `update_contact` | Single update; `null` = clear field |
| `delete_contact` | Requires `contact_id` OR `name` + `phone`/`email` (refuses on ambiguity) |
| `create_group` / `delete_group` | Group lifecycle |
| `add_contact_to_group` / `remove_contact_from_group` | Group membership |
| **`batch_create_contacts`** | Create up to 100 contacts in one call (single osascript) |
| **`batch_update_contacts`** | Update up to 100 contacts in one call |
| **`batch_get_contacts`** | Fetch full records for up to 250 contact IDs in one call |

### Field schema (create / update payloads)

```ts
{
  first_name?:   string | null,
  last_name?:    string | null,
  prefix?:       string | null,   // Mr./Dr./...
  suffix?:       string | null,   // Jr./Sr./...
  nickname?:     string | null,
  organization?: string | null,
  department?:   string | null,
  job_title?:    string | null,
  phones?:       { label: "mobile"|"work"|"home"|"main"|"other", value: string }[] | null,
  emails?:       { label: "work"|"home"|"other",                  value: string }[] | null,
  addresses?:    { label: "work"|"home"|"other",
                   street?, city?, state?, postal_code?, country?, formatted? }[] | null,
  urls?:         { label: "work"|"home"|"homepage"|"other",       value: string }[] | null,
  birthday?:     string | null, // "YYYY-MM-DD" or "MM-DD"
  photo?:        string | null, // base64 OR absolute file path starting with "/"
  note?:         string | null, // newlines preserved
  // Deprecated single-value forms (still accepted, append-only on update):
  email?:        string,
  phone?:        string,
}
```

### Field value semantics on `update_contact` (since 0.6.0)

| Value | Meaning |
|---|---|
| omitted / `undefined` | no change |
| `""` (empty string) | no change (back-compat) |
| `null` | **explicitly clear** the field |
| `"value"` | set to that value |

Array fields (`phones`, `emails`, `addresses`, `urls`):
- Provided array → **REPLACE** all existing entries
- `null` → **clear all** entries
- omitted → no change
- Legacy single `phone` / `email` → APPEND (not replace)

`update_contact` returns `{id, name, updated_fields: string[]}` — `updated_fields` lists only fields where an actual `set`/`delete` was generated. `""` (no-change) is excluded; `null` (clear) is included.

### Multi-value field input

Some MCP clients serialize complex args as JSON strings. The array fields accept either form:

```jsonc
// Real array (preferred)
{ "phones": [{ "label": "mobile", "value": "+82 10-1111-2222" }] }

// JSON-stringified array (also accepted)
{ "phones": "[{\"label\":\"mobile\",\"value\":\"+82 10-1111-2222\"}]" }
```

Number/boolean params (`limit`, `offset`, `summary`) similarly accept both raw and stringified forms.

### `list_contacts` options

```ts
list_contacts({
  group?:         string,            // required if ALLOWED_GROUPS is set
  limit?:         number,            // default 50, max 500
  offset?:        number,            // default 0
  summary?:       boolean | "full" | "minimal",
  changed_since?: string,            // ISO 8601 datetime
  output_file?:   string,            // absolute path; see below
})
```

| `summary` | Per-item shape | Bytes/item |
|---|---|---|
| `false` (default) / `"full"` / `true` | `{id, name, organization, primary_phone, primary_email, modification_date}` | ~200 |
| `"minimal"` | `{id, name, modification_date}` (org/phone/email keys omitted entirely) | ~50–80 |

`changed_since` is an ISO 8601 datetime. Only contacts whose `modification date` is at or after the threshold are returned. **Filtering happens inside AppleScript** — unchanged contacts are never serialized. `total` reflects the filtered count. Combinable with `summary` and pagination.

**Recommended pull-sync pattern:**
```jsonc
list_contacts({
  group: "Business",
  changed_since: "2026-04-10T15:30:00",
  summary: "minimal",
  limit: 500
})
// → { items: [{id, name, modification_date}, ...], total: 12, ... }
```

In a 1406-contact iCloud setup, this returns ~0.3KB when only one contact has changed in the last hour — vs ~99KB for the unfiltered full list.

### `output_file` — bypass MCP token limits

`list_contacts` and `batch_get_contacts` accept an `output_file` parameter. When set to an **absolute file path**, the full response JSON is written to that file and only a compact summary is returned in the MCP response.

**Why:** MCP clients (including Claude Code) impose a token limit on tool responses. Large list/batch results may exceed it, causing the client to either truncate or auto-spill to a file. That auto-spill is non-deterministic — same call may return inline one time and as a file the next, forcing callers to handle both shapes. Setting `output_file` explicitly makes the file-based path deterministic regardless of response size.

```jsonc
list_contacts({
  group: "Business",
  limit: 500,
  output_file: "/tmp/contacts_dump.json"
})

// MCP response (compact)
{
  "saved_to": "/tmp/contacts_dump.json",
  "total": 951,
  "items_count": 500,
  "offset": 0,
  "limit": 500,
  "next_offset": 500
}
// Full data is at /tmp/contacts_dump.json — read it from your sync script
```

Same shape for `batch_get_contacts`. Relative paths are rejected; parent dirs are auto-created.

### Batch operations

All three batch tools execute their N items inside a single `osascript` process, with one `save` at the end (for create/update). Per-item failures are isolated via `try`/`on error` blocks and reported individually — they do not roll back other items.

```jsonc
// batch_create_contacts (max 100)
{ "contacts": [{first_name: "...", phones: [...]}, ...] }
// → { total, succeeded, failed, results: [{index, status, id, name, group_added?, error?}, ...] }

// batch_update_contacts (max 100, requires contact_id per entry)
{ "contacts": [{contact_id: "...:ABPerson", note: "..."}, ...] }
// → { total, succeeded, failed, results: [{index, status, id, name, updated_fields?, error?}, ...] }

// batch_get_contacts (max 250, read-only — no ALLOWED_GROUPS check)
{ "contact_ids": ["...:ABPerson", ...], "output_file": "/tmp/batch.json" }
// → full ContactRecord per id, or summary if output_file set
```

Performance (1406-contact iCloud setup, macOS Sequoia):

| Call | Elapsed |
|---|---|
| `list_contacts` (limit=500, full) | ~238s |
| `list_contacts` (limit=500, summary="minimal") | ~79s |
| `list_contacts` (limit=500, changed_since=1h ago + minimal) | ~73s, ~0.3KB |
| `batch_get_contacts` (100 ids) | ~136s |

## Test

```bash
npm run test:roundtrip
```

The roundtrip script creates `__APPLEMCPTEST__` contacts, exercises every field, runs all the regression cases (missing-value leaks, `has_photo`, name lookup fallback, jsonOrArray schema, list pagination, summary/minimal mode, `changed_since`, batch create/update/get, null field clear, etc.), and cleans up. **124 assertions** as of v0.6.0. If aborted mid-run, leftover `__APPLEMCPTEST__` contacts may need manual cleanup in Contacts.app.

## Known limitations

- **Email labels are not preserved** by Apple Contacts AppleScript — they all read back as "Email". Phone, URL, and address labels round-trip cleanly.
- Birthday year `1604` is the Apple sentinel for "no year" and is rendered as `MM-DD` on read.
- Photo round-trip verifies presence (`has_photo: true`) but the binary itself is not read back through `get_contact`.
- `batch_get_contacts` is bounded at 250 IDs because larger batches exceed osascript's practical timeout (~15min).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full history.

## License

MIT. Upstream copyright preserved in `LICENSE`.
