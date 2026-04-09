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

export async function listContacts(group: string | undefined): Promise<ContactSummary[]> {
  assertGroupProvided(group);
  const scope = group ? `people of group ${q(group)}` : "people";
  const script = `
tell application "Contacts"
  set out to ""
  repeat with p in ${scope}
    set theName to name of p
    set theId to id of p
    set theOrg to ""
    try
      set theOrg to organization of p
    end try
    set thePhone to ""
    try
      if (count of phones of p) > 0 then set thePhone to value of (item 1 of phones of p)
    end try
    set theEmail to ""
    try
      if (count of emails of p) > 0 then set theEmail to value of (item 1 of emails of p)
    end try
    set rec to theName & "${F}" & theId & "${F}" & theOrg & "${F}" & thePhone & "${F}" & theEmail
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
    const parts = rec.split(F);
    return {
      name: (parts[0] ?? "").trim(),
      id: (parts[1] ?? "").trim(),
      organization: (parts[2] ?? "").trim() || null,
      primary_phone: (parts[3] ?? "").trim() || null,
      primary_email: (parts[4] ?? "").trim() || null,
    };
  });
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
      const items = await listContacts(g);
      for (const it of items) {
        if (seen.has(it.id)) continue;
        if (it.name.toLowerCase().includes(ql)) {
          out.push(it);
          seen.add(it.id);
        }
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

  // Find by name, then optionally filter by phone/email in JS.
  const script = `
tell application "Contacts"
  set out to ""
  set matched to (every person whose name is ${q(idArg.name)})
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
  const raw = await runAppleScript(script);
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

  const script = `
tell application "Contacts"
  set p to person id ${q(personId)}
  set theName to name of p
  set thePrefix to ""
  try
    set thePrefix to title of p
  end try
  set theFirst to ""
  try
    set theFirst to first name of p
  end try
  set theLast to ""
  try
    set theLast to last name of p
  end try
  set theSuffix to ""
  try
    set theSuffix to suffix of p
  end try
  set theNick to ""
  try
    set theNick to nickname of p
  end try
  set theOrg to ""
  try
    set theOrg to organization of p
  end try
  set theDept to ""
  try
    set theDept to department of p
  end try
  set theTitle to ""
  try
    set theTitle to job title of p
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
        set streetVal to street of x
      end try
      set cityVal to ""
      try
        set cityVal to city of x
      end try
      set stateVal to ""
      try
        set stateVal to state of x
      end try
      set zipVal to ""
      try
        set zipVal to zip of x
      end try
      set countryVal to ""
      try
        set countryVal to country of x
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
    set ntStr to note of p
  end try

  set hasImg to "0"
  try
    set img to image of p
    set hasImg to "1"
  end try

  return theName & "${F}" & (id of p) & "${F}" & thePrefix & "${F}" & theFirst & "${F}" & theLast & "${F}" & theSuffix & "${F}" & theNick & "${F}" & theOrg & "${F}" & theDept & "${F}" & theTitle & "${F}" & phStr & "${F}" & emStr & "${F}" & adStr & "${F}" & urStr & "${F}" & bdStr & "${F}" & ntStr & "${F}" & hasImg
end tell`;
  const raw = await runAppleScript(script);
  return parseContactRecord(raw);
}

function parseContactRecord(raw: string): ContactRecord {
  const p = raw.split(F);
  const get = (i: number) => (p[i] ?? "").trim();
  const orNull = (i: number) => {
    const v = get(i);
    return v ? v : null;
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

function parseLabelValueList(s: string): { label: string; value: string }[] {
  if (!s) return [];
  return s.split(S).map((sub) => {
    const [label, value] = sub.split(KV);
    return { label: cleanLabel(label ?? ""), value: (value ?? "").trim() };
  }).filter((x) => x.value);
}

function parseAddressList(s: string): Address[] {
  if (!s) return [];
  return s.split(S).map((sub) => {
    const parts = sub.split(KV);
    const addr: Address = { label: (cleanLabel(parts[0] ?? "") || "home") as Address["label"] };
    const street = (parts[1] ?? "").trim();
    const city = (parts[2] ?? "").trim();
    const state = (parts[3] ?? "").trim();
    const postal = (parts[4] ?? "").trim();
    const country = (parts[5] ?? "").trim();
    if (street) addr.street = street;
    if (city) addr.city = city;
    if (state) addr.state = state;
    if (postal) addr.postal_code = postal;
    if (country) addr.country = country;
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
  firstName: string,
  lastName: string,
  fields: ContactFields
): Promise<{ id: string; name: string }> {
  // Build property list for `make new person`
  const props: string[] = [];
  props.push(`first name:${q(firstName)}`);
  props.push(`last name:${q(lastName)}`);
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

  const script = `
tell application "Contacts"
  set newPerson to make new person with properties {${props.join(", ")}}
${extras.join("\n")}
${photoSetup.script}
  ${maybeAddToDefaultGroup("newPerson")}
  save
  return (id of newPerson) & "${F}" & (name of newPerson)
end tell`;

  let result: string;
  try {
    result = await runAppleScript(script);
  } finally {
    photoSetup.cleanup();
  }
  const [id, name] = result.split(F);
  return { id: (id ?? "").trim(), name: (name ?? "").trim() };
}

function maybeAddToDefaultGroup(varName: string): string {
  const g = defaultGroup();
  if (!g) return "";
  // Use AppleScript-quoted group name
  return `try
    add ${varName} to group ${q(g)}
  end try`;
}

// ---------- update_contact ----------

export async function updateContact(
  idArg: Identifier,
  fields: ContactFields
): Promise<{ id: string; name: string }> {
  const personId = await resolvePersonId(idArg);

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
  return { id: (id ?? "").trim(), name: (name ?? "").trim() };
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
  const script = `
tell application "Contacts"
  set p to person id ${q(personId)}
  set g to group ${q(groupName)}
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
  set g to group ${q(groupName)}
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
