#!/usr/bin/env node
// apple-mcp-extended — MCP server for Apple Contacts with full field support.
// Forked from https://github.com/griches/apple-mcp (MIT). See README.md for diff.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as contacts from "./contacts.js";
import { ContactFieldsSchema } from "./types.js";
import { isRestricted, allowedGroups } from "./safety.js";

const readOnly = process.argv.includes("--read-only");
const confirmDestructive = process.argv.includes("--confirm-destructive");

const server = new McpServer({
  name: "apple-mcp-extended",
  version: "0.1.0",
});

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const err = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
  isError: true,
});

// ---- list_groups ----
server.registerTool(
  "list_groups",
  { description: "List Apple Contacts groups (filtered to ALLOWED_GROUPS if set)", inputSchema: {} },
  async () => {
    try { return ok(await contacts.listGroups()); } catch (e) { return err(e); }
  }
);

// ---- list_contacts ----
server.registerTool(
  "list_contacts",
  {
    description:
      "List contacts in a group, paginated. When ALLOWED_GROUPS env var is set, the group argument is required and must be one of the allowed groups. Returns {items, total, offset, limit, next_offset}. Default limit=50, max=500. Set summary=true to return id+name only (organization/phone/email omitted) for cheaper enumeration of large groups.",
    inputSchema: {
      group: z.string().optional().describe("Group name to filter by"),
      // z.coerce.* tolerates clients that serialize numeric/boolean tool
      // args as strings (same root cause as the array→JSON-string fix
      // in 0.2.0).
      limit: z.coerce.number().int().positive().max(500).optional().describe("Page size (default 50, max 500)"),
      offset: z.coerce.number().int().nonnegative().optional().describe("Skip the first N matches (default 0)"),
      // Note: z.coerce.boolean treats any non-empty string as true
      // (including "false"), so we coerce manually here.
      summary: z
        .union([z.boolean(), z.enum(["true", "false", "1", "0"]).transform((s) => s === "true" || s === "1")])
        .optional()
        .describe("When true, items contain only id and name (~30B each) — ~3x smaller payload"),
    },
  },
  async ({ group, limit, offset, summary }) => {
    try { return ok(await contacts.listContacts(group, { limit, offset, summary })); } catch (e) { return err(e); }
  }
);

// ---- search_contacts ----
server.registerTool(
  "search_contacts",
  {
    description: "Search contacts by name substring. Results are restricted to ALLOWED_GROUPS members when set.",
    inputSchema: {
      query: z.string(),
      group: z.string().optional(),
    },
  },
  async ({ query, group }) => {
    try { return ok(await contacts.searchContacts(query, group)); } catch (e) { return err(e); }
  }
);

// ---- get_contact ----
server.registerTool(
  "get_contact",
  {
    description:
      "Get full details of a contact. Pass `contact_id` (or `id`) for unambiguous lookup. Otherwise pass `name` (substring/first+last fallback supported) with optional `phone`/`email` to disambiguate.",
    inputSchema: {
      contact_id: z.string().optional().describe("Apple Contacts person id (preferred). Alias for `id`."),
      id: z.string().optional().describe("Same as contact_id (back-compat)."),
      name: z.string().optional().describe("Full or partial name"),
      phone: z.string().optional().describe("Phone for name disambiguation"),
      email: z.string().optional().describe("Email for name disambiguation"),
    },
  },
  async ({ contact_id, id, name, phone, email }) => {
    try { return ok(await contacts.getContact({ id: contact_id ?? id, name, phone, email })); }
    catch (e) { return err(e); }
  }
);

// ---- create_contact ----
// Naming requirement relaxed (0.2.1): at least one of first_name / last_name
// / organization must be provided. Handles single-name contacts (e.g. "Elvis")
// and organization-only entries.
server.registerTool(
  "create_contact",
  {
    description:
      "Create a new contact. At least one of first_name, last_name, or organization is required. When ALLOWED_GROUPS is set, the contact is auto-added to the first allowed group.",
    inputSchema: {
      ...ContactFieldsSchema.shape,
      first_name: z.string().optional(),
      last_name: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const { first_name, last_name, ...rest } = args;
      if (!first_name && !last_name && !rest.organization) {
        throw new Error("At least one of first_name, last_name, or organization is required");
      }
      const r = await contacts.createContact(first_name, last_name, rest);
      return ok(r);
    } catch (e) { return err(e); }
  }
);

