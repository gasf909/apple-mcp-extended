// High-level Contacts CRUD. Builds AppleScript via applescript.ts helpers,
// enforces group safety via safety.ts.
//
// Output marshalling format for get_contact:
//   NAME|||ID|||PREFIX|||FIRST|||LAST|||SUFFIX|||NICK|||ORG|||DEPT|||TITLE
//      |||PHONES|||EMAILS|||ADDRS|||URLS|||BDAY|||NOTE|||HASPHOTO
// where:
//   PHONES = "label<<<KV>>>value" joined by "<<<SUB>>>"
//   EMAILS = same
//   URLS   = same
//   ADDRS  = "label<<<KV>>>street<<<KV>>>city<<<KV>>>state<<<KV>>>zip<<<KV>>>country" joined by "<<<SUB>>>"

import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAppleScript, appleScriptString as q, F, R, S, KV } from "./applescript.js";
import {
  ContactFields,
  ContactRecord,
  ContactSummary,
  ListContactsResult,
  SummaryMode,
  BatchCreateEntry,
  BatchUpdateEntry,
  BatchItemResult,
  BatchResult,
  BatchGetItemResult,
  BatchGetResult,
  Phone,
  Email,
  Url,
  Address,
} from "./types.js";
import {
  isRestricted,
  allowedGroups,
  defaultGroup,
  assertGroupAllowed,
  assertGroupProvided,
} from "./safety.js";

// ---------- Group ops ----------

export async function listGroups(): Promise<{ name: string }[]> {
  const script = `
tell application "Contacts"
  set out to ""
  repeat with g in groups
    if out is "" then
      set out to name of g
    else
      set out to out & "${F}" & name of g
    end if
  end repeat
  return out
end tell`;
  const raw = await runAppleScript(script);
  if (!raw) return [];
  const all = raw.split(F).map((n) => ({ name: n.trim() }));
  if (!isRestricted()) return all;
  const allowed = new Set(allowedGroups());
  return all.filter((g) => allowed.has(g.name));
}

export async function createGroup(name: string): Promise<string> {
  assertGroupAllowed(name);
  const script = `
tell application "Contacts"
  make new group with properties {name:${q(name)}}
  save
end tell`;
  await runAppleScript(script);
  return `Group created: ${name}`;
}

export async function deleteGroup(name: string): Promise<string> {
  assertGroupAllowed(name);
  const script = `
tell application "Contacts"
  set matched to (every group whose name is ${q(name)})
  if (count of matched) is 0 then error "Group not found: ${name.replace(/"/g, '\\"')}"
  delete item 1 of matched
  save
end tell`;
  await runAppleScript(script);
  return `Group deleted: ${name}`;
}

// ---------- Listing / search ----------

// Default page size when caller does not specify a limit. Tuned to stay
// well under typical MCP/LLM token budgets. 50 summaries ≈ 5KB which is
// safely below even conservative tool-output limits.
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

export async function listContacts(
  group: string | undefined,
  opts: { limit?: number; offset?: number; summary?: SummaryMode; changed_since?: string } = {}
): Promise<ListContactsResult> {
  assertGroupProvided(group);
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT));
  const offset = Math.max(0, opts.offset ?? 0);
  // Normalize summary mode: false/undefined → "full", true → "full" (back-compat), "minimal" → "minimal"
  const mode: "full" | "minimal" =
    opts.summary === "minimal" ? "minimal" : "full";
  const isMinimal = mode === "minimal";
  const changedSince = opts.changed_since?.trim() ?? "";

  const scope = group ? `people of group ${q(group)}` : "people";

  // --- Build per-person AppleScript readers ---

  // modDate reader (always included — needed for filtering AND output)
  const modDateReader = `
    set modDateStr to ""
    try
      set md to modification date of p
      if md is not missing value then
        set yr to year of md
        set mo to month of md as integer
        set dy to day of md
        set hr to hours of md
        set mn to minutes of md
        set sc to seconds of md
        set moS to text -2 thru -1 of ("0" & mo)
        set dyS to text -2 thru -1 of ("0" & dy)
        set hrS to text -2 thru -1 of ("0" & hr)
        set mnS to text -2 thru -1 of ("0" & mn)
        set scS to text -2 thru -1 of ("0" & sc)
        set modDateStr to (yr as string) & "-" & moS & "-" & dyS & "T" & hrS & ":" & mnS & ":" & scS
      end if
    end try`;

  // Extra field readers for non-minimal modes
  const extraReaders = isMinimal
    ? ""
    : `
    set theOrg to ""
    try
      set tmp to organization of p
      if tmp is not missing value then set theOrg to tmp as text
    end try
    set thePhone to ""
    try
      if (count of phones of p) > 0 then
        set tmp to value of (item 1 of phones of p)
        if tmp is not missing value then set thePhone to tmp as text
      end if
    end try
    set theEmail to ""
    try
      if (count of emails of p) > 0 then
        set tmp to value of (item 1 of emails of p)
        if tmp is not missing value then set theEmail to tmp as text
      end if
    end try`;

  // Record assembly
  const recExpr = isMinimal
    ? `theName & "${F}" & theId & "${F}" & modDateStr`
    : `theName & "${F}" & theId & "${F}" & theOrg & "${F}" & thePhone & "${F}" & theEmail & "${F}" & modDateStr`;

  // --- changed_since filter setup ---
  // When set, we iterate ALL members, read their modification date, and
  // compare. Only matching records are emitted; total = filtered count.
  // Pagination (offset/limit) applies to the filtered set.
  //
  // Without changed_since, we use the fast index-based pagination (no
  // date comparison, just items startIdx..endIdx).

  let script: string;

  if (changedSince) {
    // Validate the ISO string minimally
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(changedSince)) {
      throw new Error(
        `Invalid changed_since format: "${changedSince}". Expected ISO 8601 datetime, e.g. "2026-04-10T15:30:00".`
      );
    }
    // AppleScript date comparison: parse the threshold into an AS date,
    // then compare each person's modification date. We strip any
    // timezone offset from the input since AS dates are local.
    const localPart = changedSince.replace(/[+-]\d{2}:\d{2}$/, "").replace(/Z$/, "");
    // Parse components for AS date construction
    const dm = localPart.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):?(\d{2})?$/);
    if (!dm) {
      throw new Error(
        `Cannot parse changed_since: "${changedSince}". Expected YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS.`
      );
    }
    const [, csY, csM, csD, csH, csMn, csS] = dm;

    script = `
tell application "Contacts"
  -- Build threshold date
  set threshDate to current date
  set day of threshDate to 1
  set year of threshDate to ${csY}
  set month of threshDate to ${parseInt(csM!, 10)}
  set day of threshDate to ${parseInt(csD!, 10)}
  set hours of threshDate to ${parseInt(csH!, 10)}
  set minutes of threshDate to ${parseInt(csMn!, 10)}
  set seconds of threshDate to ${parseInt(csS ?? "0", 10)}

  set theGroup to ${scope}
  set matchCount to 0
  set emitted to 0
  set out to ""
  repeat with p in theGroup
    -- Read modification date first; skip if older than threshold
    set md to missing value
    try
      set md to modification date of p
    end try
    if md is not missing value and md >= threshDate then
      set matchCount to matchCount + 1
      -- Apply offset/limit to the filtered set
      if matchCount > ${offset} and emitted < ${limit} then
        set theName to name of p
        set theId to id of p${modDateReader}${extraReaders}
        set rec to ${recExpr}
        set out to out & "${R}" & rec
        set emitted to emitted + 1
      end if
    end if
  end repeat
  return "TOTAL=" & (matchCount as string) & out
end tell`;
  } else {
    // No changed_since — fast index-based pagination (original path)
    script = `
tell application "Contacts"
  set theGroup to ${scope}
  set total to count of theGroup
  set startIdx to ${offset + 1}
  set endIdx to ${offset + limit}
  if endIdx > total then set endIdx to total
  set out to "TOTAL=" & (total as string)
  if startIdx > total then return out
  repeat with i from startIdx to endIdx
    set p to item i of theGroup
    set theName to name of p
    set theId to id of p${modDateReader}${extraReaders}
    set rec to ${recExpr}
    set out to out & "${R}" & rec
  end repeat
  return out
end tell`;
  }

  const raw = await runAppleScript(script);
  // Header: "TOTAL=N" then records joined by R.
  const [headerAndFirst, ...rest] = raw.split(R);
  const headerMatch = (headerAndFirst ?? "").match(/^TOTAL=(\d+)$/);
  let total = 0;
  let recordSlice: string[] = [];
  if (headerMatch) {
    total = parseInt(headerMatch[1]!, 10);
    recordSlice = rest;
  } else {
    recordSlice = headerAndFirst ? [headerAndFirst, ...rest] : [];
  }

  const items: ContactSummary[] = recordSlice
    .filter((r) => r.length > 0)
    .map((rec) => {
      const parts = rec.split(F);
      if (isMinimal) {
        // Minimal: name|id|modDate (3 fields) — keys omitted, not null
        return {
          id: (parts[1] ?? "").trim(),
          name: (parts[0] ?? "").trim(),
          modification_date: cleanField(parts[2]) || null,
        };
      }
      // Full: name|id|org|phone|email|modDate (6 fields)
      return {
        id: (parts[1] ?? "").trim(),
        name: (parts[0] ?? "").trim(),
        organization: cleanField(parts[2]) || null,
        primary_phone: cleanField(parts[3]) || null,
        primary_email: cleanField(parts[4]) || null,
        modification_date: cleanField(parts[5]) || null,
      };
    });

  const next_offset = offset + items.length < total ? offset + items.length : null;
  return { items, total, offset, limit, next_offset };
}

