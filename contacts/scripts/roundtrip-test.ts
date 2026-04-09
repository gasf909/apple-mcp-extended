// Roundtrip test: create → get → update → get → delete a dummy contact.
// Exercises every supported field. Run via `npm run test:roundtrip`.
//
// Uses an unmistakable name prefix so leftovers from a crashed run are obvious.

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
  if (page.total >= 3) {
    assert(page.items.length === 2, `items.length=${page.items.length}`);
    assert(page.next_offset === 2, `next_offset=${page.next_offset}`);
  } else {
    console.log(`  (skipped strict pagination assertions; total=${page.total} < 3)`);
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
