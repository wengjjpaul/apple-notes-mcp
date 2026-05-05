import { z } from "zod";
import { asString, parseAppleScriptJson, runAppleScript } from "./applescript.js";
import {
  assertCanCreateFolder,
  getAccountForFolder,
  PermissionDeniedError,
  resolveFolders,
  type PermissionContext,
  type ToolName,
} from "./permissions.js";

export interface ToolDef {
  name: ToolName;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (args: any, ctx: PermissionContext) => Promise<string>;
}

// ---------------------------------------------------------------------------
// AppleScript helpers
// ---------------------------------------------------------------------------

/** Wraps a list of AppleScript record-building expressions into a JSON array. */
const AS_JSON_HELPERS = `
on jsonEscape(s)
  set s to s as text
  set out to ""
  repeat with i from 1 to count of characters of s
    set c to character i of s
    try
      set n to id of c
    on error
      -- Multi-codepoint grapheme clusters can fail; fall back to raw chars.
      set out to out & c
      -- skip the rest of this iteration
      set n to -1
    end try
    if n is -1 then
      -- already appended above
    else if (class of n) is list then
      -- Combined character (e.g. emoji ZWJ sequence). Emit each codepoint.
      repeat with cp in n
        set cn to cp as integer
        if cn ≥ 32 and cn is not 34 and cn is not 92 then
          -- Safe printable codepoint; emit by re-deriving the character.
          set out to out & (character id cn)
        else if cn is 34 then
          set out to out & "\\\\\\""
        else if cn is 92 then
          set out to out & "\\\\\\\\"
        else if cn is 10 then
          set out to out & "\\\\n"
        else if cn is 13 then
          set out to out & "\\\\r"
        else if cn is 9 then
          set out to out & "\\\\t"
        else if cn is 8 then
          set out to out & "\\\\b"
        else if cn is 12 then
          set out to out & "\\\\f"
        else
          set out to out & (character id cn)
        end if
      end repeat
    else if n is 92 then
      set out to out & "\\\\\\\\"
    else if n is 34 then
      set out to out & "\\\\\\""
    else if n is 10 then
      set out to out & "\\\\n"
    else if n is 13 then
      set out to out & "\\\\r"
    else if n is 9 then
      set out to out & "\\\\t"
    else if n is 8 then
      set out to out & "\\\\b"
    else if n is 12 then
      set out to out & "\\\\f"
    else if n < 32 then
      set hex to "0123456789abcdef"
      set hi to character (((n div 16) mod 16) + 1) of hex
      set lo to character ((n mod 16) + 1) of hex
      set out to out & "\\\\u00" & hi & lo
    else
      set out to out & c
    end if
  end repeat
  return out
end jsonEscape

on topFolderName(f)
  -- Walks up the container chain; returns the name of the top-level folder
  -- (the one whose container is an account, not another folder).
  tell application "Notes"
    set cur to contents of f
    repeat
      try
        set c to container of cur
      on error
        return name of cur
      end try
      if (class of c) is folder then
        set cur to contents of c
      else
        return name of cur
      end if
    end repeat
  end tell
end topFolderName
`;

