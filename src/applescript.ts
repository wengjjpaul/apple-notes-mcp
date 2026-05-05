import { spawn } from "node:child_process";

export class AppleScriptError extends Error {
  constructor(message: string, public readonly stderr?: string) {
    super(message);
    this.name = "AppleScriptError";
  }
}

/**
 * Run an AppleScript via `osascript`.
 *
 * The script is passed via stdin (avoids quoting/escaping concerns).
 * Returns stdout, trimmed of a single trailing newline.
 */
export function runAppleScript(script: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-"], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new AppleScriptError(`AppleScript timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new AppleScriptError(err.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new AppleScriptError(`osascript exited with code ${code}: ${stderr.trim()}`, stderr));
        return;
      }
      resolve(stdout.replace(/\n$/, ""));
    });

    child.stdin.write(script);
    child.stdin.end();
  });
}

/**
 * Escape a string for safe interpolation inside an AppleScript double-quoted string literal.
 *
 * Security notes:
 * - Null bytes (0x00) are stripped: they can terminate stdin reads on some systems
 *   and would silently truncate the script sent to osascript.
 * - Other non-printable C0 control characters (0x01–0x08, 0x0B, 0x0C, 0x0E–0x1F) are
 *   stripped: they have no meaningful representation in AppleScript string literals.
 * - Backslash and double-quote are escaped as \\ and \".
 * - Newlines (\n, \r) and tab (\t) are kept as literal characters — they are valid
 *   inside AppleScript string literals when the script is passed via stdin, and
 *   replacing them with \n / \r would silently corrupt note content (AppleScript
 *   does not support those escape sequences).
 */
export function asString(value: string): string {
  const safe = value
    .replace(/\x00/g, "")                           // null byte → strip
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g, "")  // other non-printable C0 controls → strip
    .replace(/\\/g, "\\\\")                          // backslash → \\
    .replace(/"/g, '\\"');                            // double-quote → \"
  return `"${safe}"`;
}

/**
 * Parse a JSON string emitted by AppleScript. We invoke osascript without
 * `-ss`, so strings come back as plain text and can be JSON.parse'd directly.
 */
export function parseAppleScriptJson<T = unknown>(raw: string): T {
  return JSON.parse(raw.trim()) as T;
}
