import { z } from "zod";

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
  phones: z.array(PhoneSchema).optional().describe("Replaces all existing phones when provided"),
  emails: z.array(EmailSchema).optional().describe("Replaces all existing emails when provided"),
  addresses: z.array(AddressSchema).optional().describe("Replaces all existing addresses when provided"),
  urls: z.array(UrlSchema).optional().describe("Replaces all existing urls when provided"),
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
}

// Output of list_contacts (lightweight)
export interface ContactSummary {
  id: string;
  name: string;
  organization: string | null;
  primary_phone: string | null;
  primary_email: string | null;
}