/** Build an AppleScript list literal of strings from a JS string[]. */
function asStringList(items: string[]): string {
  if (items.length === 0) return "{}";
  return "{" + items.map((s) => asString(s)).join(", ") + "}";
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** AppleScript snippet that ensures a top-level folder exists; no-op if it does. */
function ensureFolderScript(folderName: string, account?: string): string {
  if (account) {
    return `set _acct to account ${asString(account)}
if not (exists folder ${asString(folderName)} of _acct) then
  make new folder with properties {name:${asString(folderName)}} at _acct
end if`;
  }
  return `if not (exists folder ${asString(folderName)}) then
  make new folder with properties {name:${asString(folderName)}}
end if`;
}

/** Build a JSON-emitting script that produces a list of note records from a given AppleScript expression. */
function notesListScript(notesExpr: string, max: number): string {
  return `${AS_JSON_HELPERS}
tell application "Notes"
  set ns to ${notesExpr}
  set out to "["
  set count_so_far to 0
  set first_one to true
  repeat with n in ns
    if count_so_far ≥ ${max} then exit repeat
    if first_one then
      set first_one to false
    else
      set out to out & ","
    end if
    set out to out & "{\\"id\\":\\"" & (id of n) & "\\",\\"name\\":\\"" & my jsonEscape(name of n) & "\\",\\"modified\\":\\"" & ((modification date of n) as «class isot» as string) & "\\"}"
    set count_so_far to count_so_far + 1
  end repeat
  set out to out & "]"
  return out
end tell`;
}

/**
 * Builds a script that iterates every folder in Notes and emits notes for the
 * folders whose name OR top-level-ancestor name appears in `allowed`. If
 * `allowed` is empty, every note is emitted (no folder filter). When
 * `restrictTops` is non-empty, the folder's top-level ancestor must ALSO be in
 * that list (used to intersect a folder argument with the read allow-list).
 *
 * Also enumerates IMAP subfolders (e.g. Google account nested folders) via
 * bulk property access, since they are not returned by `every folder`.
 */
function notesListScopedScript(allowed: string[], max: number, restrictTops: string[] = []): string {
  const allowedList = asStringList(allowed);
  const restrictList = asStringList(restrictTops);
  const allFolders = allowed.length === 0;
  const allRestrict = restrictTops.length === 0;
  const folderInScope = allFolders
    ? "true"
    : `(fname is in scopedAllowed) or (ftop is in scopedAllowed)`;
  const subfolderInScope = allFolders
    ? "true"
    : `(ftop is in scopedAllowed) or (sname is in scopedAllowed)`;
  const restrictCheck = allRestrict ? "true" : `(ftop is in restrictTops)`;
  return `${AS_JSON_HELPERS}
tell application "Notes"
  set all_direct_ids to id of every folder
  set scopedAllowed to ${allowedList}
  set restrictTops to ${restrictList}
  set out to "["
  set count_so_far to 0
  set first_one to true
  repeat with f in (every folder)
    if count_so_far ≥ ${max} then exit repeat
    try
      set fname to name of f
      set ftop to my topFolderName(f)
      if (${restrictCheck}) then
        -- Notes directly in this folder
        if (${folderInScope}) then
          repeat with n in (notes of f)
            if count_so_far ≥ ${max} then exit repeat
            if first_one then
              set first_one to false
            else
              set out to out & ","
            end if
            set out to out & "{\\"id\\":\\"" & (id of n) & "\\",\\"name\\":\\"" & my jsonEscape(name of n) & "\\",\\"folder\\":\\"" & my jsonEscape(fname) & "\\",\\"modified\\":\\"" & ((modification date of n) as «class isot» as string) & "\\"}"
            set count_so_far to count_so_far + 1
          end repeat
        end if
        -- IMAP subfolders (bulk property access only works at this level).
        -- Skip subfolders that are already accessible via every folder to avoid duplicates.
        if ftop is fname then
          try
            set sub_names to name of every folder of f
            set sub_folder_ids to id of every folder of f
            repeat with j from 1 to count of sub_names
              if count_so_far ≥ ${max} then exit repeat
              set sname to item j of sub_names
              set sfid to item j of sub_folder_ids
              if sfid is not in all_direct_ids then
                if (${subfolderInScope}) then
                  -- Use bulk property access; individual note access fails for IMAP notes
                  set snote_ids to id of every note of folder sname of folder fname
                  set snote_names to name of every note of folder sname of folder fname
                  set snote_dates to modification date of every note of folder sname of folder fname
                  repeat with k from 1 to count of snote_names
                    if count_so_far ≥ ${max} then exit repeat
                    if first_one then
                      set first_one to false
                    else
                      set out to out & ","
                    end if
                    set out to out & "{\\"id\\":\\"" & (item k of snote_ids) & "\\",\\"name\\":\\"" & my jsonEscape(item k of snote_names) & "\\",\\"folder\\":\\"" & my jsonEscape(sname) & "\\",\\"parent\\":\\"" & my jsonEscape(fname) & "\\",\\"modified\\":\\"" & ((item k of snote_dates) as «class isot» as string) & "\\"}"
                    set count_so_far to count_so_far + 1
                  end repeat
                end if
              end if
            end repeat
          end try
        end if
      end if
    end try
  end repeat
  set out to out & "]"
  return out
end tell`;
}

// ---------------------------------------------------------------------------
// list_folders
// ---------------------------------------------------------------------------

const listFolders: ToolDef = {
  name: "list_folders",
  description:
    "List Apple Notes folders, including subfolders. Use the optional `parent` parameter to list only subfolders of a specific folder. If --read-folder restrictions are set, only those folders are returned.",
  inputSchema: z.object({
    parent: z.string().optional().describe("Return only subfolders of this parent folder name."),
  }),
  handler: async ({ parent }: { parent?: string }, ctx) => {
    // Emit id, name, top-level ancestor, and immediate parent for each folder.
    // Also enumerate IMAP subfolders which don't appear in `every folder`.
    const script = `${AS_JSON_HELPERS}
tell application "Notes"
  set out to "["
  set fs to every folder
  set first_one to true
  repeat with f in fs
    try
      set fid to (id of f)
      set fname to name of f
      set ftop to my topFolderName(f)
      set fparent to ""
      try
        set pc to container of f
        if (class of pc) is folder then
          set fparent to name of pc
        end if
      end try
      if first_one then
        set first_one to false
      else
        set out to out & ","
      end if
      set out to out & "{\\"id\\":\\"" & fid & "\\",\\"name\\":\\"" & my jsonEscape(fname) & "\\",\\"top\\":\\"" & my jsonEscape(ftop) & "\\",\\"parent\\":\\"" & my jsonEscape(fparent) & "\\"}"
      -- Enumerate IMAP subfolders (only accessible via bulk property access)
      if ftop is fname then
        try
          set sub_ids to id of every folder of f
          set sub_names to name of every folder of f
          repeat with j from 1 to count of sub_names
            set sname to item j of sub_names
            set sid to item j of sub_ids
            set out to out & ",{\\"id\\":\\"" & sid & "\\",\\"name\\":\\"" & my jsonEscape(sname) & "\\",\\"top\\":\\"" & my jsonEscape(ftop) & "\\",\\"parent\\":\\"" & my jsonEscape(fname) & "\\"}"
          end repeat
        end try
      end if
    end try
  end repeat
  set out to out & "]"
  return out
end tell`;
    const raw = await runAppleScript(script);
    // Deduplicate by id (iCloud subfolders may appear both in every folder and via parent enumeration)
    const seen = new Set<string>();
    let folders = parseAppleScriptJson<{ id: string; name: string; top: string; parent: string }[]>(raw)
      .filter((f) => {
        if (seen.has(f.id)) return false;
        seen.add(f.id);
        return true;
      });

    // Apply --read-folder restriction: only keep folders whose top-level ancestor is allowed.
    if (ctx.folders.readFolders.length > 0) {
      const allowed = new Set(ctx.folders.readFolders);
      folders = folders.filter((f) => allowed.has(f.top));
    }

    // Apply optional parent filter: only return subfolders of the given parent.
    if (parent !== undefined) {
      folders = folders.filter((f) => f.parent === parent);
    }

    return JSON.stringify(
      folders.map(({ id, name, top, parent: p }) => {
        const record: Record<string, string> = { id, name };
        if (p) record.parent = p;
        if (top !== name) record.top = top;
        return record;
      }),
      null,
      2,
    );
  },
};

// ---------------------------------------------------------------------------
// list_notes
// ---------------------------------------------------------------------------

const listNotes: ToolDef = {
  name: "list_notes",
  description:
    "List notes, optionally filtered by folder. If --read-folder restrictions are set, the folder argument (if provided) must be in that list; otherwise listing is scoped to allowed folders.",
  inputSchema: z.object({
    folder: z.string().optional().describe("Folder name to filter by."),
    limit: z.number().int().positive().max(500).optional().describe("Max number of notes to return (default 50)."),
  }),
  handler: async ({ folder, limit }: { folder?: string; limit?: number }, ctx) => {
    const max = limit ?? 50;

    // Determine scope: explicit folder arg always wins (validated against
    // allow-list when restrictions exist). Otherwise use the read allow-list.
    let scope: string[];
    if (folder !== undefined) {
      if (ctx.folders.readFolders.length > 0 && !ctx.folders.readFolders.includes(folder)) {
        const ok = await isFolderUnderAllowedTop(folder, ctx.folders.readFolders);
        if (!ok) {
          throw new PermissionDeniedError(
            `Folder "${folder}" is not in the allowed --read-folder list (${ctx.folders.readFolders.join(", ")}) and is not a subfolder of any allowed top-level folder.`,
          );
        }
      } else if (ctx.folders.readFolders.length === 0) {
        if (!(await folderExists(folder))) {
          throw new Error(`Folder "${folder}" not found.`);
        }
      }
      scope = [folder];
    } else {
      scope = ctx.folders.readFolders; // [] means all
    }

    const raw = await runAppleScript(notesListScopedScript(scope, max, ctx.folders.readFolders));
    return JSON.stringify(parseAppleScriptJson(raw), null, 2);
  },
};

// ---------------------------------------------------------------------------
// search_notes
// ---------------------------------------------------------------------------

function searchScript(query: string, folderExpr: string | null, max: number): string {
  const q = asString(query);
  const matchesExpr = folderExpr
    ? `(notes of ${folderExpr} whose name contains q or body contains q)`
    : `(every note whose name contains q or body contains q)`;
  return `${AS_JSON_HELPERS}
tell application "Notes"
  set q to ${q}
  set matches to ${matchesExpr}
  set out to "["
  set count_so_far to 0
  set first_one to true
  repeat with n in matches
    if count_so_far ≥ ${max} then exit repeat
    if first_one then
      set first_one to false
    else
      set out to out & ","
    end if
    set body_text to plaintext of n
    if (length of body_text) > 200 then
      set snippet to text 1 thru 200 of body_text
    else
      set snippet to body_text
    end if
    set out to out & "{\\"id\\":\\"" & (id of n) & "\\",\\"name\\":\\"" & my jsonEscape(name of n) & "\\",\\"snippet\\":\\"" & my jsonEscape(snippet) & "\\"}"
    set count_so_far to count_so_far + 1
  end repeat
  set out to out & "]"
  return out
end tell`;
}

/**
 * Recursive search across folders whose name OR top-level-ancestor name is in
 * `allowed`. If `allowed` is empty, searches every note. When `restrictTops`
 * is non-empty, the folder's top-level ancestor must ALSO be in that list.
 *
 * Also searches IMAP subfolders via bulk property access.
 */
function searchScopedScript(query: string, allowed: string[], max: number, restrictTops: string[] = []): string {
  const q = asString(query);
  const allowedList = asStringList(allowed);
  const restrictList = asStringList(restrictTops);
  const allFolders = allowed.length === 0;
  const allRestrict = restrictTops.length === 0;
  const folderInScope = allFolders
    ? "true"
    : `(fname is in scopedAllowed) or (ftop is in scopedAllowed)`;
  const subfolderInScope = allFolders
    ? "true"
    : `(ftop is in scopedAllowed) or (sname is in scopedAllowed)`;
  const restrictCheck = allRestrict ? "true" : `(ftop is in restrictTops)`;
  return `${AS_JSON_HELPERS}
tell application "Notes"
  set all_direct_ids to id of every folder
  set q to ${q}
  set scopedAllowed to ${allowedList}
  set restrictTops to ${restrictList}
  set out to "["
  set count_so_far to 0
  set first_one to true
  repeat with f in (every folder)
    if count_so_far ≥ ${max} then exit repeat
    try
      set fname to name of f
      set ftop to my topFolderName(f)
      if (${restrictCheck}) then
        -- Search directly in this folder
        if (${folderInScope}) then
          set matches to (notes of f whose name contains q or body contains q)
          repeat with n in matches
            if count_so_far ≥ ${max} then exit repeat
            if first_one then
              set first_one to false
            else
              set out to out & ","
            end if
            set body_text to plaintext of n
            if (length of body_text) > 200 then
              set snippet to text 1 thru 200 of body_text
            else
              set snippet to body_text
            end if
            set out to out & "{\\"id\\":\\"" & (id of n) & "\\",\\"name\\":\\"" & my jsonEscape(name of n) & "\\",\\"folder\\":\\"" & my jsonEscape(fname) & "\\",\\"snippet\\":\\"" & my jsonEscape(snippet) & "\\"}"
            set count_so_far to count_so_far + 1
          end repeat
        end if
        -- IMAP subfolders (bulk property access).
        -- Skip subfolders already accessible via every folder to avoid duplicates.
        if ftop is fname then
          try
            set sub_names to name of every folder of f
            set sub_folder_ids to id of every folder of f
            repeat with j from 1 to count of sub_names
              if count_so_far ≥ ${max} then exit repeat
              set sname to item j of sub_names
              set sfid to item j of sub_folder_ids
              if sfid is not in all_direct_ids then
                if (${subfolderInScope}) then
                  -- Use bulk property access; individual note access fails for IMAP notes
                  set snote_names to name of every note of folder sname of folder fname
                  set snote_ids to id of every note of folder sname of folder fname
                  set snote_plains to plaintext of every note of folder sname of folder fname
                  repeat with k from 1 to count of snote_names
                    if count_so_far ≥ ${max} then exit repeat
                    set nname to item k of snote_names
                    set nbody to item k of snote_plains
                    if (nname contains q) or (nbody contains q) then
                      if first_one then
                        set first_one to false
                      else
                        set out to out & ","
                      end if
                      set body_text to nbody
                      if (length of body_text) > 200 then
                        set snippet to text 1 thru 200 of body_text
                      else
                        set snippet to body_text
                      end if
                      set out to out & "{\\"id\\":\\"" & (item k of snote_ids) & "\\",\\"name\\":\\"" & my jsonEscape(nname) & "\\",\\"folder\\":\\"" & my jsonEscape(sname) & "\\",\\"parent\\":\\"" & my jsonEscape(fname) & "\\",\\"snippet\\":\\"" & my jsonEscape(snippet) & "\\"}"
                      set count_so_far to count_so_far + 1
                    end if
                  end repeat
                end if
              end if
            end repeat
          end try
        end if
      end if
    end try
  end repeat
  set out to out & "]"
  return out
end tell`;
}

/**
 * Returns true iff a folder named `folder` exists whose top-level ancestor's
 * name is in `allowedTops`. Used to permit explicit sub-folder targeting.
 * Also checks IMAP subfolders (via bulk name access) which don't appear in `every folder`.
 */
async function isFolderUnderAllowedTop(folder: string, allowedTops: string[]): Promise<boolean> {
  if (allowedTops.length === 0) return true;
  if (allowedTops.includes(folder)) return true;
  const allowedList = asStringList(allowedTops);
  const script = `${AS_JSON_HELPERS}
tell application "Notes"
  set scopedAllowed to ${allowedList}
  set target_name to ${asString(folder)}
  -- Check folders that appear in every folder (top-level + iCloud subfolders)
  repeat with f in (every folder)
    if name of f is target_name then
      if my topFolderName(f) is in scopedAllowed then
        return "1"
      end if
    end if
  end repeat
  -- Check IMAP subfolders via bulk name access
  repeat with f in (every folder)
    try
      set ftop to my topFolderName(f)
      if ftop is (name of f) then
        set sub_names to name of every folder of f
        if target_name is in sub_names then
          if ftop is in scopedAllowed then
            return "1"
          end if
        end if
      end if
    end try
  end repeat
  return "0"
end tell`;
  const raw = await runAppleScript(script);
  return raw.trim().replace(/^"|"$/g, "") === "1";
}

/**
 * Returns the Notes account name that owns the given folder (by folder name).
 * Checks top-level folders and IMAP subfolders. Returns empty string if not found.
 */
async function getFolderAccount(folderName: string): Promise<string> {
  const script = `tell application "Notes"
  set target_name to ${asString(folderName)}
  repeat with a in accounts
    -- Check top-level folders in this account
    try
      set top_names to name of every folder of a
      if target_name is in top_names then
        return (name of a) as text
      end if
    end try
    -- Check IMAP subfolders one level deep
    try
      repeat with f in (every folder of a)
        set sub_names to name of every folder of f
        if target_name is in sub_names then
          return (name of a) as text
        end if
      end repeat
    end try
  end repeat
  return ""
end tell`;
  const raw = await runAppleScript(script);
  return raw.trim().replace(/^"|"$/g, "");
}

/**
 * If the writeFolderEntries list has an account constraint for `folderName`,
 * verifies that the folder actually lives in that account. Throws if it doesn't.
 */
async function assertFolderAccountAllowed(folderName: string, perms: import("./permissions.js").FolderPermissions): Promise<void> {
  const entry = perms.writeFolderEntries.find((e) => e.folder === folderName);
  if (!entry?.account) return; // no account constraint
  const actual = await getFolderAccount(folderName);
  if (actual && actual.toLowerCase() !== entry.account.toLowerCase()) {
    throw new PermissionDeniedError(
      `Folder "${folderName}" exists in account "${actual}", but --write-folder requires account "${entry.account}".`,
    );
  }
}

/** Returns true iff at least one folder with name `folder` exists (including IMAP subfolders). */
async function folderExists(folder: string): Promise<boolean> {
  const script = `tell application "Notes"
  set target_name to ${asString(folder)}
  if (exists folder target_name) then
    return "1"
  end if
  -- Check all folders by name (covers iCloud subfolders)
  repeat with f in (every folder)
    if name of f is target_name then return "1"
  end repeat
  -- Check IMAP subfolders via bulk name access
  repeat with f in (every folder)
    try
      set ftop to name of f
      set sub_names to name of every folder of f
      if target_name is in sub_names then return "1"
    end try
  end repeat
  return "0"
end tell`;
  const raw = await runAppleScript(script);
  return raw.trim().replace(/^"|"$/g, "") === "1";
}

const searchNotes: ToolDef = {
  name: "search_notes",
  description:
    "Search notes whose name or body contains the query (case-insensitive). When --read-folder restrictions are set, search is scoped to those folders.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Search string."),
    folder: z.string().optional().describe("Restrict search to a single folder."),
    limit: z.number().int().positive().max(200).optional().describe("Max results (default 25)."),
  }),
  handler: async ({ query, folder, limit }: { query: string; folder?: string; limit?: number }, ctx) => {
    const max = limit ?? 25;

    let scope: string[];
    if (folder !== undefined) {
      if (ctx.folders.readFolders.length > 0 && !ctx.folders.readFolders.includes(folder)) {
        const ok = await isFolderUnderAllowedTop(folder, ctx.folders.readFolders);
        if (!ok) {
          throw new PermissionDeniedError(
            `Folder "${folder}" is not in the allowed --read-folder list (${ctx.folders.readFolders.join(", ")}) and is not a subfolder of any allowed top-level folder.`,
          );
        }
      } else if (ctx.folders.readFolders.length === 0) {
        if (!(await folderExists(folder))) {
          throw new Error(`Folder "${folder}" not found.`);
        }
      }
      scope = [folder];
    } else {
      scope = ctx.folders.readFolders;
    }

    const raw = await runAppleScript(searchScopedScript(query, scope, max, ctx.folders.readFolders));
    return JSON.stringify(parseAppleScriptJson(raw), null, 2);
  },
};