export async function searchContacts(query: string, group?: string): Promise<ContactSummary[]> {
  // If restricted but no group provided, search across all allowed groups
  // by listing each then filtering by query.
  if (isRestricted()) {
    const groups = group ? [group] : allowedGroups();
    if (group) assertGroupAllowed(group);
    const out: ContactSummary[] = [];
    const seen = new Set<string>();
    const ql = query.toLowerCase();
    for (const g of groups) {
      // Page through the entire group so search is exhaustive even when
      // the group exceeds the default page size.
      let off = 0;
      // Use the max so search avoids unnecessary round-trips.
      const pageSize = MAX_LIST_LIMIT;
      while (true) {
        const page = await listContacts(g, { limit: pageSize, offset: off });
        for (const it of page.items) {
          if (seen.has(it.id)) continue;
          if (it.name.toLowerCase().includes(ql)) {
            out.push(it);
            seen.add(it.id);
          }
        }
        if (page.next_offset == null) break;
        off = page.next_offset;
      }
    }
    return out;
  }

  // Unrestricted: use AppleScript filter
  const script = `
tell application "Contacts"
  set out to ""
  set matched to (every person whose name contains ${q(query)})
  repeat with p in matched
    set rec to (name of p) & "${F}" & (id of p)
    if out is "" then
      set out to rec
    else
      set out to out & "${R}" & rec
    end if
  end repeat
  return out
end tell`;
  const raw = await runAppleScript(script);
  if (!raw) return [];
  return raw.split(R).map((rec) => {
    const [name, id] = rec.split(F).map((s) => s.trim());
    return {
      name: name ?? "",
      id: id ?? "",
      organization: null,
      primary_phone: null,
      primary_email: null,
      modification_date: null,
    };
  });
}

// ---------- Resolve identifier → person id ----------

interface Identifier {
  id?: string;
  name?: string;
  phone?: string;
  email?: string;
}

