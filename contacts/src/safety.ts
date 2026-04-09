// Group restriction enforcement.
//
// If env var ALLOWED_GROUPS is unset → no restriction (back-compat).
// If set (comma-separated) → all reads/writes must be scoped to those groups.
//
// Recommended setting for the business-network-management workflow:
//   ALLOWED_GROUPS=Contacts

const raw = process.env.ALLOWED_GROUPS;
const parsed: string[] | null =
  raw === undefined || raw.trim() === ""
    ? null
    : raw.split(",").map((s) => s.trim()).filter(Boolean);

export function isRestricted(): boolean {
  return parsed !== null;
}

export function allowedGroups(): string[] {
  return parsed ?? [];
}

export function defaultGroup(): string | null {
  return parsed && parsed.length > 0 ? parsed[0]! : null;
}

export function assertGroupAllowed(name: string): void {
  if (!isRestricted()) return;
  if (!parsed!.includes(name)) {
    throw new Error(
      `Group "${name}" is not in ALLOWED_GROUPS (${parsed!.join(", ")}). Refusing.`
    );
  }
}

export function assertGroupProvided(name: string | undefined): asserts name is string {
  if (isRestricted() && !name) {
    throw new Error(
      `ALLOWED_GROUPS is set; you must specify a group explicitly. Allowed: ${parsed!.join(", ")}`
    );
  }
  if (name) assertGroupAllowed(name);
}