// ---------------------------------------------------------------------------
// get_note
// ---------------------------------------------------------------------------

// Field separator (ASCII 29) and record terminator (ASCII 28) — safe delimiters
// for note content since Apple Notes HTML/plaintext never contains these chars.
const NOTE_FS = "\x1d";
const NOTE_RS = "\x1c";

/**
 * Parse the delimited output from note-fetching AppleScripts.
 * Format: id<FS>name<FS>folder<FS>topFolder<FS>plaintext<FS>body<RS>
 * Body is last so it can safely contain any characters — we slice from the 5th delimiter to end.
 */
function parseNoteDelimited(raw: string): { id: string; name: string; folder: string; topFolder: string; body: string; plaintext: string } | null {
  const s = raw.endsWith(NOTE_RS) ? raw.slice(0, -1) : raw.trimEnd();
  if (!s) return null;
  const fields: string[] = [];
  let pos = 0;
  for (let i = 0; i < 5; i++) {
    const next = s.indexOf(NOTE_FS, pos);
    if (next === -1) return null;
    fields.push(s.slice(pos, next));
    pos = next + 1;
  }
  fields.push(s.slice(pos)); // body = everything remaining
  return { id: fields[0], name: fields[1], folder: fields[2], topFolder: fields[3], plaintext: fields[4], body: fields[5] };
}

