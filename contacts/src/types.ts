import { z } from "zod";

// Some MCP clients (and any caller that goes through a JSON tool-call
// transport that flattens object args to strings) will send array params
// as a JSON-encoded string, e.g. phones: '[{"label":"mobile","value":"x"}]'.
// jsonOrArray() accepts both the raw array and the string form so callers
// don't have to know which serializer is in use.
export function jsonOrArray<T extends z.ZodTypeAny>(itemSchema: T) {
  const arr = z.array(itemSchema);
  return z.union([
    arr,
    z.string().transform((s, ctx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(s);
      } catch (e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected array or JSON string of array; ${(e as Error).message}`,
        });
        return z.NEVER;
      }
      const result = arr.safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `parsed JSON did not match schema: ${result.error.message}`,
        });
        return z.NEVER;
      }
      return result.data;
    }),
  ]);
}

// Label enums
export const PhoneLabel = z.enum(["mobile", "work", "home", "main", "other"]);
export const EmailLabel = z.enum(["work", "home", "other"]);
export const AddressLabel = z.enum(["work", "home", "other"]);
export const UrlLabel = z.enum(["work", "home", "homepage", "other"]);

export const PhoneSchema = z.object({
  label: PhoneLabel.default("mobile"),
  value: z.string(),
});

export const EmailSchema = z.object({
  label: EmailLabel.default("work"),
  value: z.string(),
});

export const UrlSchema = z.object({
  label: UrlLabel.default("homepage"),
  value: z.string(),
});

export const AddressSchema = z.object({
  label: AddressLabel.default("home"),
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().optional(),
  formatted: z.string().optional().describe("Single freeform string; used as street if street/etc not provided"),
});

// Full contact field set used by create_contact / update_contact
export const ContactFieldsSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  nickname: z.string().optional(),
  organization: z.string().optional(),
  department: z.string().optional(),
  job_title: z.string().optional(),
  phones: jsonOrArray(PhoneSchema).optional().describe("Replaces all existing phones when provided. Accepts array or JSON-stringified array."),
  emails: jsonOrArray(EmailSchema).optional().describe("Replaces all existing emails when provided. Accepts array or JSON-stringified array."),
  addresses: jsonOrArray(AddressSchema).optional().describe("Replaces all existing addresses when provided. Accepts array or JSON-stringified array."),
  urls: jsonOrArray(UrlSchema).optional().describe("Replaces all existing urls when provided. Accepts array or JSON-stringified array."),
  birthday: z.string().optional().describe("ISO date YYYY-MM-DD or MM-DD"),
  photo: z.string().optional().describe("Base64-encoded image, or absolute file path starting with /"),
  note: z.string().optional().describe("Free-form notes; newlines are preserved"),

  // ---- Deprecated single-value back-compat fields ----
  email: z.string().optional().describe("DEPRECATED: append a single email (use emails[] instead)"),
  phone: z.string().optional().describe("DEPRECATED: append a single phone (use phones[] instead)"),
});

export type ContactFields = z.infer<typeof ContactFieldsSchema>;
export type Phone = z.infer<typeof PhoneSchema>;
export type Email = z.infer<typeof EmailSchema>;
export type Address = z.infer<typeof AddressSchema>;
export type Url = z.infer<typeof UrlSchema>;

// Output of get_contact
export interface ContactRecord {
  id: string;
  name: string;
  prefix: string | null;
  first_name: string | null;
  last_name: string | null;
  suffix: string | null;
  nickname: string | null;
  organization: string | null;
  department: string | null;
  job_title: string | null;
  phones: Phone[];
  emails: Email[];
  addresses: Address[];
  urls: Url[];
  birthday: string | null;
  note: string | null;
  has_photo: boolean;
  modification_date: string | null;
}

// Output of list_contacts (lightweight)
export interface ContactSummary {
  id: string;
  name: string;
  organization: string | null;
  primary_phone: string | null;
  primary_email: string | null;
  modification_date: string | null;
}

// Summary mode enum for list_contacts (since 0.5.0).
// - false/"full": all summary fields (id, name, org, phone, email, modification_date)
// - true: same as "full" (back-compat alias)
// - "minimal": id + name + modification_date only (~50B/item)
export type SummaryMode = boolean | "full" | "minimal";

// Output of list_contacts (paginated wrapper, since 0.2.0)
export interface ListContactsResult {
  items: ContactSummary[];
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
}

// ---- Batch schemas (since 0.3.0) ----

// Input entry for batch_create_contacts. Same fields as create_contact.
// ContactFieldsSchema already has optional first_name/last_name so we
// just reuse it directly.
export const BatchCreateEntrySchema = ContactFieldsSchema;
export type BatchCreateEntry = z.infer<typeof BatchCreateEntrySchema>;

// Input entry for batch_update_contacts. contact_id (or id) is required;
// name-based matching is not allowed in batch for safety.
export const BatchUpdateEntrySchema = ContactFieldsSchema.extend({
  contact_id: z.string().optional().describe("Apple Contacts person id (preferred). Alias for `id`."),
  id: z.string().optional().describe("Same as contact_id (back-compat)."),
});
export type BatchUpdateEntry = z.infer<typeof BatchUpdateEntrySchema>;

// Per-item result
export interface BatchItemResult {
  index: number;
  status: "ok" | "error";
  id?: string;
  name?: string;
  group_added?: string;
  group_warning?: string;
  updated_fields?: string[];
  error?: string;
}

// Batch response
export interface BatchResult {
  total: number;
  succeeded: number;
  failed: number;
  results: BatchItemResult[];
}

// ---- Batch get schemas (since 0.4.0) ----

export interface BatchGetItemResult {
  index: number;
  status: "ok" | "error";
  contact_id: string;
  contact?: ContactRecord;
  error?: string;
}

export interface BatchGetResult {
  total: number;
  succeeded: number;
  failed: number;
  results: BatchGetItemResult[];
}
