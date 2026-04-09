# apple-mcp-extended

Extended MCP server for Apple Contacts on macOS. **Fork of [griches/apple-mcp](https://github.com/griches/apple-mcp)** (`@griches/apple-contacts-mcp`, MIT). Built to support full bidirectional sync between a local single-source-of-truth `contacts.json` and Apple Contacts (Exchange "Contacts" group) — the upstream's schema is too thin for that.

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
| Note newlines | escaped to literal `\n` (upstream bug) | preserved as real newlines via `& linefeed &` |
| `get_contact` output | bare values, no labels | full structured `ContactRecord` with labels, ids, every field |
| Identifier | name only — silently picks first match | `id` is the preferred identifier; name lookups disambiguated by `phone`/`email` and refuse on ambiguity |
| `delete_contact` safety | name only, picks first | requires `id` OR `name` + `phone`/`email`; errors if multiple matches |
| Group restriction | none | `ALLOWED_GROUPS` env var enforces a whitelist at the code level |
| Phone label bug | upstream's `label:"mobile"` silently drops phones on macOS Sonoma+ | uses internal `_$!<Mobile>!$_` form |

## Install

```bash
git clone https://github.com/sanggeol/apple-mcp-extended.git
cd apple-mcp-extended/contacts
npm install
npm run build
```

Requires Node ≥ 18 and macOS with the Contacts app. First run will trigger a "Allow Terminal/Node to control Contacts" permission prompt.

## Run

```bash
# Basic
node dist/index.js

# Read-only (no delete tools registered)
node dist/index.js --read-only

# Confirm-destructive (delete tools require explicit confirm:true)
node dist/index.js --confirm-destructive

# Restrict to a specific group (RECOMMENDED)
ALLOWED_GROUPS=Contacts node dist/index.js
```

## Environment variables

| Var | Default | Effect |
|---|---|---|
| `ALLOWED_GROUPS` | (unset = all groups) | Comma-separated whitelist. When set: `list_contacts` requires a group; `search_contacts` filters results to allowed-group members; `create_contact` auto-adds new contacts to the first allowed group; `update_contact`/`delete_contact` refuse to touch contacts not in any allowed group; `create_group`/`delete_group` reject names not on the list. |

## MCP client config (Claude Desktop)

```json
{
  "mcpServers": {
    "apple-contacts": {
      "command": "node",
      "args": ["/Users/you/Projects/apple-mcp-extended/contacts/dist/index.js"],
      "env": { "ALLOWED_GROUPS": "Contacts" }
    }
  }
}
```

After editing `claude_desktop_config.json`, restart Claude Desktop.

## Tools

All 11 upstream tools are preserved with extended schemas:

- `list_groups` — filtered by `ALLOWED_GROUPS`
- `list_contacts(group?)` — group required when restricted
- `search_contacts(query, group?)` — filtered to allowed groups
- `get_contact(id? | name? + phone?/email?)` → full `ContactRecord`
- `create_contact(first_name, last_name, ...all fields)` → `{id, name}`
- `update_contact(id? | name? + match_phone?/match_email?, ...all fields)` — array fields **replace**, legacy single `phone`/`email` **append**
- `delete_contact(id | name + phone/email)` — refuses on ambiguity
- `create_group(name)` / `delete_group(name)`
- `add_contact_to_group(contact_id?|contact_name?, group_name)` / `remove_contact_from_group(...)`

## Field schema (create / update payloads)

```ts
{
  first_name?: string, last_name?: string,
  prefix?: string, suffix?: string, nickname?: string,
  organization?: string, department?: string, job_title?: string,
  phones?:    { label: "mobile"|"work"|"home"|"main"|"other", value: string }[],
  emails?:    { label: "work"|"home"|"other",                  value: string }[],
  addresses?: { label: "work"|"home"|"other",
                street?, city?, state?, postal_code?, country?, formatted? }[],
  urls?:      { label: "work"|"home"|"homepage"|"other",       value: string }[],
  birthday?:  string, // "YYYY-MM-DD" or "MM-DD"
  photo?:     string, // base64 OR absolute file path starting with "/"
  note?:      string, // newlines preserved
  // deprecated single-value forms (still accepted, append-only):
  email?: string, phone?: string,
}
```

## Test

```bash
npm run test:roundtrip
```

The roundtrip script creates a `__APPLEMCPTEST__` contact, exercises every field, runs an update with array-replacement, and deletes by id. 29 assertions, all should pass. If aborted mid-run, a leftover `__APPLEMCPTEST__` contact may need manual cleanup in Contacts.app.

## Known limitations

- **Email labels are not preserved** by Apple Contacts AppleScript — they all read back as "Email". Phone, URL, and address labels round-trip cleanly.
- Birthday year `1604` is the Apple sentinel for "no year" and is rendered as `MM-DD` on read.
- Photo round-trip verifies presence (`has_photo: true`) but the binary itself is not read back through `get_contact`.

## License

MIT. Upstream copyright preserved in `LICENSE`.