function getNoteScript(selector: string): string {
  const fs = "(ASCII character 29)";
  const rs = "(ASCII character 28)";
  return `${AS_JSON_HELPERS}
tell application "Notes"
  set FS to ${fs}
  set RS to ${rs}
  set n to ${selector}
  set folder_name to ""
  set top_folder_name to ""
  try
    set f to container of n
    set folder_name to name of f
    set top_folder_name to my topFolderName(f)
  end try
  return (id of n as text) & FS & (name of n as text) & FS & folder_name & FS & top_folder_name & FS & (plaintext of n as text) & FS & (body of n as text) & RS
end tell`;
}

/**
 * Fetch a note from an IMAP subfolder using bulk property access.
 * `parentFolder` is the top-level folder (e.g. "HTX"), `subFolder` is the subfolder (e.g. "Appraisal").
 * Matches by name or id.
 */
function getImapSubfolderNoteScript(parentFolder: string, subFolder: string, noteName: string | null, noteId: string | null): string {
  const parent = asString(parentFolder);
  const sub = asString(subFolder);
  const targetName = noteName ? asString(noteName) : '""';
  const targetId = noteId ? asString(noteId) : '""';
  const fs = "(ASCII character 29)";
  const rs = "(ASCII character 28)";
  return `tell application "Notes"
  set FS to ${fs}
  set RS to ${rs}
  set nnames to name of every note of folder ${sub} of folder ${parent}
  set nids to id of every note of folder ${sub} of folder ${parent}
  set target_name to ${targetName}
  set target_id to ${targetId}
  set match_name to ""
  set match_id to ""
  set match_idx to 0
  repeat with i from 1 to count of nnames
    set nname to item i of nnames
    set nid to item i of nids
    if (target_id is not "" and nid is target_id) or (target_name is not "" and nname is target_name) then
      set match_name to nname
      set match_id to nid
      set match_idx to i
      exit repeat
    end if
  end repeat
  if match_idx is 0 then return ""
  set nplains to plaintext of every note of folder ${sub} of folder ${parent}
  set nbodies to body of every note of folder ${sub} of folder ${parent}
  return (match_id as text) & FS & match_name & FS & ${sub} & FS & ${parent} & FS & (contents of item match_idx of nplains) & FS & (contents of item match_idx of nbodies) & RS
end tell`;
}

function getImapTopFolderNoteScript(folderName: string, noteName: string | null, noteId: string | null): string {
  const fname = asString(folderName);
  const targetName = noteName ? asString(noteName) : '""';
  const targetId = noteId ? asString(noteId) : '""';
  const fs = "(ASCII character 29)";
  const rs = "(ASCII character 28)";
  return `tell application "Notes"
  set FS to ${fs}
  set RS to ${rs}
  set nnames to name of every note of folder ${fname}
  set nids to id of every note of folder ${fname}
  set target_name to ${targetName}
  set target_id to ${targetId}
  set match_name to ""
  set match_id to ""
  set match_idx to 0
  repeat with i from 1 to count of nnames
    set nname to item i of nnames
    set nid to item i of nids
    if (target_id is not "" and nid is target_id) or (target_name is not "" and nname is target_name) then
      set match_name to nname
      set match_id to nid
      set match_idx to i
      exit repeat
    end if
  end repeat
  if match_idx is 0 then return ""
  set nplains to plaintext of every note of folder ${fname}
  set nbodies to body of every note of folder ${fname}
  return (match_id as text) & FS & match_name & FS & ${fname} & FS & ${fname} & FS & (contents of item match_idx of nplains) & FS & (contents of item match_idx of nbodies) & RS
end tell`;
}