async function resolvePersonId(idArg: Identifier, opts: { requireExtraIfNoId?: boolean } = {}): Promise<string> {
  if (idArg.id) {
    // Verify exists
    const script = `
tell application "Contacts"
  try
    set p to person id ${q(idArg.id)}
    return id of p
  on error
    return ""
  end try
end tell`;
    const got = (await runAppleScript(script)).trim();
    if (!got) throw new Error(`Contact not found by id: ${idArg.id}`);
    await assertContactInAllowedGroups(got);
    return got;
  }
  if (!idArg.name) throw new Error("Must provide id or name");

  if (opts.requireExtraIfNoId && !idArg.phone && !idArg.email) {
    throw new Error(
      "When deleting/updating by name, you must also pass id, or pass phone/email to disambiguate"
    );
  }

  // Try multiple matching strategies in order. Stop at the first one that
  // returns at least one candidate. Without this, callers had to know the
  // exact display name (incl. prefix/suffix) — Apple Contacts' `whose
  // name is "X"` is strict equality on the rendered name.
  //
  //   1. Exact display-name match           (`name is "X"`)
  //   2. first+last components when input has exactly two tokens
  //      (`first name is "A" and last name is "B"`)
  //   3. Substring match on display name    (`name contains "X"`)
  //
  // Strategy 3 may legitimately return multiple matches; the existing
  // ambiguity check below will then ask the caller to disambiguate.
  const nameQ = idArg.name.trim();
  const tokens = nameQ.split(/\s+/);
  const queries: string[] = [`every person whose name is ${q(nameQ)}`];
  if (tokens.length === 2) {
    queries.push(
      `every person whose first name is ${q(tokens[0]!)} and last name is ${q(tokens[1]!)}`
    );
  }
  queries.push(`every person whose name contains ${q(nameQ)}`);

  let raw = "";
  for (const matchExpr of queries) {
    const script = `
tell application "Contacts"
  set out to ""
  set matched to (${matchExpr})
  repeat with p in matched
    set ph to ""
    set em to ""
    try
      repeat with x in phones of p
        if ph is "" then
          set ph to (value of x)
        else
          set ph to ph & "," & (value of x)
        end if
      end repeat
    end try
    try
      repeat with x in emails of p
        if em is "" then
          set em to (value of x)
        else
          set em to em & "," & (value of x)
        end if
      end repeat
    end try
    set rec to (id of p) & "${F}" & ph & "${F}" & em
    if out is "" then
      set out to rec
    else
      set out to out & "${R}" & rec
    end if
  end repeat
  return out
end tell`;
    raw = await runAppleScript(script);
    if (raw) break;
  }
  if (!raw) throw new Error(`No contact named "${idArg.name}"`);
  const records = raw.split(R).map((r) => {
    const [pid, ph, em] = r.split(F);
    return { id: (pid ?? "").trim(), phones: (ph ?? "").split(",").map((s) => s.trim()), emails: (em ?? "").split(",").map((s) => s.trim()) };
  });
  let candidates = records;
  if (idArg.phone) {
    const norm = (s: string) => s.replace(/[^\d+]/g, "");
    const target = norm(idArg.phone);
    candidates = candidates.filter((r) => r.phones.some((p) => norm(p) === target));
  }
  if (idArg.email) {
    const target = idArg.email.toLowerCase();
    candidates = candidates.filter((r) => r.emails.some((e) => e.toLowerCase() === target));
  }
  if (candidates.length === 0) throw new Error(`No contact matches name="${idArg.name}" with provided phone/email`);
  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous: ${candidates.length} contacts named "${idArg.name}". Pass id (one of: ${candidates.map((c) => c.id).join(", ")})`
    );
  }
  const pid = candidates[0]!.id;
  await assertContactInAllowedGroups(pid);
  return pid;
}

async function assertContactInAllowedGroups(personId: string): Promise<void> {
  if (!isRestricted()) return;
  const script = `
tell application "Contacts"
  try
    set p to person id ${q(personId)}
    set out to ""
    repeat with g in groups of p
      if out is "" then
        set out to name of g
      else
        set out to out & "${F}" & name of g
      end if
    end repeat
    return out
  on error
    return ""
  end try
end tell`;
  const raw = await runAppleScript(script);
  const groupsForContact = raw ? raw.split(F).map((s) => s.trim()) : [];
  const allowed = new Set(allowedGroups());
  const ok = groupsForContact.some((g) => allowed.has(g));
  if (!ok) {
    throw new Error(
      `Contact ${personId} is not in any allowed group (${[...allowed].join(", ")}). Refusing.`
    );
  }
}

// ---------- get_contact ----------

export async function getContact(idArg: Identifier): Promise<ContactRecord> {
  const personId = await resolvePersonId(idArg);

  // Each property reader follows the same pattern: try the property, and
  // ONLY copy it into the output variable when it is not `missing value`.
  // Without the `is not missing value` check, AppleScript coerces missing
  // value into the literal string "missing value" when later concatenated.
  const script = `
tell application "Contacts"
  set p to person id ${q(personId)}
  set theName to name of p
  set thePrefix to ""
  try
    set tmp to title of p
    if tmp is not missing value then set thePrefix to tmp as text
  end try
  set theFirst to ""
  try
    set tmp to first name of p
    if tmp is not missing value then set theFirst to tmp as text
  end try
  set theLast to ""
  try
    set tmp to last name of p
    if tmp is not missing value then set theLast to tmp as text
  end try
  set theSuffix to ""
  try
    set tmp to suffix of p
    if tmp is not missing value then set theSuffix to tmp as text
  end try
  set theNick to ""
  try
    set tmp to nickname of p
    if tmp is not missing value then set theNick to tmp as text
  end try
  set theOrg to ""
  try
    set tmp to organization of p
    if tmp is not missing value then set theOrg to tmp as text
  end try
  set theDept to ""
  try
    set tmp to department of p
    if tmp is not missing value then set theDept to tmp as text
  end try
  set theTitle to ""
  try
    set tmp to job title of p
    if tmp is not missing value then set theTitle to tmp as text
  end try

  set phStr to ""
  try
    repeat with x in phones of p
      set lbl to ""
      try
        set lbl to label of x
      end try
      set v to value of x
      set sub to lbl & "${KV}" & v
      if phStr is "" then
        set phStr to sub
      else
        set phStr to phStr & "${S}" & sub
      end if
    end repeat
  end try

  set emStr to ""
  try
    repeat with x in emails of p
      set lbl to ""
      try
        set lbl to label of x
      end try
      set v to value of x
      set sub to lbl & "${KV}" & v
      if emStr is "" then
        set emStr to sub
      else
        set emStr to emStr & "${S}" & sub
      end if
    end repeat
  end try

  set adStr to ""
  try
    repeat with x in addresses of p
      set lbl to ""
      try
        set lbl to label of x
      end try
      set streetVal to ""
      try
        set tmp to street of x
        if tmp is not missing value then set streetVal to tmp as text
      end try
      set cityVal to ""
      try
        set tmp to city of x
        if tmp is not missing value then set cityVal to tmp as text
      end try
      set stateVal to ""
      try
        set tmp to state of x
        if tmp is not missing value then set stateVal to tmp as text
      end try
      set zipVal to ""
      try
        set tmp to zip of x
        if tmp is not missing value then set zipVal to tmp as text
      end try
      set countryVal to ""
      try
        set tmp to country of x
        if tmp is not missing value then set countryVal to tmp as text
      end try
      set sub to lbl & "${KV}" & streetVal & "${KV}" & cityVal & "${KV}" & stateVal & "${KV}" & zipVal & "${KV}" & countryVal
      if adStr is "" then
        set adStr to sub
      else
        set adStr to adStr & "${S}" & sub
      end if
    end repeat
  end try

  set urStr to ""
  try
    repeat with x in urls of p
      set lbl to ""
      try
        set lbl to label of x
      end try
      set v to value of x
      set sub to lbl & "${KV}" & v
      if urStr is "" then
        set urStr to sub
      else
        set urStr to urStr & "${S}" & sub
      end if
    end repeat
  end try

  set bdStr to ""
  try
    set bd to birth date of p
    set yr to year of bd
    set mo to month of bd as integer
    set dy to day of bd
    set bdStr to (yr as string) & "-" & (mo as string) & "-" & (dy as string)
  end try

  set ntStr to ""
  try
    set tmp to note of p
    if tmp is not missing value then set ntStr to tmp as text
  end try

  -- has_photo: image of p returns missing value (no exception) when no
  -- photo is set; without the explicit guard hasImg was always "1".
  set hasImg to "0"
  try
    set img to image of p
    if img is not missing value then set hasImg to "1"
  end try

  set modDateStr to ""
  try
    set md to modification date of p
    if md is not missing value then
      set yr to year of md
      set mo to month of md as integer
      set dy to day of md
      set hr to hours of md
      set mn to minutes of md
      set sc to seconds of md
      set moS to text -2 thru -1 of ("0" & mo)
      set dyS to text -2 thru -1 of ("0" & dy)
      set hrS to text -2 thru -1 of ("0" & hr)
      set mnS to text -2 thru -1 of ("0" & mn)
      set scS to text -2 thru -1 of ("0" & sc)
      set modDateStr to (yr as string) & "-" & moS & "-" & dyS & "T" & hrS & ":" & mnS & ":" & scS
    end if
  end try

  return theName & "${F}" & (id of p) & "${F}" & thePrefix & "${F}" & theFirst & "${F}" & theLast & "${F}" & theSuffix & "${F}" & theNick & "${F}" & theOrg & "${F}" & theDept & "${F}" & theTitle & "${F}" & phStr & "${F}" & emStr & "${F}" & adStr & "${F}" & urStr & "${F}" & bdStr & "${F}" & ntStr & "${F}" & hasImg & "${F}" & modDateStr
end tell`;
  const raw = await runAppleScript(script);
  return parseContactRecord(raw);
}

function parseContactRecord(raw: string): ContactRecord {
  const p = raw.split(F);
  const get = (i: number) => (p[i] ?? "").trim();
  // Defensive null: also strip the literal "missing value" string in case
  // a future AppleScript reader path forgets the guard above.
  const orNull = (i: number) => {
    const v = get(i);
    if (!v || v === "missing value") return null;
    return v;
  };
  return {
    name: get(0),
    id: get(1),
    prefix: orNull(2),
    first_name: orNull(3),
    last_name: orNull(4),
    suffix: orNull(5),
    nickname: orNull(6),
    organization: orNull(7),
    department: orNull(8),
    job_title: orNull(9),
    phones: parseLabelValueList(p[10] ?? "") as Phone[],
    emails: parseLabelValueList(p[11] ?? "") as Email[],
    addresses: parseAddressList(p[12] ?? ""),
    urls: parseLabelValueList(p[13] ?? "") as Url[],
    birthday: parseBirthday(p[14] ?? ""),
    note: orNull(15),
    has_photo: get(16) === "1",
    modification_date: orNull(17),
  };
}

// Defensive: strip the literal "missing value" string in case a reader
// path somewhere forgets the AppleScript-level guard. Also strip empty.
function cleanField(raw: string | undefined): string {
  const t = (raw ?? "").trim();
  if (!t || t === "missing value") return "";
  return t;
}

function parseLabelValueList(s: string): { label: string; value: string }[] {
  if (!s) return [];
  return s.split(S).map((sub) => {
    const [label, value] = sub.split(KV);
    return { label: cleanLabel(label ?? ""), value: cleanField(value) };
  }).filter((x) => x.value);
}

function parseAddressList(s: string): Address[] {
  if (!s) return [];
  return s.split(S).map((sub) => {
    const parts = sub.split(KV);
    const addr: Address = { label: (cleanLabel(parts[0] ?? "") || "home") as Address["label"] };
    const street = cleanField(parts[1]);
    const city = cleanField(parts[2]);
    const state = cleanField(parts[3]);
    const postal = cleanField(parts[4]);
    const country = cleanField(parts[5]);
    if (street) addr.street = street;
    if (city) addr.city = city;
    if (state) addr.state = state;
    if (postal) addr.postal_code = postal;
    if (country) addr.country = country;
    // Synthesize a read-only `formatted` from whatever is present, so
    // callers that wrote via `formatted` on create can still see the
    // resulting string on read.
    const joined = [street, city, state, postal, country].filter(Boolean).join(", ");
    if (joined) addr.formatted = joined;
    return addr;
  }).filter((a) => a.street || a.city || a.state || a.postal_code || a.country);
}

// AppleScript label values look like `«constant ****home»` or "_$!<Mobile>!$_". Normalize.
function cleanLabel(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t.includes("mobile")) return "mobile";
  if (t.includes("work")) return "work";
  if (t.includes("home")) return "home";
  if (t.includes("main")) return "main";
  if (t.includes("homepage")) return "homepage";
  return "other";
}

function parseBirthday(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  // Format from script: "YYYY-M-D"
  const m = t.match(/^(-?\d+)-(\d+)-(\d+)$/);
  if (!m) return t;
  const year = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10).toString().padStart(2, "0");
  const day = parseInt(m[3]!, 10).toString().padStart(2, "0");
  if (year === 1604) return `${month}-${day}`;
  return `${year}-${month}-${day}`;
}

// ---------- create_contact ----------

export async function createContact(
  firstName: string | undefined,
  lastName: string | undefined,
  fields: ContactFields
): Promise<{ id: string; name: string; group_added?: string; group_warning?: string }> {
  // Pre-flight: when ALLOWED_GROUPS is set, the new contact will be
  // auto-added to the first allowed group. Verify the group exists BEFORE
  // we create the person so we don't leave an orphan on misconfiguration.
  const targetGroup = defaultGroup();
  if (targetGroup) {
    const existing = await listGroups();
    const hit = existing.some((g) => g.name === targetGroup);
    if (!hit) {
      throw new Error(
        `Auto-add target group "${targetGroup}" does not exist in Apple Contacts. ` +
          `Create it first (e.g. via create_group), or unset ALLOWED_GROUPS.`
      );
    }
  }

  // Build property list for `make new person`. Both first/last are now
  // optional: a contact with only organization (company entry) or only
  // a single given name is allowed.
  const props: string[] = [];
  if (firstName) props.push(`first name:${q(firstName)}`);
  if (lastName) props.push(`last name:${q(lastName)}`);
  if (fields.prefix) props.push(`title:${q(fields.prefix)}`);
  if (fields.suffix) props.push(`suffix:${q(fields.suffix)}`);
  if (fields.nickname) props.push(`nickname:${q(fields.nickname)}`);
  if (fields.organization) props.push(`organization:${q(fields.organization)}`);
  if (fields.department) props.push(`department:${q(fields.department)}`);
  if (fields.job_title) props.push(`job title:${q(fields.job_title)}`);
  if (fields.note) props.push(`note:${q(fields.note)}`);

  const extras: string[] = [];
  appendChildBlocks(extras, "newPerson", fields, /*isUpdate*/ false);
  appendBirthdayBlock(extras, "newPerson", fields.birthday);

  const photoSetup = await preparePhotoBlock("newPerson", fields.photo);

  // Step 1 — create the person and save. We do NOT bundle the
  // add-to-group step into this script: cross-account adds (e.g. person
  // in "On My Mac" → group in "iCloud") often fail and would otherwise
  // poison the entire create. We do the add as a separate, recoverable
  // call so the caller still gets the new id back even if grouping fails.
  const script = `
tell application "Contacts"
  set newPerson to make new person with properties {${props.join(", ")}}
${extras.join("\n")}
${photoSetup.script}
  save
  return (id of newPerson) & "${F}" & (name of newPerson)
end tell`;

  let result: string;
  try {
    result = await runAppleScript(script);
  } finally {
    photoSetup.cleanup();
  }
  const [rawId, rawName] = result.split(F);
  const id = (rawId ?? "").trim();
  const name = (rawName ?? "").trim();

  // Step 2 — auto-add to default group when ALLOWED_GROUPS is restricted.
  if (targetGroup) {
    try {
      await addContactToGroupRaw(id, targetGroup);
      return { id, name, group_added: targetGroup };
    } catch (e) {
      // Surface the failure to the caller so it's not silent — they need
      // to know the contact landed outside the expected group. The
      // contact itself is kept (not rolled back) because deletion would
      // hide the underlying configuration problem.
      return {
        id,
        name,
        group_warning: `Contact created but auto-add to group "${targetGroup}" failed: ${(e as Error).message}`,
      };
    }
  }

  return { id, name };
}

// Internal helper: same as addContactToGroup but bypasses the safety
// check (we just created/looked-up the contact ourselves) so it can be
// reused from createContact.
async function addContactToGroupRaw(personId: string, groupName: string): Promise<void> {
  const script = `
tell application "Contacts"
  set p to person id ${q(personId)}
  set g to first group whose name is ${q(groupName)}
  add p to g
  save
end tell`;
  await runAppleScript(script);
}

// ---------- update_contact ----------

export async function updateContact(
  idArg: Identifier,
  fields: ContactFields
): Promise<{ id: string; name: string; updated_fields: string[] }> {
  const personId = await resolvePersonId(idArg);

  // Track which fields the caller asked to update so the response can
  // echo them back — saves callers an extra get_contact roundtrip.
  const updated: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) updated.push(k);
  }

  const sets: string[] = [];
  const setIfStr = (apProp: string, val?: string) => {
    if (val !== undefined && val !== "") sets.push(`set ${apProp} of p to ${q(val)}`);
  };
  // Note: empty string is treated as "leave alone"; to clear a field user would set to a single space.
  setIfStr("first name", fields.first_name);
  setIfStr("last name", fields.last_name);
  if (fields.prefix !== undefined) sets.push(`try
    set title of p to ${q(fields.prefix)}
  end try`);
  if (fields.suffix !== undefined) sets.push(`try
    set suffix of p to ${q(fields.suffix)}
  end try`);
  if (fields.nickname !== undefined) sets.push(`try
    set nickname of p to ${q(fields.nickname)}
  end try`);
  setIfStr("organization", fields.organization);
  if (fields.department !== undefined) sets.push(`try
    set department of p to ${q(fields.department)}
  end try`);
  setIfStr("job title", fields.job_title);
  if (fields.note !== undefined) sets.push(`set note of p to ${q(fields.note)}`);

  appendChildBlocks(sets, "p", fields, /*isUpdate*/ true);
  appendBirthdayBlock(sets, "p", fields.birthday);

  const photoSetup = await preparePhotoBlock("p", fields.photo);

  const script = `
tell application "Contacts"
  set p to person id ${q(personId)}
${sets.join("\n")}
${photoSetup.script}
  save
  return (id of p) & "${F}" & (name of p)
end tell`;

  let result: string;
  try {
    result = await runAppleScript(script);
  } finally {
    photoSetup.cleanup();
  }
  const [id, name] = result.split(F);
  return { id: (id ?? "").trim(), name: (name ?? "").trim(), updated_fields: updated };
}

// ---------- delete_contact ----------

export async function deleteContact(idArg: Identifier): Promise<string> {
  const personId = await resolvePersonId(idArg, { requireExtraIfNoId: true });
  const script = `
tell application "Contacts"
  set p to person id ${q(personId)}
  delete p
  save
end tell`;
  await runAppleScript(script);
  return `Contact deleted: ${personId}`;
}

// ---------- group membership ----------

export async function addContactToGroup(idArg: Identifier, groupName: string): Promise<string> {
  assertGroupAllowed(groupName);
  const personId = await resolvePersonId(idArg);
  // `first group whose name is X` is more robust than `group "X"` when
  // multiple groups share the name (it picks the first deterministically)
  // and resolves correctly across iCloud / On My Mac accounts.
  const script = `
tell application "Contacts"
  set p to person id ${q(personId)}
  set g to first group whose name is ${q(groupName)}
  add p to g
  save
end tell`;
  await runAppleScript(script);
  return `Added ${personId} to group ${groupName}`;
}

export async function removeContactFromGroup(idArg: Identifier, groupName: string): Promise<string> {
  assertGroupAllowed(groupName);
  const personId = await resolvePersonId(idArg);
  const script = `
tell application "Contacts"
  set p to person id ${q(personId)}
  set g to first group whose name is ${q(groupName)}
  remove p from g
  save
end tell`;
  await runAppleScript(script);
  return `Removed ${personId} from group ${groupName}`;
}

// ---------- batch_create_contacts ----------

const BATCH_MAX = 100;
const BATCH_DELIM = "<<<BATCH>>>";

export async function batchCreateContacts(entries: BatchCreateEntry[]): Promise<BatchResult> {
  if (entries.length === 0) throw new Error("contacts array must not be empty");
  if (entries.length > BATCH_MAX) throw new Error(`contacts array exceeds maximum of ${BATCH_MAX}`);

  // Pre-flight group check (same as single create)
  const targetGroup = defaultGroup();
  if (targetGroup) {
    const existing = await listGroups();
    if (!existing.some((g) => g.name === targetGroup)) {
      throw new Error(
        `Auto-add target group "${targetGroup}" does not exist in Apple Contacts. ` +
          `Create it first (e.g. via create_group), or unset ALLOWED_GROUPS.`
      );
    }
  }

  // Prepare photo temp files upfront (so we can clean them all up)
  const photoCleanups: (() => void)[] = [];
  const photoBlocks: PhotoBlock[] = [];
  for (const entry of entries) {
    const pb = await preparePhotoBlock("newPerson", entry.photo);
    photoBlocks.push(pb);
    photoCleanups.push(pb.cleanup);
  }

  // Build a single AppleScript with one try block per contact.
  // Each contact block outputs: "ok|||ID|||NAME" or "error|||message"
  // Blocks separated by BATCH_DELIM.
  const contactBlocks: string[] = [];
  const preValidationErrors: (string | null)[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const firstName = entry.first_name;
    const lastName = entry.last_name;

    // Pre-validate in JS (don't waste the whole AppleScript call)
    if (!firstName && !lastName && !entry.organization) {
      preValidationErrors.push("At least one of first_name, last_name, or organization is required");
      contactBlocks.push(""); // placeholder
      continue;
    }
    preValidationErrors.push(null); // ok to proceed

    const props: string[] = [];
    if (firstName) props.push(`first name:${q(firstName)}`);
    if (lastName) props.push(`last name:${q(lastName)}`);
    if (entry.prefix) props.push(`title:${q(entry.prefix)}`);
    if (entry.suffix) props.push(`suffix:${q(entry.suffix)}`);
    if (entry.nickname) props.push(`nickname:${q(entry.nickname)}`);
    if (entry.organization) props.push(`organization:${q(entry.organization)}`);
    if (entry.department) props.push(`department:${q(entry.department)}`);
    if (entry.job_title) props.push(`job title:${q(entry.job_title)}`);
    if (entry.note) props.push(`note:${q(entry.note)}`);

    const extras: string[] = [];
    appendChildBlocks(extras, "newPerson", entry, /*isUpdate*/ false);
    appendBirthdayBlock(extras, "newPerson", entry.birthday);

    const photoScript = photoBlocks[i]!.script;

    const block = `
    -- contact ${i}
    try
      set newPerson to make new person with properties {${props.join(", ")}}
${extras.map((l) => "      " + l).join("\n")}
      ${photoScript}
      set out to out & "ok${F}" & (id of newPerson) & "${F}" & (name of newPerson) & "${BATCH_DELIM}"
    on error errMsg
      set out to out & "error${F}" & errMsg & "${BATCH_DELIM}"
    end try`;
    contactBlocks.push(block);
  }

  // Build the full script. Only contacts that passed pre-validation go in.
  const liveBlocks = contactBlocks.filter((_, i) => preValidationErrors[i] === null);
  const script = `
tell application "Contacts"
  set out to ""
${liveBlocks.join("\n")}
  save
  return out
end tell`;

  let rawOutput = "";
  try {
    if (liveBlocks.length > 0) {
      rawOutput = await runAppleScript(script);
    }
  } finally {
    for (const cleanup of photoCleanups) cleanup();
  }

  // Parse AppleScript results for the live entries
  const asResults = rawOutput
    ? rawOutput.split(BATCH_DELIM).filter((s) => s.length > 0)
    : [];

  // Merge pre-validation errors and AppleScript results in order
  const results: BatchItemResult[] = [];
  let asIdx = 0;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < entries.length; i++) {
    if (preValidationErrors[i] !== null) {
      results.push({ index: i, status: "error", error: preValidationErrors[i]! });
      failed++;
      continue;
    }
    const asRec = asResults[asIdx++] ?? "";
    const parts = asRec.split(F);
    if (parts[0]?.trim() === "ok" && parts[1]) {
      const id = parts[1].trim();
      const name = parts[2]?.trim() ?? "";
      results.push({ index: i, status: "ok", id, name });
      succeeded++;
    } else {
      results.push({ index: i, status: "error", error: parts[1]?.trim() || "Unknown AppleScript error" });
      failed++;
    }
  }

  // Auto-add to group (per-item, non-fatal)
  if (targetGroup) {
    for (const r of results) {
      if (r.status !== "ok" || !r.id) continue;
      try {
        await addContactToGroupRaw(r.id, targetGroup);
        r.group_added = targetGroup;
      } catch (e) {
        r.group_warning = `Auto-add to "${targetGroup}" failed: ${(e as Error).message}`;
      }
    }
  }

  return { total: entries.length, succeeded, failed, results };
}

// ---------- batch_update_contacts ----------

export async function batchUpdateContacts(
  entries: BatchUpdateEntry[]
): Promise<BatchResult> {
  if (entries.length === 0) throw new Error("contacts array must not be empty");
  if (entries.length > BATCH_MAX) throw new Error(`contacts array exceeds maximum of ${BATCH_MAX}`);

  // Pre-validate: each entry must have contact_id or id
  const results: BatchItemResult[] = [];
  let succeeded = 0;
  let failed = 0;

  // Prepare photo temp files
  const photoCleanups: (() => void)[] = [];
  const photoBlocks: PhotoBlock[] = [];
  for (const entry of entries) {
    const pb = await preparePhotoBlock("p", entry.photo);
    photoBlocks.push(pb);
    photoCleanups.push(pb.cleanup);
  }

  // Build per-item AppleScript blocks
  const contactBlocks: string[] = [];
  const preValidationErrors: (string | null)[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const personId = entry.contact_id ?? entry.id;

    if (!personId) {
      preValidationErrors.push("contact_id (or id) is required for batch update");
      contactBlocks.push("");
      continue;
    }
    preValidationErrors.push(null);

    // Check ALLOWED_GROUPS membership (will be done inside AppleScript for speed)
    const sets: string[] = [];
    const setIfStr = (apProp: string, val?: string) => {
      if (val !== undefined && val !== "") sets.push(`set ${apProp} of p to ${q(val)}`);
    };

    setIfStr("first name", entry.first_name);
    setIfStr("last name", entry.last_name);
    if (entry.prefix !== undefined) sets.push(`try
        set title of p to ${q(entry.prefix)}
      end try`);
    if (entry.suffix !== undefined) sets.push(`try
        set suffix of p to ${q(entry.suffix)}
      end try`);
    if (entry.nickname !== undefined) sets.push(`try
        set nickname of p to ${q(entry.nickname)}
      end try`);
    setIfStr("organization", entry.organization);
    if (entry.department !== undefined) sets.push(`try
        set department of p to ${q(entry.department)}
      end try`);
    setIfStr("job title", entry.job_title);
    if (entry.note !== undefined) sets.push(`set note of p to ${q(entry.note)}`);

    appendChildBlocks(sets, "p", entry, /*isUpdate*/ true);
    appendBirthdayBlock(sets, "p", entry.birthday);

    const photoScript = photoBlocks[i]!.script;

    // Track updated fields for the response
    const updatedFields: string[] = [];
    for (const [k, v] of Object.entries(entry)) {
      if (k !== "contact_id" && k !== "id" && v !== undefined) updatedFields.push(k);
    }
    // Encode updated_fields as a comma-separated string inside the AS result
    const updatedStr = updatedFields.join(",");

    const block = `
    -- update ${i}
    try
      set p to person id ${q(personId)}
${sets.map((l) => "      " + l).join("\n")}
      ${photoScript}
      set out to out & "ok${F}" & (id of p) & "${F}" & (name of p) & "${F}" & "${updatedStr.replace(/"/g, '\\"')}" & "${BATCH_DELIM}"
    on error errMsg
      set out to out & "error${F}" & "${personId.replace(/"/g, '\\"')}" & "${F}" & errMsg & "${BATCH_DELIM}"
    end try`;
    contactBlocks.push(block);
  }

  const liveBlocks = contactBlocks.filter((_, i) => preValidationErrors[i] === null);
  const script = `
