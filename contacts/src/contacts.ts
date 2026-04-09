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
  opts: { limit?: number; offset?: number; summary?: boolean } = {}
): Promise<ListContactsResult> {
  assertGroupProvided(group);
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT));
  const offset = Math.max(0, opts.offset ?? 0);
  const summary = !!opts.summary;

  // We page in AppleScript so the script never returns more than `limit`
  // contacts. The total count is included as a header so callers can
  // paginate without an extra round-trip.
  //
  // summary=true: emit only name + id per record (≈30B each) so very large
  // groups can be cheaply enumerated.
  const scope = group ? `people of group ${q(group)}` : "people";
  const perRecordScript = summary
    ? `set rec to theName & "${F}" & theId`
    : `set rec to theName & "${F}" & theId & "${F}" & theOrg & "${F}" & thePhone & "${F}" & theEmail`;
  const perRecordReaders = summary
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
  const script = `
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
    set theId to id of p${perRecordReaders}
    ${perRecordScript}
    set out to out & "${R}" & rec
  end repeat
  return out
end tell`;
  const raw = await runAppleScript(script);
  // Header line: "TOTAL=N" then records joined by R.
  const [headerAndFirst, ...rest] = raw.split(R);
  const headerMatch = (headerAndFirst ?? "").match(/^TOTAL=(\d+)$/);
  let total = 0;
  let recordSlice: string[] = [];
  if (headerMatch) {
    total = parseInt(headerMatch[1]!, 10);
    recordSlice = rest;
  } else {
    // Defensive: header missing → treat the whole payload as records.
    recordSlice = headerAndFirst ? [headerAndFirst, ...rest] : [];
  }

  const items: ContactSummary[] = recordSlice
    .filter((r) => r.length > 0)
    .map((rec) => {
      const parts = rec.split(F);
      return {
        name: (parts[0] ?? "").trim(),
        id: (parts[1] ?? "").trim(),
        organization: summary ? null : cleanField(parts[2]) || null,
        primary_phone: summary ? null : cleanField(parts[3]) || null,
        primary_email: summary ? null : cleanField(parts[4]) || null,
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

  return theName & "${F}" & (id of p) & "${F}" & thePrefix & "${F}" & theFirst & "${F}" & theLast & "${F}" & theSuffix & "${F}" & theNick & "${F}" & theOrg & "${F}" & theDept & "${F}" & theTitle & "${F}" & phStr & "${F}" & emStr & "${F}" & adStr & "${F}" & urStr & "${F}" & bdStr & "${F}" & ntStr & "${F}" & hasImg
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