const getNote: ToolDef = {
  name: "get_note",
  description:
    "Fetch a note's full content. Provide either note id, or name (and optional folder). When --read-folder restrictions are set, the resulting note must live in an allowed folder.",
  inputSchema: z
    .object({
      id: z.string().optional().describe("The note's AppleScript id."),
      name: z.string().optional().describe("Note name (used if id not provided)."),
      folder: z.string().optional().describe("Folder to scope name lookup."),
    })
    .refine((v) => v.id || v.name, { message: "Provide either id or name." }),
  handler: async ({ id, name, folder }: { id?: string; name?: string; folder?: string }, ctx) => {
    // Validate `folder` (if provided) up-front against read scope.
    if (folder !== undefined) {
      if (ctx.folders.readFolders.length > 0 && !ctx.folders.readFolders.includes(folder)) {
        const ok = await isFolderUnderAllowedTop(folder, ctx.folders.readFolders);
        if (!ok) {
          throw new PermissionDeniedError(
            `Folder "${folder}" is not in the allowed --read-folder list (${ctx.folders.readFolders.join(", ")}) and is not a subfolder of any allowed top-level folder.`,
          );
        }
      }
    }

    const tryFetch = async (selector: string): Promise<{
      id: string;
      name: string;
      folder: string;
      topFolder: string;
      body: string;
      plaintext: string;
    } | null> => {
      try {
        const raw = await runAppleScript(getNoteScript(selector));
        return parseNoteDelimited(raw);
      } catch {
        return null;
      }
    };

    let parsed: { folder: string; topFolder: string } & Record<string, unknown> | null = null;

    /** Try fetching from all IMAP subfolders of all top-level folders, matching by name or id. */
    const tryImapSubfolders = async (noteName: string | null, noteId: string | null, onlyParent?: string): Promise<typeof parsed> => {
      // Get all top-level folders, then for each try bulk subfolder access
      const topFoldersScript = `tell application "Notes"\n  return name of every folder\nend tell`;
      const topNames = (await runAppleScript(topFoldersScript)).split(", ").map((s) => s.trim()).filter(Boolean);
      for (const topName of topNames) {
        if (onlyParent && topName !== onlyParent) continue;
        try {
          const subNamesScript = `tell application "Notes"\n  return name of every folder of folder ${asString(topName)}\nend tell`;
          const subNamesRaw = await runAppleScript(subNamesScript);
          if (!subNamesRaw.trim()) continue;
          const subNames = subNamesRaw.split(", ").map((s) => s.trim()).filter(Boolean);
          for (const subName of subNames) {
            const script = getImapSubfolderNoteScript(topName, subName, noteName, noteId);
            const raw = (await runAppleScript(script)).trim();
            if (raw) return parseNoteDelimited(raw);
          }
        } catch {
          // skip folders that don't support subfolder enumeration
        }
      }
      return null;
    };

    if (id) {
      // Try direct id lookup first; if it fails, scan IMAP subfolders
      parsed = await tryFetch(`note id ${asString(id)}`);
      if (!parsed) {
        parsed = await tryImapSubfolders(null, id);
      }
    } else if (folder) {
      // Try direct folder reference first
      parsed = await tryFetch(`(first note of folder ${asString(folder)} whose name is ${asString(name!)})`);
      if (!parsed) {
        // Try bulk IMAP top-level folder lookup (handles Google/Exchange top-level folders)
        try {
          const raw = (await runAppleScript(getImapTopFolderNoteScript(folder, name!, null))).trim();
          if (raw) parsed = parseNoteDelimited(raw);
        } catch { /* not an IMAP top-level folder, continue */ }
      }
      if (!parsed) {
        // Try exhaustive scan scoped to the named subfolder across all parents
        const topFoldersScript = `tell application "Notes"\n  return name of every folder\nend tell`;
        const topNames = (await runAppleScript(topFoldersScript)).split(", ").map((s) => s.trim()).filter(Boolean);
        for (const topName of topNames) {
          const script = getImapSubfolderNoteScript(topName, folder, name!, null);
          try {
            const raw = (await runAppleScript(script)).trim();
            if (raw) { parsed = parseNoteDelimited(raw); break; }
          } catch { /* skip */ }
        }
      }
    } else {
      // Name only. If read scope set, search across allowed top-levels +
      // their descendants; otherwise global.
      const allowedTops = ctx.folders.readFolders;
      if (allowedTops.length === 0) {
        // Try global lookup first, then scan IMAP subfolders
        parsed = await tryFetch(`(first note whose name is ${asString(name!)})`);
        if (!parsed) {
          parsed = await tryImapSubfolders(name!, null);
        }
      } else {
        // Walk regular allowed folders first
        const allowedList = asStringList(allowedTops);
        const findScript = `${AS_JSON_HELPERS}
tell application "Notes"
  set scopedAllowed to ${allowedList}
  set target_name to ${asString(name!)}
  repeat with f in (every folder)
    if (name of f is in scopedAllowed) or (my topFolderName(f) is in scopedAllowed) then
      set ms to (notes of f whose name is target_name)
      if (count of ms) > 0 then
        set n to item 1 of ms
        set fname to name of f
        set ftop to my topFolderName(f)
        set out to "{\\"id\\":\\"" & (id of n) & "\\",\\"name\\":\\"" & my jsonEscape(name of n) & "\\",\\"folder\\":\\"" & my jsonEscape(fname) & "\\",\\"topFolder\\":\\"" & my jsonEscape(ftop) & "\\",\\"body\\":\\"" & my jsonEscape(body of n) & "\\",\\"plaintext\\":\\"" & my jsonEscape(plaintext of n) & "\\"}"
        return out
      end if
    end if
  end repeat
  return ""
end tell`;
        const raw = (await runAppleScript(findScript)).trim();
        if (raw) parsed = parseAppleScriptJson(raw);
        // Also check IMAP subfolders of each allowed top-level folder
        if (!parsed) {
          for (const topName of allowedTops) {
            parsed = await tryImapSubfolders(name!, null, topName);
            if (parsed) break;
          }
        }
      }
    }

    if (!parsed) {
      throw new Error(`Note not found.`);
    }

    // Final folder check for id-based lookups: top-level ancestor must be in allow-list.
    const allowed = ctx.folders.readFolders;
    if (allowed.length > 0 && !allowed.includes(parsed.topFolder)) {
      throw new PermissionDeniedError(
        `Note belongs to folder "${parsed.folder}" (top-level "${parsed.topFolder}"), which is not in --read-folder allow-list.`,
      );
    }

    return JSON.stringify(parsed, null, 2);
  },
};

// ---------------------------------------------------------------------------
// create_note (auto-creates the target folder if it doesn't exist)
// ---------------------------------------------------------------------------

const createNote: ToolDef = {
  name: "create_note",
  description:
    "Create a new note. `body` may be HTML or plain text. The target folder is auto-created if it doesn't exist. Use `parent` when the target folder is an IMAP subfolder (e.g. folder='HTX-IMAP-Sub', parent='HTX-IMAP'). Required folder argument when --write-folder restrictions are set with multiple allowed folders.",
  inputSchema: z.object({
    name: z.string().min(1).describe("Note title."),
    body: z.string().describe("Note body (HTML or plain text)."),
    folder: z.string().optional().describe("Folder to create the note in. Auto-created if missing."),
    parent: z.string().optional().describe("Parent folder name. Required when folder is an IMAP subfolder."),
  }),
  handler: async ({ name, body, folder, parent }: { name: string; body: string; folder?: string; parent?: string }, ctx) => {
    let target: string | undefined;
    let isExistingSubfolder = false;
    if (folder !== undefined) {
      // Validate against allow-list with sub-folder allowance.
      if (ctx.folders.writeFolders.length > 0 && !ctx.folders.writeFolders.includes(folder)) {
        const ok = await isFolderUnderAllowedTop(folder, ctx.folders.writeFolders);
        if (!ok) {
          throw new PermissionDeniedError(
            `Folder "${folder}" is not in the allowed --write-folder list (${ctx.folders.writeFolders.join(", ")}) and is not a subfolder of any allowed top-level folder.`,
          );
        }
        // Sub-folder of an allowed top — must use existing folder reference.
        isExistingSubfolder = true;
      } else {
        await assertFolderAccountAllowed(folder, ctx.folders);
      }
      target = folder;
    } else {
      const targets = resolveFolders("create_note", undefined, ctx.folders);
      target = targets[0];
    }

    const fullBody = `<h1>${escapeHtml(name)}</h1>${body}`;

    let ensure = "";
    let at = "";
    if (target) {
      if (isExistingSubfolder || parent) {
        // IMAP subfolder: must reference via parent path.
        const resolvedParent = parent ?? target; // fallback shouldn't happen
        if (parent) {
          at = ` at folder ${asString(target)} of folder ${asString(parent)}`;
        } else {
          at = ` at folder ${asString(target)}`;
        }
      } else {
        const account = getAccountForFolder(target, ctx.folders);
        ensure = ensureFolderScript(target, account);
        at = account
          ? ` at folder ${asString(target)} of account ${asString(account)}`
          : ` at folder ${asString(target)}`;
      }
    }
    const script = `tell application "Notes"
  ${ensure}
  set n to make new note${at} with properties {name:${asString(name)}, body:${asString(fullBody)}}
  set nid to ""
  try
    set nid to (id of n) as text
  end try
  return nid
end tell`;
    const raw = await runAppleScript(script);
    const noteId = raw.trim().replace(/^"|"$/g, "");
    return JSON.stringify({ id: noteId, name, folder: target ?? null, parent: parent ?? null }, null, 2);
  },
};