tell application "Contacts"
  set out to ""
${liveBlocks.join("\n")}
  save
  return out
end tell`;

  let rawOutput = "";
  try {
    if (liveBlocks.length > 0) {
      rawOutput = await runAppleScript(script);
    }
  } finally {
    for (const cleanup of photoCleanups) cleanup();
  }

  const asResults = rawOutput
    ? rawOutput.split(BATCH_DELIM).filter((s) => s.length > 0)
    : [];

  let asIdx = 0;
  for (let i = 0; i < entries.length; i++) {
    if (preValidationErrors[i] !== null) {
      results.push({ index: i, status: "error", error: preValidationErrors[i]! });
      failed++;
      continue;
    }
    const asRec = asResults[asIdx++] ?? "";
    const parts = asRec.split(F);
    if (parts[0]?.trim() === "ok" && parts[1]) {
      const id = parts[1].trim();
      const name = parts[2]?.trim() ?? "";
      const updatedFields = (parts[3] ?? "").split(",").filter(Boolean);
      results.push({ index: i, status: "ok", id, name, updated_fields: updatedFields });
      succeeded++;
    } else {
      const id = parts[1]?.trim();
      results.push({ index: i, status: "error", id, error: parts[2]?.trim() || "Unknown error" });
      failed++;
    }
  }

  return { total: entries.length, succeeded, failed, results };
}

// ---------- batch_get_contacts ----------

// Initially set to 500 but lowered to 250 after benchmarking: 100 contacts
// took ~174s in a single AppleScript run. At 500 the script would exceed
// osascript's practical timeout (~5-10min depending on system load).
// 250 contacts ≈ 4-5min which is aggressive but usually safe.
const BATCH_GET_MAX = 250;

// The per-person AppleScript read block used by both getContact and
// batchGetContacts. The variable `p` must already be set to the person
// reference. Returns a string expression that evaluates to the
// F-delimited record (same order as parseContactRecord expects).
function personReadBlock(): string {
  return `
  set theName to name of p
  set thePrefix to ""
  try
    set tmp to title of p
    if tmp is not missing value then set thePrefix to tmp as text
  end try
  set theFirst to ""
  try
    set tmp to first name of p
    if tmp is not missing value then set theFirst to tmp as text
  end try
  set theLast to ""
  try
    set tmp to last name of p
    if tmp is not missing value then set theLast to tmp as text
  end try
  set theSuffix to ""
  try
    set tmp to suffix of p
    if tmp is not missing value then set theSuffix to tmp as text
  end try
  set theNick to ""
  try
    set tmp to nickname of p
    if tmp is not missing value then set theNick to tmp as text
  end try
  set theOrg to ""
  try
    set tmp to organization of p
    if tmp is not missing value then set theOrg to tmp as text
  end try
  set theDept to ""
  try
    set tmp to department of p
    if tmp is not missing value then set theDept to tmp as text
  end try
  set theTitle to ""
  try
    set tmp to job title of p
    if tmp is not missing value then set theTitle to tmp as text
  end try

  set phStr to ""
  try
    repeat with x in phones of p
      set lbl to ""
      try
        set lbl to label of x
      end try
      set v to value of x
      set sub to lbl & "${KV}" & v
      if phStr is "" then
        set phStr to sub
      else
        set phStr to phStr & "${S}" & sub
      end if
    end repeat
  end try

  set emStr to ""
  try
    repeat with x in emails of p
      set lbl to ""
      try
        set lbl to label of x
      end try
      set v to value of x
      set sub to lbl & "${KV}" & v
      if emStr is "" then
        set emStr to sub
      else
        set emStr to emStr & "${S}" & sub
      end if
    end repeat
  end try

  set adStr to ""
  try
    repeat with x in addresses of p
      set lbl to ""
      try
        set lbl to label of x
      end try
      set streetVal to ""
      try
        set tmp to street of x
        if tmp is not missing value then set streetVal to tmp as text
      end try
      set cityVal to ""
      try
        set tmp to city of x
        if tmp is not missing value then set cityVal to tmp as text
      end try
      set stateVal to ""
      try
        set tmp to state of x
        if tmp is not missing value then set stateVal to tmp as text
      end try
      set zipVal to ""
      try
        set tmp to zip of x
        if tmp is not missing value then set zipVal to tmp as text
      end try
      set countryVal to ""
      try
        set tmp to country of x
        if tmp is not missing value then set countryVal to tmp as text
      end try
      set sub to lbl & "${KV}" & streetVal & "${KV}" & cityVal & "${KV}" & stateVal & "${KV}" & zipVal & "${KV}" & countryVal
      if adStr is "" then
        set adStr to sub
      else
        set adStr to adStr & "${S}" & sub
      end if
    end repeat
  end try

  set urStr to ""
  try
    repeat with x in urls of p
      set lbl to ""
      try
        set lbl to label of x
      end try
      set v to value of x
      set sub to lbl & "${KV}" & v
      if urStr is "" then
        set urStr to sub
      else
        set urStr to urStr & "${S}" & sub
      end if
    end repeat
  end try

  set bdStr to ""
  try
    set bd to birth date of p
    set yr to year of bd
    set mo to month of bd as integer
    set dy to day of bd
    set bdStr to (yr as string) & "-" & (mo as string) & "-" & (dy as string)
  end try

  set ntStr to ""
  try
    set tmp to note of p
    if tmp is not missing value then set ntStr to tmp as text
  end try

  set hasImg to "0"
  try
    set img to image of p
    if img is not missing value then set hasImg to "1"
  end try

  set modDateStr to ""
  try
    set md to modification date of p
    if md is not missing value then
      set yr to year of md
      set mo to month of md as integer
      set dy to day of md
      set hr to hours of md
      set mn to minutes of md
      set sc to seconds of md
      -- zero-pad each component
      set moS to text -2 thru -1 of ("0" & mo)
      set dyS to text -2 thru -1 of ("0" & dy)
      set hrS to text -2 thru -1 of ("0" & hr)
      set mnS to text -2 thru -1 of ("0" & mn)
      set scS to text -2 thru -1 of ("0" & sc)
      set modDateStr to (yr as string) & "-" & moS & "-" & dyS & "T" & hrS & ":" & mnS & ":" & scS
    end if
  end try

  set contactRec to theName & "${F}" & (id of p) & "${F}" & thePrefix & "${F}" & theFirst & "${F}" & theLast & "${F}" & theSuffix & "${F}" & theNick & "${F}" & theOrg & "${F}" & theDept & "${F}" & theTitle & "${F}" & phStr & "${F}" & emStr & "${F}" & adStr & "${F}" & urStr & "${F}" & bdStr & "${F}" & ntStr & "${F}" & hasImg & "${F}" & modDateStr`;
}

export async function batchGetContacts(contactIds: string[]): Promise<BatchGetResult> {
  if (contactIds.length === 0) throw new Error("contact_ids array must not be empty");
  if (contactIds.length > BATCH_GET_MAX) throw new Error(`contact_ids array exceeds maximum of ${BATCH_GET_MAX}`);

  // Pre-validate: skip empty IDs
  const preErrors: (string | null)[] = contactIds.map((id) =>
    id && id.trim() ? null : "contact_id must be a non-empty string"
  );

  // Build one AppleScript block per valid ID. Each block reads the full
  // contact record (same fields as getContact) and appends to `out`.
  // On error (e.g. not found), outputs "ERROR|||message" instead.
  const readBlock = personReadBlock();
  const perIdBlocks: string[] = [];

  for (let i = 0; i < contactIds.length; i++) {
    if (preErrors[i] !== null) continue;
    const pid = contactIds[i]!.trim();
    perIdBlocks.push(`
    -- get ${i}
    try
      set p to person id ${q(pid)}
