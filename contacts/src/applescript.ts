import { execFile } from "node:child_process";

// Run an AppleScript via osascript and return stdout (trimmed of trailing newline).
export function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-e", script],
      { maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`AppleScript error: ${stderr || error.message}`));
          return;
        }
        resolve(stdout.replace(/\n$/, ""));
      }
    );
  });
}

// Quote a JS string into an AppleScript expression that yields the same string.
//
// Handles:
//  - backslashes / double-quotes inside the string
//  - real newlines (split & joined with `& linefeed &`) — fixes upstream bug
//    where note newlines became literal "\n" characters
//  - empty string → `""`
//
// The result is a complete AppleScript expression (e.g. `"foo" & linefeed & "bar"`),
// safe to drop into property lists or `set` statements.
export function appleScriptString(input: string): string {
  if (input === "") return `""`;
  // Normalize line endings
  const normalized = input.replace(/\r\n?/g, "\n");
  const parts = normalized.split("\n").map(escapeOneLine);
  return parts.join(" & linefeed & ");
}

function escapeOneLine(line: string): string {
  return `"${line.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Common delimiters used to marshal AppleScript output back to TypeScript.
export const F = "|||";       // field
export const R = "<<<REC>>>"; // record
export const S = "<<<SUB>>>"; // sub-record (e.g. one phone)
export const KV = "==";       // key=value within a sub-record