// ---------------------------------------------------------------------------
// append_to_note
// ---------------------------------------------------------------------------

const appendToNote: ToolDef = {
  name: "append_to_note",
  description:
    "Append HTML/text content to an existing note. When --write-folder restrictions are set, the target note must live in an allowed folder.",
  inputSchema: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      folder: z.string().optional(),
      content: z.string().min(1).describe("Content to append (HTML or plain text)."),
    })
    .refine((v) => v.id || v.name, { message: "Provide either id or name." }),
  handler: async (
    { id, name, folder, content }: { id?: string; name?: string; folder?: string; content: string },
    ctx,
  ) => {
    if (folder !== undefined) {
      if (ctx.folders.writeFolders.length > 0 && !ctx.folders.writeFolders.includes(folder)) {
        const ok = await isFolderUnderAllowedTop(folder, ctx.folders.writeFolders);
        if (!ok) {
          throw new PermissionDeniedError(
            `Folder "${folder}" is not in the allowed --write-folder list (${ctx.folders.writeFolders.join(", ")}) and is not a subfolder of any allowed top-level folder.`,
          );
        }
      } else {
        await assertFolderAccountAllowed(folder, ctx.folders);
      }
    }

    let selector: string;
    if (id) {
      selector = `note id ${asString(id)}`;
    } else if (folder) {
      selector = `(first note of folder ${asString(folder)} whose name is ${asString(name!)})`;
    } else {
      const allowedTops = ctx.folders.writeFolders;
      if (allowedTops.length === 0) {
        selector = `(first note whose name is ${asString(name!)})`;
      } else if (allowedTops.length === 1) {
        // Search the entire allowed top + its descendants for the named note.
        const findScript = `${AS_JSON_HELPERS}
tell application "Notes"
  set scopedAllowed to ${asStringList(allowedTops)}
  set target_name to ${asString(name!)}
  set folder_id to ""
  repeat with f in (every folder)
    if (name of f is in scopedAllowed) or (my topFolderName(f) is in scopedAllowed) then
      set ms to (notes of f whose name is target_name)
      if (count of ms) > 0 then
        set folder_id to (id of f) as text
        exit repeat
      end if
    end if
  end repeat
  return folder_id
end tell`;
        const found = (await runAppleScript(findScript)).trim().replace(/^"|"$/g, "");
        if (!found) throw new Error(`Note "${name}" not found in allowed folders.`);
        selector = `(first note of (first folder whose id is ${asString(found)}) whose name is ${asString(name!)})`;
      } else {
        throw new PermissionDeniedError(
          `append_to_note: provide a folder argument. Allowed: ${allowedTops.join(", ")}.`,
        );
      }
    }

    // Validate container's top-level folder against allow-list.
    const allowed = ctx.folders.writeFolders;
    if (allowed.length > 0) {
      const checkScript = `${AS_JSON_HELPERS}
tell application "Notes"
  set n to ${selector}
  set f to container of n
  return my jsonEscape(my topFolderName(f))
end tell`;
      const topName = (await runAppleScript(checkScript)).trim();
      if (!allowed.includes(topName)) {
        throw new PermissionDeniedError(
          `Note's top-level folder "${topName}" is not in --write-folder allow-list.`,
        );
      }
    }

    const script = `tell application "Notes"
  set n to ${selector}
  set body of n to (body of n) & ${asString(content)}
  return (id of n) as text
end tell`;
    const raw = await runAppleScript(script);
    const noteId = raw.trim().replace(/^"|"$/g, "");
    return JSON.stringify({ id: noteId, appended: true }, null, 2);
  },
};

// ---------------------------------------------------------------------------
// create_folder
// ---------------------------------------------------------------------------

const createFolder: ToolDef = {
  name: "create_folder",
  description:
    "Create a new folder in Apple Notes. Use the optional `parent` parameter to create a subfolder inside an existing folder (e.g. a Google account folder). Use the optional `account` parameter (e.g. 'Google', 'iCloud', 'Exchange') to create the folder in a specific Notes account. When --write-folder restrictions are set, the folder name must be in that list.",
  inputSchema: z.object({
    name: z.string().min(1).describe("Folder name."),
    parent: z.string().optional().describe("Parent folder name. If provided, creates a subfolder inside this folder."),
    account: z.string().optional().describe("Account name (e.g. 'Google', 'iCloud', 'Exchange'). If provided, creates the folder in that account."),
  }),
  handler: async ({ name, parent, account }: { name: string; parent?: string; account?: string }, ctx) => {
    assertCanCreateFolder(name, ctx.folders, parent);
    // If a folder with this name already exists, verify it's in the required account.
    await assertFolderAccountAllowed(name, ctx.folders);
    if (parent) {
      // Create subfolder inside an existing parent folder
      const script = `tell application "Notes"
  set parent_f to folder ${asString(parent)}
  make new folder with properties {name:${asString(name)}} at parent_f
end tell`;
      await runAppleScript(script);
      return JSON.stringify({ name, parent, created: true }, null, 2);
    } else if (account) {
      // Create top-level folder in a specific account
      const script = `tell application "Notes"
  set target_account to account ${asString(account)}
  set f to make new folder with properties {name:${asString(name)}} at target_account
  return (id of f) as text
end tell`;
      const raw = await runAppleScript(script);
      const folderId = raw.trim().replace(/^"|"$/g, "");
      return JSON.stringify({ id: folderId, name, account }, null, 2);
    } else {
      const script = `tell application "Notes"
  set f to make new folder with properties {name:${asString(name)}}
  return (id of f) as text
end tell`;
      const raw = await runAppleScript(script);
      const folderId = raw.trim().replace(/^"|"$/g, "");
      return JSON.stringify({ id: folderId, name }, null, 2);
    }
  },
};

// ---------------------------------------------------------------------------
// delete_note
// ---------------------------------------------------------------------------

