// Roundtrip test: create → get → update → get → delete a dummy contact.
// Exercises every supported field. Run via `npm run test:roundtrip`.
//
// Uses an unmistakable name prefix so leftovers from a crashed run are obvious.

import { z } from "zod";

import * as contacts from "../src/contacts.js";
import { ContactFieldsSchema } from "../src/types.js";

const TAG = "__APPLEMCPTEST__";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

let pass = 0;
let fail = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    pass++;
  } else {
    console.log(`  ✗ ${msg}`);
    fail++;
  }
}

// 1×1 transparent PNG
const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";

async function main() {
  console.log(`# apple-mcp-extended roundtrip test [${stamp}]`);

  // ----- CREATE -----
  console.log("\n[1] create_contact with full fields");
  const created = await contacts.createContact(`${TAG}First`, `${TAG}Last`, {
    prefix: "Dr.",
    suffix: "Jr.",
    nickname: "Tester",
    organization: "Acme Inc",
    department: "R&D",
    job_title: "수석 엔지니어",
    phones: [
      { label: "mobile", value: "010-1111-2222" },
      { label: "work", value: "02-555-0100" },
    ],
    emails: [
      { label: "work", value: "tester@acme.example" },
      { label: "home", value: "tester@home.example" },
    ],
    addresses: [
      {
        label: "work",
        street: "123 Sample St",
        city: "Seoul",
        state: "Seoul",
        postal_code: "04524",
        country: "Korea",
      },
    ],
    urls: [{ label: "homepage", value: "https://example.com" }],
    birthday: "03-15",
    photo: tinyPng,
    note: "줄1\n줄2 — Korean newline test\n줄3",
  });
  console.log(`  created id=${created.id} name=${created.name}`);
  assert(!!created.id, "created id is non-empty");

  // ----- GET -----
  console.log("\n[2] get_contact by id");
  const got = await contacts.getContact({ id: created.id });
  assert(got.id === created.id, "id roundtrip");
  assert(got.first_name === `${TAG}First`, "first_name");
  assert(got.last_name === `${TAG}Last`, "last_name");
  assert(got.prefix === "Dr.", `prefix=${got.prefix}`);
  assert(got.suffix === "Jr.", `suffix=${got.suffix}`);
  assert(got.nickname === "Tester", `nickname=${got.nickname}`);
  assert(got.organization === "Acme Inc", `organization=${got.organization}`);
  assert(got.department === "R&D", `department=${got.department}`);
  assert(got.job_title === "수석 엔지니어", `job_title=${got.job_title}`);
  assert(got.phones.length === 2, `phones count=${got.phones.length}`);
  assert(got.phones.some((p) => p.value.includes("1111-2222") && p.label === "mobile"), "mobile phone");
  assert(got.phones.some((p) => p.value.includes("555-0100") && p.label === "work"), "work phone");
  assert(got.emails.length === 2, `emails count=${got.emails.length}`);
  // Note: Apple Contacts AppleScript does not preserve email labels — value-only check.
  assert(got.emails.some((e) => e.value === "tester@acme.example"), "work email value present");
  assert(got.addresses.length === 1, `addresses count=${got.addresses.length}`);
  assert(got.addresses[0]?.city === "Seoul", `addr city=${got.addresses[0]?.city}`);
  assert(got.addresses[0]?.postal_code === "04524", `addr postal=${got.addresses[0]?.postal_code}`);
  assert(got.urls.length === 1 && got.urls[0]?.value === "https://example.com", "url");
  assert(got.birthday === "03-15", `birthday=${got.birthday}`);
  assert(got.note?.includes("줄1") && got.note?.includes("줄2") && got.note?.includes("줄3"), "note Korean preserved");
  assert(got.note?.includes("\n"), "note has real newline (not literal \\n)");
  assert(got.has_photo === true, "has_photo=true");
  assert(typeof got.modification_date === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(got.modification_date), `modification_date ISO format: ${got.modification_date}`);

  // ----- UPDATE -----
  console.log("\n[3] update_contact: replace phones, change job_title and birthday");
  await contacts.updateContact(
    { id: created.id },
    {
      job_title: "Principal Engineer",
      phones: [{ label: "mobile", value: "010-9999-0000" }],
      birthday: "1990-12-25",
      note: "single line after update",
    }
  );

  // ----- GET 2 -----
  console.log("\n[4] get_contact after update");
  const got2 = await contacts.getContact({ id: created.id });
  assert(got2.job_title === "Principal Engineer", `job_title=${got2.job_title}`);
  assert(got2.phones.length === 1, `phones replaced count=${got2.phones.length}`);
  assert(got2.phones[0]?.value.includes("9999-0000"), "new mobile present");
  assert(got2.birthday === "1990-12-25", `birthday=${got2.birthday}`);
  assert(got2.note === "single line after update", "note replaced");

  // ----- 0.2.0 regression: minimal contact (no prefix/suffix/photo) -----
  console.log("\n[5] minimal contact: missing-value + has_photo regression");
  const bare = await contacts.createContact(`${TAG}Bare`, `${TAG}Last`, {
    organization: "BareOrg",
  });
  const gotBare = await contacts.getContact({ id: bare.id });
  assert(gotBare.prefix === null, `bare prefix=${JSON.stringify(gotBare.prefix)} (expect null, not "missing value")`);
  assert(gotBare.suffix === null, `bare suffix=${JSON.stringify(gotBare.suffix)} (expect null)`);
  assert(gotBare.nickname === null, `bare nickname=${JSON.stringify(gotBare.nickname)} (expect null)`);
  assert(gotBare.department === null, `bare department=${JSON.stringify(gotBare.department)} (expect null)`);
  assert(gotBare.note === null, `bare note=${JSON.stringify(gotBare.note)} (expect null)`);
  assert(gotBare.has_photo === false, `bare has_photo=${gotBare.has_photo} (expect false)`);
  await contacts.deleteContact({ id: bare.id });

  // ----- 0.2.0 regression: name lookup fallback (Issue 5) -----
  console.log("\n[6] name lookup fallback: first+last when prefix is set");
  const drC = await contacts.createContact(`${TAG}Foo`, `${TAG}Bar`, {
    prefix: "Dr.",
  });
  // Display name will be "Dr. __APPLEMCPTEST__Foo __APPLEMCPTEST__Bar".
  // Looking up by "first last" (without prefix) used to fail.
  let lookupOk = false;
  try {
    const found = await contacts.getContact({ name: `${TAG}Foo ${TAG}Bar` });
    lookupOk = found.id === drC.id;
  } catch (e) {
    console.log(`    lookup error: ${(e as Error).message}`);
  }
  assert(lookupOk, "first+last lookup succeeds when prefix is set");
  await contacts.deleteContact({ id: drC.id });

  // ----- 0.2.0 regression: jsonOrArray (Bug 1) — schema-only test -----
  console.log("\n[7] schema: phones[] accepts JSON-stringified array");
  const parsed = ContactFieldsSchema.parse({
    phones: '[{"label":"mobile","value":"+82 10-1111-2222"}]',
  });
  assert(Array.isArray(parsed.phones), "phones parsed as array");
  assert(parsed.phones?.[0]?.value === "+82 10-1111-2222", "phones[0].value");
  // Real array still works
  const parsed2 = ContactFieldsSchema.parse({
    phones: [{ label: "work", value: "x" }],
  });
  assert(parsed2.phones?.[0]?.label === "work", "raw array still accepted");

  // ----- 0.2.0 regression: list_contacts pagination (Issue 7) -----
  console.log("\n[8] list_contacts pagination shape");
  const page = await contacts.listContacts(undefined, { limit: 2, offset: 0 });
  assert(Array.isArray(page.items), "page.items is array");
  assert(typeof page.total === "number" && page.total >= 0, `page.total=${page.total}`);
  assert(page.limit === 2, `page.limit=${page.limit}`);
  assert(page.offset === 0, `page.offset=${page.offset}`);
  if (page.items.length > 0) {
    const item0 = page.items[0]!;
    assert(
      typeof item0.modification_date === "string" && /^\d{4}/.test(item0.modification_date),
      `list_contacts item has modification_date: ${item0.modification_date}`
    );
  }
  if (page.total >= 3) {
    assert(page.items.length === 2, `items.length=${page.items.length}`);
    assert(page.next_offset === 2, `next_offset=${page.next_offset}`);
  } else {
    console.log(`  (skipped strict pagination assertions; total=${page.total} < 3)`);
  }

  // ----- 0.2.2 regression: list_contacts limit/offset accept stringified numbers -----
  console.log("\n[P1-022] list_contacts limit/offset coerced from string");
  // Mirror the index.ts schema exactly so we test the actual coercion path.
  const listSchema = z.object({
    group: z.string().optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
    summary: z
      .union([z.boolean(), z.enum(["true", "false", "1", "0"]).transform((s) => s === "true" || s === "1")])
      .optional(),
  });
  const coerced = listSchema.parse({ limit: "200", offset: "10", summary: "true" });
  assert(coerced.limit === 200 && typeof coerced.limit === "number", `limit coerced to number (got ${coerced.limit})`);
  assert(coerced.offset === 10, `offset coerced (got ${coerced.offset})`);
  assert(coerced.summary === true, `summary "true" → true`);
  const coerced2 = listSchema.parse({ summary: "false" });
  assert(coerced2.summary === false, `summary "false" → false (not truthy)`);
  const coerced3 = listSchema.parse({ limit: 5, offset: 0, summary: true });
  assert(coerced3.limit === 5 && coerced3.summary === true, "raw number/boolean still accepted");

  // ----- 0.2.1 regression: address subfield must not leak "missing value" -----
  console.log("\n[P1] address subfield missing-value regression");
  const addrOnly = await contacts.createContact(`${TAG}Addr`, `${TAG}Only`, {
    addresses: [{ label: "work", street: "21990 인천광역시 연수구 첨단대로60번길 45" }],
  });
  const gotAddr = await contacts.getContact({ id: addrOnly.id });
  const a0 = gotAddr.addresses[0];
  assert(!!a0, "address returned");
  assert(a0?.street?.includes("인천") === true, "street preserved");
  assert((a0 as any)?.city !== "missing value", `city no leak (got ${JSON.stringify(a0?.city)})`);
  assert((a0 as any)?.state !== "missing value", `state no leak`);
  assert((a0 as any)?.postal_code !== "missing value", `postal_code no leak`);
  assert((a0 as any)?.country !== "missing value", `country no leak`);
  assert(typeof a0?.formatted === "string" && a0.formatted.includes("인천"), `formatted synthesized (${a0?.formatted})`);
  await contacts.deleteContact({ id: addrOnly.id });

  // ----- 0.2.1 regression: single-name contact (P2) -----
  console.log("\n[P2] single-name contact allowed");
  const elvis = await contacts.createContact(`${TAG}Elvis`, undefined, {
    organization: "The King LLC",
  });
  assert(!!elvis.id, "single-first-name create ok");
  const gotElvis = await contacts.getContact({ id: elvis.id });
  assert(gotElvis.first_name === `${TAG}Elvis`, `first_name=${gotElvis.first_name}`);
  assert(gotElvis.last_name === null, `last_name=${gotElvis.last_name}`);
  await contacts.deleteContact({ id: elvis.id });

  // organization-only contact
  const orgOnly = await contacts.createContact(undefined, undefined, {
    organization: `${TAG}OrgCo`,
  });
  assert(!!orgOnly.id, "organization-only create ok");
  await contacts.deleteContact({ id: orgOnly.id });

  // ----- 0.2.1/0.5.0: list_contacts summary mode (P5) -----
  // summary=true is now an alias for "full" mode (all summary fields).
  // Use summary="minimal" for id+name+modification_date only.
  console.log("\n[P5] list_contacts summary=true (full mode)");
  const sum = await contacts.listContacts(undefined, { limit: 3, offset: 0, summary: true });
  assert(sum.items.length <= 3, `summary items.length=${sum.items.length}`);
  if (sum.items.length > 0) {
    const it = sum.items[0]!;
    assert(typeof it.id === "string" && typeof it.name === "string", "summary has id+name");
    assert(typeof it.modification_date === "string", "summary has modification_date");
  }

  // ----- 0.2.1: updated_fields echo (P6) -----
  console.log("\n[P6] updated_fields echo on update_contact");
  const echoC = await contacts.createContact(`${TAG}Echo`, `${TAG}X`, { organization: "Orig" });
  const upd = await contacts.updateContact(
    { id: echoC.id },
    { job_title: "Manager", organization: "New" }
  );
  assert(Array.isArray(upd.updated_fields), "updated_fields present");
  assert(upd.updated_fields.includes("job_title"), `updated_fields has job_title (${upd.updated_fields.join(",")})`);
  assert(upd.updated_fields.includes("organization"), "updated_fields has organization");
  assert(!upd.updated_fields.includes("note"), "updated_fields excludes untouched");
  await contacts.deleteContact({ id: echoC.id });

  // ----- batch_create_contacts -----
  console.log("\n[BATCH-C] batch_create_contacts");
  const batchCreateResult = await contacts.batchCreateContacts([
    { first_name: `${TAG}Batch1`, last_name: "One", organization: "BatchOrg", phones: [{ label: "mobile", value: "+82 10-0001-0001" }] },
    { first_name: `${TAG}Batch2`, last_name: "Two", emails: [{ label: "work", value: "batch2@example.com" }], note: "배치\n테스트" },
    { first_name: `${TAG}Batch3` },  // single name, no last
    { organization: `${TAG}OrgOnly` }, // org-only
    {} as any, // should fail: no name or org
  ]);
  assert(batchCreateResult.total === 5, `batch total=${batchCreateResult.total}`);
  assert(batchCreateResult.succeeded === 4, `batch succeeded=${batchCreateResult.succeeded}`);
  assert(batchCreateResult.failed === 1, `batch failed=${batchCreateResult.failed}`);
  assert(batchCreateResult.results[0]?.status === "ok", "batch[0] ok");
  assert(!!batchCreateResult.results[0]?.id, "batch[0] has id");
  assert(batchCreateResult.results[4]?.status === "error", "batch[4] error (no name/org)");
  console.log(`  batch create: ${batchCreateResult.succeeded} ok, ${batchCreateResult.failed} err`);

  // ----- batch_update_contacts -----
  console.log("\n[BATCH-U] batch_update_contacts");
  const idsToUpdate = batchCreateResult.results.filter((r) => r.status === "ok").map((r) => r.id!);
  const batchUpdateResult = await contacts.batchUpdateContacts([
    { contact_id: idsToUpdate[0], job_title: "Batch Manager" },
    { contact_id: idsToUpdate[1], note: "updated batch note" },
    { contact_id: "NONEXISTENT:ABPerson" }, // should fail
  ]);
  assert(batchUpdateResult.total === 3, `batch-u total=${batchUpdateResult.total}`);
  assert(batchUpdateResult.succeeded === 2, `batch-u succeeded=${batchUpdateResult.succeeded}`);
  assert(batchUpdateResult.failed === 1, `batch-u failed=${batchUpdateResult.failed}`);
  assert(batchUpdateResult.results[0]?.status === "ok", "batch-u[0] ok");
  assert(batchUpdateResult.results[0]?.updated_fields?.includes("job_title"), "batch-u[0] updated_fields has job_title");
  assert(batchUpdateResult.results[2]?.status === "error", "batch-u[2] error (nonexistent)");
  console.log(`  batch update: ${batchUpdateResult.succeeded} ok, ${batchUpdateResult.failed} err`);

  // Verify one of the updates actually stuck
  const verifyBatch = await contacts.getContact({ id: idsToUpdate[0]! });
  assert(verifyBatch.job_title === "Batch Manager", `batch-u verify job_title=${verifyBatch.job_title}`);

  // Cleanup batch contacts
  for (const id of idsToUpdate) {
    await contacts.deleteContact({ id });
  }
  console.log(`  cleaned up ${idsToUpdate.length} batch contacts`);

  // ----- batch_get_contacts -----
  console.log("\n[BATCH-G] batch_get_contacts");
  // Create 3 contacts for batch get
  const bgIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const c = await contacts.createContact(`${TAG}BG${i}`, "Get", {
      organization: `BGOrg${i}`,
      phones: [{ label: "mobile", value: `+82 10-${String(i).padStart(4, "0")}-0000` }],
      note: `bg note ${i}\n줄2`,
    });
    bgIds.push(c.id);
  }
  // Normal batch get
  const bgResult = await contacts.batchGetContacts(bgIds);
  assert(bgResult.total === 3, `bg total=${bgResult.total}`);
  assert(bgResult.succeeded === 3, `bg succeeded=${bgResult.succeeded}`);
  assert(bgResult.failed === 0, `bg failed=${bgResult.failed}`);
  const bg0 = bgResult.results[0]!;
  assert(bg0.status === "ok" && bg0.contact_id === bgIds[0], "bg[0] ok + contact_id echo");
  assert(bg0.contact?.first_name === `${TAG}BG0`, `bg[0] first_name=${bg0.contact?.first_name}`);
  assert(bg0.contact?.organization === "BGOrg0", `bg[0] org=${bg0.contact?.organization}`);
  assert(bg0.contact?.phones.length === 1, "bg[0] phones count");
  assert(bg0.contact?.note?.includes("줄2"), "bg[0] note newline preserved");
  assert(typeof bg0.contact?.modification_date === "string" && /^\d{4}/.test(bg0.contact.modification_date), `bg[0] modification_date: ${bg0.contact?.modification_date}`);
  // Include a nonexistent ID
  const bgMixed = await contacts.batchGetContacts([bgIds[0]!, "NONEXISTENT:ABPerson", bgIds[2]!]);
  assert(bgMixed.succeeded === 2, `bg-mixed succeeded=${bgMixed.succeeded}`);
  assert(bgMixed.failed === 1, `bg-mixed failed=${bgMixed.failed}`);
  assert(bgMixed.results[1]?.status === "error", "bg-mixed[1] error");
  assert(bgMixed.results[1]?.contact_id === "NONEXISTENT:ABPerson", "bg-mixed[1] contact_id echo");
  assert(bgMixed.results[0]?.status === "ok" && bgMixed.results[2]?.status === "ok", "bg-mixed[0,2] ok");
  // Empty ID should fail pre-validation
  const bgEmpty = await contacts.batchGetContacts([bgIds[0]!, ""]);
  assert(bgEmpty.failed === 1, "bg empty-id fails");
  assert(bgEmpty.results[1]?.error?.includes("non-empty"), `bg empty-id error msg`);
  // JSON-string array schema test
  const bgSchema = z.union([
    z.array(z.string()),
    z.string().transform((s) => JSON.parse(s) as string[]),
  ]);
  const bgParsed = bgSchema.parse(JSON.stringify(bgIds));
  assert(Array.isArray(bgParsed) && bgParsed.length === 3, "JSON-stringified string[] parsed");

  // Cleanup
  for (const id of bgIds) {
    await contacts.deleteContact({ id });
  }
  console.log(`  cleaned up ${bgIds.length} batch-get contacts`);

  // ----- Performance benchmark: batch_get N=100 -----
  console.log("\n[PERF] batch_get_contacts performance benchmark");
  // Use existing contacts (listContacts first 100)
  const perfPage = await contacts.listContacts(undefined, { limit: 100, offset: 0 });
  if (perfPage.items.length >= 10) {
    const perfIds = perfPage.items.map((it) => it.id);
    const t0 = Date.now();
    const perfResult = await contacts.batchGetContacts(perfIds);
    const elapsed = Date.now() - t0;
    console.log(`  batch_get ${perfIds.length} contacts: ${elapsed}ms (${perfResult.succeeded} ok, ${perfResult.failed} err)`);
    assert(perfResult.succeeded === perfIds.length, `perf all succeeded`);
  } else {
    console.log(`  (skipped: only ${perfPage.items.length} contacts available, need >=10)`);
  }

  // ----- 0.5.0/0.5.1: summary="minimal" -----
  console.log("\n[MIN] list_contacts summary=minimal");
  const minPage = await contacts.listContacts(undefined, { limit: 5, offset: 0, summary: "minimal" });
  assert(Array.isArray(minPage.items), "minimal: items is array");
  if (minPage.items.length > 0) {
    const mi = minPage.items[0]! as any;
    assert(typeof mi.id === "string" && typeof mi.name === "string", "minimal: has id+name");
    // Key absence check: organization/primary_phone/primary_email must NOT be present at all
    assert(!("organization" in mi), `minimal: organization key absent (keys: ${Object.keys(mi).join(",")})`);
    assert(!("primary_phone" in mi), "minimal: primary_phone key absent");
    assert(!("primary_email" in mi), "minimal: primary_email key absent");
    assert(typeof mi.modification_date === "string", `minimal: has modification_date: ${mi.modification_date}`);
    // Size check
    const itemJson = JSON.stringify(mi);
    assert(itemJson.length < 150, `minimal: item JSON < 150B (got ${itemJson.length}B: ${itemJson.slice(0, 80)}...)`);
  }

  // ----- 0.5.0: changed_since -----
  console.log("\n[CS] list_contacts changed_since");
  // Future date → 0 results
  const futureResult = await contacts.listContacts(undefined, {
    limit: 10, changed_since: "2099-12-31T23:59:59",
  });
  assert(futureResult.total === 0, `changed_since future: total=${futureResult.total}`);
  assert(futureResult.items.length === 0, "changed_since future: empty items");

  // Very old date → should return same as no filter
  const oldResult = await contacts.listContacts(undefined, {
    limit: 5, changed_since: "2000-01-01T00:00:00",
  });
  assert(oldResult.total > 0, `changed_since old: total=${oldResult.total}`);
  assert(oldResult.items.length <= 5, "changed_since old: limit respected");

  // changed_since + minimal combo
  const comboResult = await contacts.listContacts(undefined, {
    limit: 500, summary: "minimal", changed_since: "2000-01-01T00:00:00",
  });
  assert(comboResult.total > 0, `combo: total=${comboResult.total}`);
  if (comboResult.items.length > 0) {
    assert(!("organization" in comboResult.items[0]!), "combo: minimal org key absent");
    assert(typeof comboResult.items[0]!.modification_date === "string", "combo: has modDate");
  }

  // Invalid changed_since → error
  let csErrOk = false;
  try {
    await contacts.listContacts(undefined, { changed_since: "not-a-date" });
  } catch (e) {
    csErrOk = (e as Error).message.includes("Invalid changed_since");
  }
  assert(csErrOk, "invalid changed_since throws clear error");

  // ----- 0.5.0: performance benchmarks -----
  console.log("\n[PERF-LIST] list_contacts performance comparison");
  const perfGroup = undefined; // all contacts
  const benchmarks: { label: string; elapsed: number; total: number; size: number }[] = [];

  // Full mode, limit 500
  {
    const t0 = Date.now();
    const r = await contacts.listContacts(perfGroup, { limit: 500 });
    const elapsed = Date.now() - t0;
    const size = JSON.stringify(r).length;
    benchmarks.push({ label: "full (limit=500)", elapsed, total: r.total, size });
  }
  // summary=true (same as full in current impl)
  {
    const t0 = Date.now();
    const r = await contacts.listContacts(perfGroup, { limit: 500, summary: true });
    const elapsed = Date.now() - t0;
    const size = JSON.stringify(r).length;
    benchmarks.push({ label: "summary=true (limit=500)", elapsed, total: r.total, size });
  }
  // summary=minimal, limit 500
  {
    const t0 = Date.now();
    const r = await contacts.listContacts(perfGroup, { limit: 500, summary: "minimal" });
    const elapsed = Date.now() - t0;
    const size = JSON.stringify(r).length;
    benchmarks.push({ label: 'summary="minimal" (limit=500)', elapsed, total: r.total, size });
  }
  // changed_since=1h ago + minimal
  {
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, "");
    const t0 = Date.now();
    const r = await contacts.listContacts(perfGroup, { limit: 500, summary: "minimal", changed_since: oneHourAgo });
    const elapsed = Date.now() - t0;
    const size = JSON.stringify(r).length;
    benchmarks.push({ label: `changed_since=1h ago + minimal`, elapsed, total: r.total, size });
  }
  for (const b of benchmarks) {
    console.log(`  ${b.label}: ${b.elapsed}ms, total=${b.total}, response=${(b.size / 1024).toFixed(1)}KB`);
  }

  // ----- DELETE main contact -----
  console.log("\n[9] delete_contact by id");
  const delMsg = await contacts.deleteContact({ id: created.id });
  console.log(`  ${delMsg}`);

  // verify gone
  let stillThere = false;
  try {
    await contacts.getContact({ id: created.id });
    stillThere = true;
  } catch {
    /* expected */
  }
  assert(!stillThere, "contact is gone after delete");

  console.log(`\n# Result: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error("\nFATAL:", e);
  console.error(`\nIf a leftover ${TAG} contact exists, delete it manually in Contacts.app.`);
  process.exit(2);
});
