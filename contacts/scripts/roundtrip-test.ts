// Roundtrip test: create → get → update → get → delete a dummy contact.
// Exercises every supported field. Run via `npm run test:roundtrip`.
//
// Uses an unmistakable name prefix so leftovers from a crashed run are obvious.

import * as contacts from "../src/contacts.js";

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

  // ----- DELETE by id -----
  console.log("\n[5] delete_contact by id");
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