const deleteNote: ToolDef = {
  name: "delete_note",
  description:
    "Delete a note. DESTRUCTIVE — Apple moves it to Recently Deleted. When --write-folder restrictions are set, the note must live in an allowed folder. Use `parent` when the note is in an IMAP subfolder.",
  inputSchema: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      folder: z.string().optional(),
      parent: z.string().optional().describe("Parent folder name. Required when note is in an IMAP subfolder."),
    })
    .refine((v) => v.id || v.name, { message: "Provide either id or name." }),
  handler: async ({ id, name, folder, parent }: { id?: string; name?: string; folder?: string; parent?: string }, ctx) => {
    if (folder !== undefined) {
      if (ctx.folders.writeFolders.length > 0 && !ctx.folders.writeFolders.includes(folder)) {
        const ok = await isFolderUnderAllowedTop(folder, ctx.folders.writeFolders);
        if (!ok) {
          throw new PermissionDeniedError(
            `Folder "${folder}" is not in the allowed --write-folder list (${ctx.folders.writeFolders.join(", ")}) and is not a subfolder of any allowed top-level folder.`,
          );
        }
      } else {
        await assertFolderAccountAllowed(folder, ctx.folders);
      }
    }

    let selector: string;
    if (id) {
      selector = `note id ${asString(id)}`;
    } else if (folder && parent) {
      selector = `(first note of folder ${asString(folder)} of folder ${asString(parent)} whose name is ${asString(name!)})`;
    } else if (folder) {
      selector = `(first note of folder ${asString(folder)} whose name is ${asString(name!)})`;
    } else {
      const allowedTops = ctx.folders.writeFolders;
      if (allowedTops.length === 0) {
        selector = `(first note whose name is ${asString(name!)})`;
      } else if (allowedTops.length === 1) {
        const findScript = `${AS_JSON_HELPERS}
tell application "Notes"
  set scopedAllowed to ${asStringList(allowedTops)}
  set target_name to ${asString(name!)}
  set folder_id to ""
  repeat with f in (every folder)
    if (name of f is in scopedAllowed) or (my topFolderName(f) is in scopedAllowed) then
      set ms to (notes of f whose name is target_name)
      if (count of ms) > 0 then
        set folder_id to (id of f) as text
        exit repeat
      end if
    end if
  end repeat
  return folder_id
end tell`;
        const found = (await runAppleScript(findScript)).trim().replace(/^"|"$/g, "");
        if (!found) throw new Error(`Note "${name}" not found in allowed folders.`);
        selector = `(first note of (first folder whose id is ${asString(found)}) whose name is ${asString(name!)})`;
      } else {
        throw new PermissionDeniedError(
          `delete_note: provide a folder argument. Allowed: ${allowedTops.join(", ")}.`,
        );
      }
    }

    const allowed = ctx.folders.writeFolders;
    if (allowed.length > 0 && !parent) {
      // When parent is provided, folder permission was already validated above.
      // Skip container check for IMAP subfolder notes (note id lookup fails for them).
      const checkScript = `${AS_JSON_HELPERS}
tell application "Notes"
  set n to ${selector}
  set f to container of n
  return my jsonEscape(my topFolderName(f))
end tell`;
      const topName = (await runAppleScript(checkScript)).trim();
      if (!allowed.includes(topName)) {
        throw new PermissionDeniedError(
          `Note's top-level folder "${topName}" is not in --write-folder allow-list.`,
        );
      }
    }

    const script = `tell application "Notes"
  delete ${selector}
end tell`;
    await runAppleScript(script);
    return JSON.stringify({ deleted: true }, null, 2);
  },
};

// ---------------------------------------------------------------------------
// update_note
// ---------------------------------------------------------------------------

/**
 * Build a script that locates a note by name or id in an IMAP subfolder using
 * bulk index access, then writes back via positional index (the only working
 * write method for IMAP-backed notes).
 */
function updateImapSubfolderNoteScript(
  parentFolder: string,
  subFolder: string,
  noteName: string | null,
  noteId: string | null,
  newName: string | null,
  newBody: string | null,
): string {
  const parent = asString(parentFolder);
  const sub = asString(subFolder);
  const targetName = noteName ? asString(noteName) : '""';
  const targetId = noteId ? asString(noteId) : '""';
  const setName = newName ? `set name of note match_idx of folder ${sub} of folder ${parent} to ${asString(newName)}` : "";
  const setBody = newBody ? `set body of note match_idx of folder ${sub} of folder ${parent} to ${asString(newBody)}` : "";
  return `tell application "Notes"
  set nnames to name of every note of folder ${sub} of folder ${parent}
  set nids to id of every note of folder ${sub} of folder ${parent}
  set target_name to ${targetName}
  set target_id to ${targetId}
  set match_idx to 0
  repeat with i from 1 to count of nnames
    set nname to item i of nnames
    set nid to item i of nids
    if (target_id is not "" and nid is target_id) or (target_name is not "" and nname is target_name) then
      set match_idx to i
      exit repeat
    end if
  end repeat
  if match_idx is 0 then return "not found"
  ${setName}
  ${setBody}
  return "updated"
end tell`;
}

function updateImapTopFolderNoteScript(
  folderName: string,
  noteName: string | null,
  noteId: string | null,
  newName: string | null,
  newBody: string | null,
): string {
  const fname = asString(folderName);
  const targetName = noteName ? asString(noteName) : '""';
  const targetId = noteId ? asString(noteId) : '""';
  const setName = newName ? `set name of note match_idx of folder ${fname} to ${asString(newName)}` : "";
  const setBody = newBody ? `set body of note match_idx of folder ${fname} to ${asString(newBody)}` : "";
  return `tell application "Notes"
  set nnames to name of every note of folder ${fname}
  set nids to id of every note of folder ${fname}
  set target_name to ${targetName}
  set target_id to ${targetId}
  set match_idx to 0
  repeat with i from 1 to count of nnames
    set nname to item i of nnames
    set nid to item i of nids
    if (target_id is not "" and nid is target_id) or (target_name is not "" and nname is target_name) then
      set match_idx to i
      exit repeat
    end if
  end repeat
  if match_idx is 0 then return "not found"
  ${setName}
  ${setBody}
  return "updated"
end tell`;
}