${readBlock}
      set out to out & contactRec & "${BATCH_DELIM}"
    on error errMsg
      set out to out & "ERROR${F}" & errMsg & "${BATCH_DELIM}"
    end try`);
  }

  let rawOutput = "";
  if (perIdBlocks.length > 0) {
    const script = `
tell application "Contacts"
  set out to ""
${perIdBlocks.join("\n")}
  return out
end tell`;
    rawOutput = await runAppleScript(script);
  }

  const asResults = rawOutput
    ? rawOutput.split(BATCH_DELIM).filter((s) => s.length > 0)
    : [];

  const results: BatchGetItemResult[] = [];
  let asIdx = 0;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < contactIds.length; i++) {
    const cid = contactIds[i] ?? "";
    if (preErrors[i] !== null) {
      results.push({ index: i, status: "error", contact_id: cid, error: preErrors[i]! });
      failed++;
      continue;
    }
    const asRec = asResults[asIdx++] ?? "";
    // Check if this is an error record (starts with "ERROR|||")
    if (asRec.startsWith("ERROR" + F)) {
      const errMsg = asRec.slice(("ERROR" + F).length).trim();
      results.push({ index: i, status: "error", contact_id: cid, error: errMsg || "Unknown error" });
      failed++;
    } else {
      try {
        const contact = parseContactRecord(asRec);
        results.push({ index: i, status: "ok", contact_id: cid, contact });
        succeeded++;
      } catch (e) {
        results.push({ index: i, status: "error", contact_id: cid, error: `Parse error: ${(e as Error).message}` });
        failed++;
      }
    }
  }

  return { total: contactIds.length, succeeded, failed, results };
}

// ---------- helpers for create/update child collections ----------

function appendChildBlocks(out: string[], target: string, fields: ContactFields, isUpdate: boolean): void {
  // phones[] → replace
  if (fields.phones) {
    if (isUpdate) out.push(`delete every phone of ${target}`);
    for (const ph of fields.phones) {
      out.push(makeChildBlock(target, "phone", "phones", ph.label || "mobile", { value: ph.value }));
    }
  }
  // legacy single phone → append
  if (fields.phone) {
    out.push(makeChildBlock(target, "phone", "phones", "mobile", { value: fields.phone }));
  }

  if (fields.emails) {
    if (isUpdate) out.push(`delete every email of ${target}`);
    for (const em of fields.emails) {
      out.push(makeChildBlock(target, "email", "emails", em.label || "work", { value: em.value }));
    }
  }
  if (fields.email) {
    out.push(makeChildBlock(target, "email", "emails", "work", { value: fields.email }));
  }

  if (fields.urls) {
    if (isUpdate) out.push(`delete every url of ${target}`);
    for (const u of fields.urls) {
      out.push(makeChildBlock(target, "url", "urls", u.label || "homepage", { value: u.value }));
    }
  }

  if (fields.addresses) {
    if (isUpdate) out.push(`delete every address of ${target}`);
    for (const a of fields.addresses) {
      const street = a.street ?? a.formatted ?? "";
      const props: Record<string, string> = {};
      if (street) props.street = street;
      if (a.city) props.city = a.city;
      if (a.state) props.state = a.state;
      if (a.postal_code) props.zip = a.postal_code;
      if (a.country) props.country = a.country;
      out.push(makeChildBlock(target, "address", "addresses", a.label || "home", props));
    }
  }
}

// Apple Contacts requires the internal `_$!<Label>!$_` form for phone labels;
// passing "mobile" silently drops the phone (verified on macOS Sequoia/Sonoma).
// URLs and addresses preserve the internal form. Emails ignore the label entirely.
const LABEL_MAP: Record<string, string> = {
  mobile: "_$!<Mobile>!$_",
  work: "_$!<Work>!$_",
  home: "_$!<Home>!$_",
  main: "_$!<Main>!$_",
  other: "_$!<Other>!$_",
  homepage: "_$!<HomePage>!$_",
};

function internalLabel(friendly: string): string {
  return LABEL_MAP[friendly.toLowerCase()] ?? `_$!<${friendly[0]?.toUpperCase()}${friendly.slice(1)}>!$_`;
}

function makeChildBlock(
  target: string,
  itemKind: string,
  collection: string,
  label: string,
  extra: Record<string, string>
): string {
  const props: string[] = [`label:${q(internalLabel(label))}`];
  for (const [k, v] of Object.entries(extra)) {
    props.push(`${k}:${q(v)}`);
  }
  return `make new ${itemKind} at end of ${collection} of ${target} with properties {${props.join(", ")}}`;
}

function appendBirthdayBlock(out: string[], target: string, birthday?: string): void {
  if (!birthday) return;
  let year = 1604;
  let month: number;
  let day: number;
  const iso = birthday.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const md = birthday.match(/^(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    year = parseInt(iso[1]!, 10);
    month = parseInt(iso[2]!, 10);
    day = parseInt(iso[3]!, 10);
  } else if (md) {
    month = parseInt(md[1]!, 10);
    day = parseInt(md[2]!, 10);
  } else {
    throw new Error(`Invalid birthday format: ${birthday} (use YYYY-MM-DD or MM-DD)`);
  }
  out.push(`set theDate to current date
  set day of theDate to 1
  set year of theDate to ${year}
  set month of theDate to ${month}
  set day of theDate to ${day}
  set birth date of ${target} to theDate`);
}

interface PhotoBlock { script: string; cleanup: () => void }

async function preparePhotoBlock(target: string, photo?: string): Promise<PhotoBlock> {
  if (!photo) return { script: "", cleanup: () => {} };
  let path: string;
  let temp = false;
  if (photo.startsWith("/")) {
    if (!existsSync(photo)) throw new Error(`Photo path not found: ${photo}`);
    path = photo;
  } else {
    // base64
    const buf = Buffer.from(photo, "base64");
    path = join(tmpdir(), `applemcp_photo_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    writeFileSync(path, buf);
    temp = true;
  }
  const script = `try
    set image of ${target} to (read (POSIX file ${q(path)}) as picture)
  end try`;
  return {
    script,
    cleanup: () => {
      if (temp) {
        try {
          unlinkSync(path);
        } catch {}
      }
    },
  };
}
