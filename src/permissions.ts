export const ALL_TOOLS = [
  "list_accounts",
  "list_folders",
  "list_notes",
  "search_notes",
  "get_note",
  "create_note",
  "append_to_note",
  "update_note",
  "create_folder",
  "delete_note",
  "delete_folder",
] as const;

export type ToolName = (typeof ALL_TOOLS)[number];

export const READ_TOOLS: ToolName[] = ["list_accounts", "list_folders", "list_notes", "search_notes", "get_note"];
export const WRITE_TOOLS: ToolName[] = ["create_note", "append_to_note", "update_note", "create_folder"];
export const DESTRUCTIVE_TOOLS: ToolName[] = ["delete_note", "delete_folder"];

const READ_FOLDER_TOOLS = new Set<ToolName>(["list_notes", "search_notes", "get_note"]);
const WRITE_FOLDER_TOOLS = new Set<ToolName>(["create_note", "append_to_note", "update_note", "create_folder", "delete_note", "delete_folder"]);

/**
 * A write-folder entry, optionally scoped to a specific Notes account.
 * Parsed from `--write-folder=Google/HTX-IMAP` or `--write-folder=HTX-MCP`.
 */
export interface WriteFolderEntry {
  folder: string;
  account?: string; // e.g. "Google", "iCloud", "Exchange"
}

/**
 * Folder-scoped permissions. An empty list means "no restriction".
 */
export interface FolderPermissions {
  readFolders: string[]; // empty → all folders allowed for reads
  writeFolders: string[]; // folder names only — used for fast permission checks
  writeFolderEntries: WriteFolderEntry[]; // full entries including optional account
}

/**
 * Returns the account associated with a write-folder entry, if any.
 */
export function getAccountForFolder(folderName: string, perms: FolderPermissions): string | undefined {
  return perms.writeFolderEntries.find((e) => e.folder === folderName)?.account;
}

export interface PermissionContext {
  tools: Set<ToolName>;
  folders: FolderPermissions;
}

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

/**
 * Validates a folder argument against folder permissions for a given tool.
 * Throws PermissionDeniedError when not allowed.
 *
 * Returns the effective list of folders the operation should consider:
 *   - If `folder` is provided: returns [folder] (already validated against allow-list).
 *   - If `folder` is omitted and a restriction exists: returns the allow-list.
 *   - If `folder` is omitted and no restriction: returns [] (caller treats as "all").
 */
export function resolveFolders(
  tool: ToolName,
  folder: string | undefined,
  perms: FolderPermissions,
): string[] {
  const isWrite = WRITE_FOLDER_TOOLS.has(tool);
  const isRead = READ_FOLDER_TOOLS.has(tool);
  const allowList = isWrite ? perms.writeFolders : isRead ? perms.readFolders : [];

  if (folder !== undefined) {
    if (allowList.length > 0 && !allowList.includes(folder)) {
      throw new PermissionDeniedError(
        `Folder "${folder}" is not in the allowed ${isWrite ? "--write-folder" : "--read-folder"} list (${allowList.join(", ")}).`,
      );
    }
    return [folder];
  }

  // No folder argument provided.
  if (allowList.length === 0) return []; // unrestricted
  if (isWrite) {
    // Writes need a concrete target. If exactly one folder is allowed we can
    // default to it; otherwise force the caller to choose.
    if (allowList.length === 1) return [allowList[0]!];
    throw new PermissionDeniedError(
      `Tool "${tool}" requires a folder argument. Allowed folders: ${allowList.join(", ")}.`,
    );
  }
  return [...allowList];
}

/**
 * Validate a folder name being passed to create_folder against the
 * --write-folder allow-list (if any).
 * When `parent` is provided, the check is against the parent name instead —
 * subfolders are allowed as long as their parent is in the allow-list.
 */
export function assertCanCreateFolder(folderName: string, perms: FolderPermissions, parent?: string): void {
  if (perms.writeFolders.length > 0) {
    const check = parent ?? folderName;
    if (!perms.writeFolders.includes(check)) {
      throw new PermissionDeniedError(
        `create_folder is restricted to: ${perms.writeFolders.join(", ")}. Got "${check}".`,
      );
    }
  }
}

/**
 * Parse `--allow` values into a set of enabled tools.
 *
 * Accepts:
 *   - "all"          → every tool
 *   - "read"         → read-only tools
 *   - "write"        → read + non-destructive writes
 *   - "destructive"  → destructive ops (delete_note)
 *   - any individual tool name from ALL_TOOLS
 *   - comma-separated combinations of any of the above
 *
 * Multiple `--allow` flags are merged.
 */
export function parseAllowList(values: string[]): Set<ToolName> {
  const allowed = new Set<ToolName>();
  if (values.length === 0) return allowed;

  const tokens = values.flatMap((v) => v.split(",")).map((t) => t.trim()).filter(Boolean);

  for (const token of tokens) {
    switch (token) {
      case "all":
        ALL_TOOLS.forEach((t) => allowed.add(t));
        break;
      case "read":
        READ_TOOLS.forEach((t) => allowed.add(t));
        break;
      case "write":
        READ_TOOLS.forEach((t) => allowed.add(t));
        WRITE_TOOLS.forEach((t) => allowed.add(t));
        break;
      case "destructive":
        DESTRUCTIVE_TOOLS.forEach((t) => allowed.add(t));
        break;
      default:
        if ((ALL_TOOLS as readonly string[]).includes(token)) {
          allowed.add(token as ToolName);
        } else {
          throw new Error(
            `Unknown tool/group in --allow: "${token}". Valid: all, read, write, destructive, ${ALL_TOOLS.join(", ")}`,
          );
        }
    }
  }
  return allowed;
}