// ---- update_contact ----
server.registerTool(
  "update_contact",
  {
    description:
      "Update a contact. Pass `contact_id` (or `id`) for unambiguous lookup; otherwise `name` (+ optional `match_phone`/`match_email`). Array fields phones/emails/addresses/urls REPLACE existing values; legacy single `phone`/`email` APPEND.",
    inputSchema: {
      contact_id: z.string().optional().describe("Apple Contacts person id (preferred). Alias for `id`."),
      id: z.string().optional().describe("Same as contact_id (back-compat)."),
      name: z.string().optional(),
      match_phone: z.string().optional().describe("Phone for name disambiguation"),
      match_email: z.string().optional().describe("Email for name disambiguation"),
      ...ContactFieldsSchema.shape,
    },
  },
  async (args) => {
    try {
      const { contact_id, id, name, match_phone, match_email, ...fields } = args;
      const r = await contacts.updateContact(
        { id: contact_id ?? id, name, phone: match_phone, email: match_email },
        fields
      );
      return ok(r);
    } catch (e) { return err(e); }
  }
);

// ---- create_group ----
server.registerTool(
  "create_group",
  {
    description: "Create a contact group. Rejected if name is not in ALLOWED_GROUPS (when set).",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    try { return ok(await contacts.createGroup(name)); } catch (e) { return err(e); }
  }
);

// ---- add_contact_to_group ----
server.registerTool(
  "add_contact_to_group",
  {
    description: "Add an existing contact to a group.",
    inputSchema: {
      contact_id: z.string().optional(),
      contact_name: z.string().optional(),
      group_name: z.string(),
    },
  },
  async ({ contact_id, contact_name, group_name }) => {
    try { return ok(await contacts.addContactToGroup({ id: contact_id, name: contact_name }, group_name)); }
    catch (e) { return err(e); }
  }
);

// ---- remove_contact_from_group ----
server.registerTool(
  "remove_contact_from_group",
  {
    description: "Remove a contact from a group.",
    inputSchema: {
      contact_id: z.string().optional(),
      contact_name: z.string().optional(),
      group_name: z.string(),
    },
  },
  async ({ contact_id, contact_name, group_name }) => {
    try { return ok(await contacts.removeContactFromGroup({ id: contact_id, name: contact_name }, group_name)); }
    catch (e) { return err(e); }
  }
);

if (!readOnly) {
  // ---- delete_contact ----
  server.registerTool(
    "delete_contact",
    {
      description:
        "Delete a contact. Requires `contact_id` (or `id`); OR `name` + at least one of `phone`/`email` for disambiguation. " +
        (confirmDestructive ? "Pass confirm: true to authorize." : ""),
      inputSchema: {
        contact_id: z.string().optional().describe("Apple Contacts person id (preferred). Alias for `id`."),
        id: z.string().optional().describe("Same as contact_id (back-compat)."),
        name: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        ...(confirmDestructive ? { confirm: z.boolean().optional() } : {}),
      },
    },
    async ({ contact_id, id, name, phone, email, confirm }: any) => {
      if (confirmDestructive && !confirm) {
        return ok("This will permanently delete the contact. Confirm with confirm: true.");
      }
      try { return ok(await contacts.deleteContact({ id: contact_id ?? id, name, phone, email })); }
      catch (e) { return err(e); }
    }
  );

  // ---- delete_group ----
  server.registerTool(
    "delete_group",
    {
      description: "Delete a contact group. " + (confirmDestructive ? "Pass confirm: true." : ""),
      inputSchema: {
        name: z.string(),
        ...(confirmDestructive ? { confirm: z.boolean().optional() } : {}),
      },
    },
    async ({ name, confirm }: any) => {
      if (confirmDestructive && !confirm) {
        return ok("This will permanently delete the group. Confirm with confirm: true.");
      }
      try { return ok(await contacts.deleteGroup(name)); } catch (e) { return err(e); }
    }
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const restriction = isRestricted() ? `ALLOWED_GROUPS=${allowedGroups().join(",")}` : "ALLOWED_GROUPS=<unset, all groups allowed>";
  console.error(`apple-mcp-extended running on stdio (${restriction}${readOnly ? ", read-only" : ""})`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