const updateNote: ToolDef = {
  name: "update_note",
  description:
    "Update an existing note's title and/or body. Provide either `id` or `name` to identify the note. `body` may be HTML or plain text and fully replaces the existing content. Use `parent` when the note is in an IMAP subfolder (e.g. folder='Appraisal', parent='HTX').",
  inputSchema: z
    .object({
      id: z.string().optional().describe("Note id to update."),
      name: z.string().optional().describe("Note name (used if id not provided)."),
      folder: z.string().optional().describe("Folder to scope name lookup."),
      parent: z.string().optional().describe("Parent folder name. Required when note is in an IMAP subfolder."),
      new_name: z.string().optional().describe("New title for the note."),
      body: z.string().optional().describe("New body (HTML or plain text). Fully replaces existing content."),
    })
    .refine((v) => v.id || v.name, { message: "Provide either id or name." })
    .refine((v) => v.new_name || v.body, { message: "Provide at least one of new_name or body." }),
  handler: async (
    { id, name, folder, parent, new_name, body }: { id?: string; name?: string; folder?: string; parent?: string; new_name?: string; body?: string },
    ctx,
  ) => {
    // Validate folder permission
    if (folder !== undefined) {
      if (ctx.folders.writeFolders.length > 0 && !ctx.folders.writeFolders.includes(folder)) {
        const ok = await isFolderUnderAllowedTop(folder, ctx.folders.writeFolders);
        if (!ok) {
          throw new PermissionDeniedError(
            `Folder "${folder}" is not in the allowed --write-folder list (${ctx.folders.writeFolders.join(", ")}) and is not a subfolder of any allowed top-level folder.`,
          );
        }
      } else if (folder !== undefined) {
        await assertFolderAccountAllowed(folder, ctx.folders);
      }
    }

    const newNameVal = new_name ?? null;
    const newBodyVal = body ?? null;

    // Case 1: folder + parent → IMAP subfolder
    if (folder && parent) {
      const script = updateImapSubfolderNoteScript(parent, folder, name ?? null, id ?? null, newNameVal, newBodyVal);
      const result = (await runAppleScript(script)).trim().replace(/^"|"$/g, "");
      if (result !== "updated") throw new Error(`Note not found in folder "${folder}" under "${parent}".`);
      return JSON.stringify({ updated: true }, null, 2);
    }

    // Case 2: folder only → try top-level IMAP folder, then subfolder scan
    if (folder) {
      // Try direct (non-IMAP) update first
      const directScript = `tell application "Notes"
  try
    set n to (first note of folder ${asString(folder)} whose name is ${asString(name ?? "")})
    ${newNameVal ? `set name of n to ${asString(newNameVal)}` : ""}
    ${newBodyVal ? `set body of n to ${asString(newBodyVal)}` : ""}
    return "updated"
  on error
    return "not found"
  end try
end tell`;
      if (name) {
        const r = (await runAppleScript(directScript)).trim().replace(/^"|"$/g, "");
        if (r === "updated") return JSON.stringify({ updated: true }, null, 2);
      }

      // Try as IMAP top-level folder
      const topScript = updateImapTopFolderNoteScript(folder, name ?? null, id ?? null, newNameVal, newBodyVal);
      try {
        const r = (await runAppleScript(topScript)).trim().replace(/^"|"$/g, "");
        if (r === "updated") return JSON.stringify({ updated: true }, null, 2);
      } catch { /* not an IMAP top-level folder */ }

      // Try as IMAP subfolder across all parents
      const topFoldersScript = `tell application "Notes"\n  return name of every folder\nend tell`;
      const topNames = (await runAppleScript(topFoldersScript)).split(", ").map((s) => s.trim()).filter(Boolean);
      for (const topName of topNames) {
        const script = updateImapSubfolderNoteScript(topName, folder, name ?? null, id ?? null, newNameVal, newBodyVal);
        try {
          const r = (await runAppleScript(script)).trim().replace(/^"|"$/g, "");
          if (r === "updated") return JSON.stringify({ updated: true }, null, 2);
        } catch { /* skip */ }
      }
      throw new Error(`Note not found in folder "${folder}".`);
    }

    // Case 3: id or name only — try global direct update, then scan IMAP subfolders
    if (id || name) {
      // Try global direct (works for iCloud notes)
      if (name) {
        const globalScript = `tell application "Notes"
  try
    set n to (first note whose name is ${asString(name)})
    ${newNameVal ? `set name of n to ${asString(newNameVal)}` : ""}
    ${newBodyVal ? `set body of n to ${asString(newBodyVal)}` : ""}
    return "updated"
  on error
    return "not found"
  end try
end tell`;
        const r = (await runAppleScript(globalScript)).trim().replace(/^"|"$/g, "");
        if (r === "updated") return JSON.stringify({ updated: true }, null, 2);
      }

      // Scan all IMAP top-level and subfolders
      const topFoldersScript = `tell application "Notes"\n  return name of every folder\nend tell`;
      const topNames = (await runAppleScript(topFoldersScript)).split(", ").map((s) => s.trim()).filter(Boolean);
      for (const topName of topNames) {
        // Try top-level IMAP folder
        const topScript = updateImapTopFolderNoteScript(topName, name ?? null, id ?? null, newNameVal, newBodyVal);
        try {
          const r = (await runAppleScript(topScript)).trim().replace(/^"|"$/g, "");
          if (r === "updated") return JSON.stringify({ updated: true }, null, 2);
        } catch { /* skip */ }

        // Try subfolders of this top-level folder
        try {
          const subNamesScript = `tell application "Notes"\n  return name of every folder of folder ${asString(topName)}\nend tell`;
          const subNamesRaw = await runAppleScript(subNamesScript);
          if (!subNamesRaw.trim()) continue;
          const subNames = subNamesRaw.split(", ").map((s) => s.trim()).filter(Boolean);
          for (const subName of subNames) {
            const script = updateImapSubfolderNoteScript(topName, subName, name ?? null, id ?? null, newNameVal, newBodyVal);
            try {
              const r = (await runAppleScript(script)).trim().replace(/^"|"$/g, "");
              if (r === "updated") return JSON.stringify({ updated: true }, null, 2);
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }

    throw new Error("Note not found.");
  },
};

// ---------------------------------------------------------------------------
// delete_folder
// ---------------------------------------------------------------------------

const deleteFolder: ToolDef = {
  name: "delete_folder",
  description:
    "Delete a folder (and all its notes). DESTRUCTIVE — Apple moves contents to Recently Deleted. Supports both top-level and IMAP subfolders. Use `parent` to scope deletion to a subfolder of a specific parent.",
  inputSchema: z.object({
    name: z.string().min(1).describe("Folder name to delete."),
    parent: z.string().optional().describe("Parent folder name. Required when deleting an IMAP subfolder."),
  }),
  handler: async ({ name, parent }: { name: string; parent?: string }, ctx) => {
    // Permission check: the folder (or its parent) must be in the write allow-list.
    if (ctx.folders.writeFolders.length > 0) {
      const topName = parent ?? name;
      if (!ctx.folders.writeFolders.includes(topName)) {
        throw new PermissionDeniedError(
          `Folder "${topName}" is not in the allowed --write-folder list (${ctx.folders.writeFolders.join(", ")}).`,
        );
      }
      await assertFolderAccountAllowed(topName, ctx.folders);
    }

    if (parent) {
      // IMAP subfolder: find by index using bulk name access, then delete by index
      const script = `tell application "Notes"
  set parent_f to folder ${asString(parent)}
  set sub_names to name of every folder of parent_f
  set target_idx to 0
  repeat with i from 1 to count of sub_names
    if item i of sub_names is ${asString(name)} then
      set target_idx to i
      exit repeat
    end if
  end repeat
  if target_idx is 0 then return "not found"
  delete (folder target_idx of parent_f)
  return "deleted"
end tell`;
      const result = (await runAppleScript(script)).trim().replace(/^"|"$/g, "");
      if (result !== "deleted") throw new Error(`Folder "${name}" not found under "${parent}".`);
    } else {
      // Top-level folder
      const script = `tell application "Notes"
  if not (exists folder ${asString(name)}) then
    return "not found"
  end if
  delete folder ${asString(name)}
  return "deleted"
end tell`;
      const result = (await runAppleScript(script)).trim().replace(/^"|"$/g, "");
      if (result !== "deleted") throw new Error(`Folder "${name}" not found.`);
    }

    return JSON.stringify({ deleted: true, name, parent }, null, 2);
  },
};

// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// list_accounts
// ---------------------------------------------------------------------------

const listAccounts: ToolDef = {
  name: "list_accounts",
  description:
    "List all accounts configured in Apple Notes (e.g. iCloud, Google, Exchange). Useful for knowing which account to target when creating folders.",
  inputSchema: z.object({}),
  handler: async (_args, _ctx) => {
    const script = `tell application "Notes"
  set acctList to {}
  repeat with a in accounts
    set end of acctList to "{\\\"name\\\":\\\"" & (name of a) & "\\\"}"
  end repeat
  return "[" & (acctList as text) & "]"
end tell`;
    const raw = await runAppleScript(script);
    // AppleScript joins list items without separator — insert commas between objects
    const json = raw.trim().replace(/\}\s*\{/g, "},{");
    const accounts: Array<{ name: string }> = JSON.parse(json);
    return JSON.stringify(accounts, null, 2);
  },
};

export const TOOLS: Record<ToolName, ToolDef> = {
  list_accounts: listAccounts,
  list_folders: listFolders,
  list_notes: listNotes,
  search_notes: searchNotes,
  get_note: getNote,
  create_note: createNote,
  append_to_note: appendToNote,
  create_folder: createFolder,
  update_note: updateNote,
  delete_note: deleteNote,
  delete_folder: deleteFolder,
};
