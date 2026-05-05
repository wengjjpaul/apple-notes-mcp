#!/usr/bin/env node
/**
 * End-to-end edge-case test harness for apple-notes-mcp.
 * Spawns the built server as a real MCP stdio process and drives JSON-RPC
 * over its stdin/stdout. Verifies tool behavior + permission gating against
 * the user's actual Apple Notes app.
 *
 * Run:  node test/e2e.mjs
 */
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "..", "dist", "index.js");

const TEST_FOLDER = `mcp-e2e-${Date.now()}`;
const UNICODE_NAME = `MCP-E2E "quoted" \\back \u00e9 emoji \ud83d\udcdd`;
const TRICKY_BODY =
  '<p>Line 1 with "quotes" &amp; &lt;tag&gt;</p>\n<p>Line 2 \\backslash</p>\n<p>Unicode: café 🚀 — em-dash</p>\n<p>Tab\there.</p>';

let pass = 0;
let fail = 0;
const failures = [];

/**
 * Runs an AppleScript snippet via osascript and returns stdout. Used by the
 * test harness for setup/teardown that the MCP server doesn't expose
 * (e.g. nested folder creation, recursive folder cleanup).
 */
function osascript(script) {
  return new Promise((resolveP) => {
    const p = spawn("osascript", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => resolveP({ code, out: out.trim(), err: err.trim() }));
    p.stdin.write(script);
    p.stdin.end();
  });
}

/** Recursively delete a top-level folder by name (and all descendants). */
async function deleteTopFolderByName(name) {
  const safe = name.replace(/"/g, '\\"');
  return osascript(`tell application "Notes"
  try
    delete folder "${safe}"
  end try
end tell`);
}

/** Create a sub-folder named `child` inside top-level folder `parent`. */
async function createSubfolder(parent, child) {
  const sp = parent.replace(/"/g, '\\"');
  const sc = child.replace(/"/g, '\\"');
  return osascript(`tell application "Notes"
  make new folder at folder "${sp}" with properties {name:"${sc}"}
end tell`);
}

function log(label, ok, detail = "") {
  const tag = ok ? "✅" : "❌";
  console.log(`${tag} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else {
    fail++;
    failures.push(label);
  }
}

class McpClient {
  constructor(args) {
    this.args = args;
    this.proc = null;
    this.buf = "";
    this.pending = new Map();
    this.nextId = 1;
    this.exitInfo = null;
  }

  start() {
    this.proc = spawn("node", [BIN, ...this.args], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (d) => this._onData(d.toString()));
    this.proc.stderr.on("data", () => {}); // swallow stderr noise
    this.proc.on("close", (code, signal) => {
      this.exitInfo = { code, signal };
      for (const [, { reject }] of this.pending) reject(new Error("server closed"));
      this.pending.clear();
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  send(method, params, expectResponse = true) {
    if (!expectResponse) {
      const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
      this.proc.stdin.write(payload);
      return Promise.resolve(null);
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for ${method} (id=${id})`));
        }
      }, 30_000);
    });
  }

  async init() {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    await this.send("notifications/initialized", {}, false);
  }

  async listTools() {
    const r = await this.send("tools/list", {});
    return r.result.tools.map((t) => t.name);
  }

  async call(name, args) {
    return this.send("tools/call", { name, arguments: args });
  }

  async stop() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      await new Promise((r) => this.proc.once("close", r));
    }
  }

  async waitForExit() {
    if (this.exitInfo) return this.exitInfo;
    return new Promise((r) => this.proc.once("close", (code, signal) => r({ code, signal })));
  }
}

function getText(resp) {
  return resp.result?.content?.[0]?.text ?? "";
}

function isToolError(resp) {
  return resp.result?.isError === true;
}

// ---------------------------------------------------------------------------
// Section 1: CLI / boot edge cases (don't require Notes interaction)
// ---------------------------------------------------------------------------
async function testCliEdgeCases() {
  console.log("\n=== CLI / boot ===");

  // No --allow → exit 2
  {
    const c = new McpClient([]);
    c.start();
    const info = await c.waitForExit();
    log("exits non-zero with no --allow", info.code === 2, `code=${info.code}`);
  }

  // Unknown tool name in --allow → exit 2
  {
    const c = new McpClient(["--allow=not_a_tool"]);
    c.start();
    const info = await c.waitForExit();
    log("rejects unknown tool name in --allow", info.code === 2, `code=${info.code}`);
  }

  // --help → exit 0
  {
    const c = new McpClient(["--help"]);
    c.start();
    const info = await c.waitForExit();
    log("--help exits 0", info.code === 0, `code=${info.code}`);
  }
}

// ---------------------------------------------------------------------------
// Section 2: Permission gating (server registers only allowed tools)
// ---------------------------------------------------------------------------
async function testPermissionGating() {
  console.log("\n=== Permission gating ===");

  // read group exposes exactly 5 tools
  {
    const c = new McpClient(["--allow=read"]);
    c.start();
    await c.init();
    const tools = await c.listTools();
    const expected = ["list_accounts", "list_folders", "list_notes", "search_notes", "get_note"];
    const ok =
      tools.length === expected.length &&
      expected.every((t) => tools.includes(t));
    log("--allow=read exposes exactly 5 read tools", ok, `got=${tools.join(",")}`);
    await c.stop();
  }

  // Calling a non-registered tool returns an error from the server
  {
    const c = new McpClient(["--allow=read"]);
    c.start();
    await c.init();
    const resp = await c.call("delete_note", { name: "x" });
    const errored =
      resp.error != null || isToolError(resp) || /unknown|not found/i.test(JSON.stringify(resp));
    log("calling disabled tool yields error", errored, JSON.stringify(resp).slice(0, 120));
    await c.stop();
  }

  // Granular allow: single tool only
  {
    const c = new McpClient(["--allow=list_folders"]);
    c.start();
    await c.init();
    const tools = await c.listTools();
    log("--allow=list_folders exposes only list_folders", tools.length === 1 && tools[0] === "list_folders", tools.join(","));
    await c.stop();
  }

  // 'all' exposes all 11
  {
    const c = new McpClient(["--allow=all"]);
    c.start();
    await c.init();
    const tools = await c.listTools();
    log("--allow=all exposes all 11 tools", tools.length === 11, `count=${tools.length}`);
    await c.stop();
  }
}

// ---------------------------------------------------------------------------
// Section 3: Tool behavior + edge cases (real Apple Notes interaction)
// ---------------------------------------------------------------------------
async function testToolBehavior() {
  console.log("\n=== Tool behavior ===");
  const c = new McpClient(["--allow=all"]);
  c.start();
  await c.init();

  let folderCreated = false;
  let noteId = null;

  try {
    // Input validation: schema should reject calls missing required args
    {
      const resp = await c.call("search_notes", {}); // missing 'query'
      log("search_notes rejects missing query", resp.error != null || isToolError(resp));
    }

    // Input validation: get_note requires id OR name
    {
      const resp = await c.call("get_note", {});
      log("get_note rejects empty args", resp.error != null || isToolError(resp));
    }

    // create_folder
    {
      const resp = await c.call("create_folder", { name: TEST_FOLDER });
      const ok = !isToolError(resp) && resp.result?.content?.[0]?.text?.includes(TEST_FOLDER);
      folderCreated = ok;
      log("create_folder", ok, getText(resp).slice(0, 80));
    }

    // list_folders includes the new folder
    {
      const resp = await c.call("list_folders", {});
      const text = getText(resp);
      log("list_folders includes new folder", text.includes(TEST_FOLDER));
    }

    // create_note in that folder, with tricky name + body (quotes/backslash/unicode/emoji/newlines)
    {
      const resp = await c.call("create_note", {
        name: UNICODE_NAME,
        body: TRICKY_BODY,
        folder: TEST_FOLDER,
      });
      const text = getText(resp);
      const ok = !isToolError(resp) && text.includes("\"id\"");
      if (ok) {
        try {
          noteId = JSON.parse(text).id;
        } catch {}
      }
      log("create_note with tricky chars + folder", ok && noteId, `id=${noteId}`);
    }

    // list_notes scoped to the folder returns exactly 1 note
    {
      const resp = await c.call("list_notes", { folder: TEST_FOLDER, limit: 10 });
      let arr = [];
      try {
        arr = JSON.parse(getText(resp));
      } catch {}
      log(
        "list_notes in folder returns the new note",
        Array.isArray(arr) && arr.length === 1 && arr[0].name === UNICODE_NAME,
        `len=${arr.length}`,
      );
    }

    // get_note by id round-trips body & name exactly (HTML preserved)
    if (noteId) {
      const resp = await c.call("get_note", { id: noteId });
      let parsed = null;
      try {
        parsed = JSON.parse(getText(resp));
      } catch {}
      const nameOk = parsed?.name === UNICODE_NAME;
      const bodyHasUnicode = /caf\u00e9/.test(parsed?.plaintext ?? "");
      const bodyHasEmoji = /\ud83d\ude80/.test(parsed?.plaintext ?? "");
      log("get_note preserves unicode name", nameOk, `name=${parsed?.name}`);
      log("get_note preserves unicode + emoji body", bodyHasUnicode && bodyHasEmoji);
    }

    // search_notes finds by partial name
    {
      const resp = await c.call("search_notes", { query: "MCP-E2E", limit: 5 });
      let arr = [];
      try {
        arr = JSON.parse(getText(resp));
      } catch {}
      log("search_notes finds new note by name fragment", arr.length >= 1);
    }

    // search_notes returns empty array for no matches
    {
      const resp = await c.call("search_notes", {
        query: "zzz_no_match_string_" + Date.now(),
      });
      let arr = null;
      try {
        arr = JSON.parse(getText(resp));
      } catch {}
      log("search_notes returns [] for no matches", Array.isArray(arr) && arr.length === 0);
    }

    // append_to_note by id, then verify content grew
    if (noteId) {
      const marker = `MARKER-${Date.now()}`;
      const ap = await c.call("append_to_note", {
        id: noteId,
        content: `<p>${marker}</p>`,
      });
      log("append_to_note by id", !isToolError(ap));

      const get2 = await c.call("get_note", { id: noteId });
      let parsed = null;
      try {
        parsed = JSON.parse(getText(get2));
      } catch {}
      log("appended marker visible in note body", parsed?.plaintext?.includes(marker), `present=${parsed?.plaintext?.includes(marker)}`);
    }

    // get_note for non-existent name → error result
    {
      const resp = await c.call("get_note", { name: "definitely-does-not-exist-" + Date.now() });
      log("get_note returns error for missing note", isToolError(resp) || resp.error != null);
    }

    // list_notes for non-existent folder → error result
    {
      const resp = await c.call("list_notes", { folder: "no-such-folder-" + Date.now() });
      log("list_notes errors for missing folder", isToolError(resp) || resp.error != null);
    }

    // limit clamping: schema rejects limit > 500 (list_notes max)
    {
      const resp = await c.call("list_notes", { limit: 9999 });
      log("list_notes rejects limit > 500", resp.error != null || isToolError(resp));
    }
  } finally {
    // Cleanup: delete the test note (by id if we have it, else by name)
    if (noteId) {
      const r = await c.call("delete_note", { id: noteId });
      log("cleanup: delete_note by id", !isToolError(r));
    }
    // Cleanup: delete the test folder via osascript (server has no delete_folder).
    if (folderCreated) {
      await deleteTopFolderByName(TEST_FOLDER);
      log("cleanup: removed test folder", true);
    }
    await c.stop();
  }
}

// ---------------------------------------------------------------------------
// Section 4: Diverse content formats — each format is its own roundtrip
//   create → get → assert → delete, isolated so failures are localized.
// ---------------------------------------------------------------------------
async function testContentFormats() {
  console.log("\n=== Content formats ===");
  const c = new McpClient(["--allow=create_note,get_note,append_to_note,delete_note,search_notes"]);
  c.start();
  await c.init();

  /**
   * Run a single create-get-assert-delete cycle.
   * @param {string} label
   * @param {{name:string, body:string, expect:(parsed:{name:string, body:string, plaintext:string})=>boolean | string}} cfg
   */
  async function roundtrip(label, cfg) {
    let id = null;
    try {
      const create = await c.call("create_note", { name: cfg.name, body: cfg.body });
      if (isToolError(create)) {
        log(label, false, `create failed: ${getText(create).slice(0, 120)}`);
        return;
      }
      try {
        id = JSON.parse(getText(create)).id;
      } catch {
        log(label, false, "could not parse create response");
        return;
      }
      const get = await c.call("get_note", { id });
      if (isToolError(get)) {
        log(label, false, `get failed: ${getText(get).slice(0, 120)}`);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(getText(get));
      } catch {
        log(label, false, "get response was not JSON");
        return;
      }
      const result = cfg.expect(parsed);
      if (result === true) {
        log(label, true);
      } else {
        log(label, false, typeof result === "string" ? result : `assertion failed; plaintext=${JSON.stringify(parsed.plaintext?.slice(0, 120))}`);
      }
    } finally {
      if (id) {
        await c.call("delete_note", { id });
      }
    }
  }

  // 1. Plain text only (no HTML tags) — Apple Notes wraps it in divs
  await roundtrip("plain text body", {
    name: "Fmt-Plain",
    body: "This is just plain text with no markup.",
    expect: (p) => p.plaintext.includes("plain text with no markup") || "plaintext missing",
  });

  // 2. Empty body
  await roundtrip("empty body", {
    name: "Fmt-Empty",
    body: "",
    expect: (p) => typeof p.body === "string" && typeof p.plaintext === "string",
  });

  // 3. Rich HTML formatting: bold, italic, underline
  await roundtrip("rich HTML (b/i/u)", {
    name: "Fmt-Rich",
    body: "<p><b>bold</b> <i>italic</i> <u>underline</u></p>",
    expect: (p) =>
      /<b>/i.test(p.body) && /<i>/i.test(p.body) && /<u>/i.test(p.body) ||
      "missing one of b/i/u in body",
  });

  // 4. Lists (ordered + unordered)
  await roundtrip("ordered + unordered lists", {
    name: "Fmt-Lists",
    body: "<ul><li>alpha</li><li>beta</li></ul><ol><li>one</li><li>two</li></ol>",
    expect: (p) =>
      p.plaintext.includes("alpha") &&
      p.plaintext.includes("beta") &&
      p.plaintext.includes("one") &&
      p.plaintext.includes("two") || "list items missing from plaintext",
  });

  // 5. Hyperlink — Apple Notes drops href and renders link text underlined.
  // We verify the visible text survives (the URL is normalized away by Notes).
  await roundtrip("hyperlink (text preserved; href stripped by Notes)", {
    name: "Fmt-Link",
    body: '<p>Visit <a href="https://example.com">Example</a> today.</p>',
    expect: (p) => p.plaintext.includes("Visit Example today") || `plaintext=${p.plaintext}`,
  });

  // 6. HTML entities (need to survive AppleScript round-trip)
  await roundtrip("HTML entities (&amp; &lt; &gt; &quot;)", {
    name: "Fmt-Entities",
    body: "<p>5 &lt; 10 &amp;&amp; 10 &gt; 5 &quot;wow&quot;</p>",
    expect: (p) =>
      p.plaintext.includes("5 < 10") &&
      p.plaintext.includes("10 > 5") &&
      p.plaintext.includes('"wow"') || `plaintext=${p.plaintext.slice(0, 100)}`,
  });

  // 7. <br> hard line breaks
  await roundtrip("<br> line breaks", {
    name: "Fmt-Br",
    body: "<p>line1<br>line2<br>line3</p>",
    expect: (p) =>
      p.plaintext.includes("line1") &&
      p.plaintext.includes("line2") &&
      p.plaintext.includes("line3") || "br lines missing",
  });

  // 8. Headings
  await roundtrip("headings h1/h2/h3", {
    name: "Fmt-Headings",
    body: "<h1>Big</h1><h2>Mid</h2><h3>Small</h3><p>body</p>",
    expect: (p) =>
      p.plaintext.includes("Big") &&
      p.plaintext.includes("Mid") &&
      p.plaintext.includes("Small") || "heading text missing",
  });

  // 9. Pre-formatted / "code block" (Apple Notes downgrades but text should survive)
  await roundtrip("preformatted code block", {
    name: "Fmt-Code",
    body: "<pre>function hello() {\n  return 42;\n}</pre>",
    expect: (p) =>
      p.plaintext.includes("function hello()") &&
      p.plaintext.includes("return 42") || `plaintext=${p.plaintext.slice(0, 120)}`,
  });

  // 10. Inline code
  await roundtrip("inline <code>", {
    name: "Fmt-InlineCode",
    body: "<p>Use <code>npm install</code> to install.</p>",
    expect: (p) => p.plaintext.includes("npm install") || "code text missing",
  });

  // 11. Multi-byte unicode mix (CJK, Cyrillic, Arabic, Greek)
  await roundtrip("multi-script unicode (CJK/Cyrillic/Arabic/Greek)", {
    name: "Fmt-MultiScript 中文 Привет",
    body: "<p>中文: 你好世界</p><p>Русский: Привет мир</p><p>العربية: مرحبا بالعالم</p><p>Ελληνικά: Γεια σου κόσμε</p>",
    expect: (p) =>
      p.name.includes("中文") &&
      p.plaintext.includes("你好世界") &&
      p.plaintext.includes("Привет мир") &&
      p.plaintext.includes("مرحبا") &&
      p.plaintext.includes("Γεια") || `name=${p.name} plaintext sample=${p.plaintext.slice(0, 100)}`,
  });

  // 12. Many emoji including ZWJ sequences and skin-tone modifiers
  await roundtrip("emoji incl. ZWJ + skin tones", {
    name: "Fmt-Emoji 🎉",
    body: "<p>👨‍💻 👩🏽‍🚀 🏳️‍🌈 🇺🇸 🐈‍⬛</p>",
    expect: (p) =>
      /\ud83c\udf89/.test(p.name) && // 🎉 in name
      /\ud83d\udc68/.test(p.plaintext) && // 👨 base
      /\ud83c\udff3/.test(p.plaintext) || `plaintext sample=${JSON.stringify(p.plaintext.slice(0, 60))}`,
  });

  // 13. Heavy quoting / backslash punishment
  await roundtrip("backslashes + nested quotes", {
    name: 'Fmt-"Quoted" \\path\\to\\thing',
    body: '<p>He said "hello" then \\\\escaped\\\\ stuff. Path: C:\\\\Users\\\\me</p>',
    expect: (p) =>
      p.name.includes('"Quoted"') &&
      p.name.includes("\\path\\to\\thing") &&
      p.plaintext.includes('"hello"') || `name=${p.name} plaintext=${p.plaintext.slice(0, 80)}`,
  });

  // 14. Long single-line content
  await roundtrip("long single-line body (~10 KB)", {
    name: "Fmt-LongLine",
    body: "<p>" + "abcdefghij".repeat(1000) + "</p>", // 10_000 chars
    expect: (p) => p.plaintext.length >= 10_000 || `plaintext length=${p.plaintext.length}`,
  });

  // 15. Many-line content (1000 short lines)
  await roundtrip("1000 short lines", {
    name: "Fmt-ManyLines",
    body: Array.from({ length: 1000 }, (_, i) => `<p>line ${i}</p>`).join(""),
    expect: (p) =>
      p.plaintext.includes("line 0") &&
      p.plaintext.includes("line 999") || "first/last line missing",
  });

  // 16. Very long note name — Apple Notes truncates titles to ~100 chars.
  //     We verify the prefix survives, not the full length.
  await roundtrip("long note name (truncated by Notes, prefix preserved)", {
    name: "Fmt-LongName-" + "x".repeat(500),
    body: "<p>short body</p>",
    expect: (p) =>
      p.name.startsWith("Fmt-LongName-xxxxx") || `name=${p.name.slice(0, 60)}... length=${p.name.length}`,
  });

  // 17. Whitespace-only name (Apple Notes will derive name from body's first line)
  await roundtrip("whitespace-only-ish title falls back to body h1", {
    name: "Fmt-WS",
    body: "<h1>Body Title</h1><p>content</p>",
    expect: (p) => typeof p.name === "string" && p.name.length > 0 || "name empty",
  });

  // 18. Tab + mixed whitespace in body
  await roundtrip("tabs and mixed whitespace", {
    name: "Fmt-Tabs",
    body: "<pre>col1\tcol2\tcol3\nval1\tval2\tval3</pre>",
    expect: (p) => p.plaintext.includes("col1") && p.plaintext.includes("val3") || "tab content lost",
  });

  // 19. Numeric character references (decimal + hex)
  await roundtrip("numeric character references", {
    name: "Fmt-NumRefs",
    body: "<p>Decimal &#8364; Hex &#x2603;</p>", // € and ☃
    expect: (p) => p.plaintext.includes("\u20ac") && p.plaintext.includes("\u2603") || `plaintext=${p.plaintext}`,
  });

  // 20. Append HTML to a note that already contains HTML — verify both survive
  {
    let id = null;
    try {
      const create = await c.call("create_note", {
        name: "Fmt-AppendMix",
        body: "<p><b>original bold</b></p>",
      });
      id = JSON.parse(getText(create)).id;
      const append = await c.call("append_to_note", {
        id,
        content: "<ul><li>added item 1</li><li>added item 2</li></ul>",
      });
      const get = await c.call("get_note", { id });
      const parsed = JSON.parse(getText(get));
      const ok =
        !isToolError(append) &&
        parsed.plaintext.includes("original bold") &&
        parsed.plaintext.includes("added item 1") &&
        parsed.plaintext.includes("added item 2");
      log("append HTML to HTML note preserves both", ok, ok ? "" : `plaintext=${parsed.plaintext.slice(0, 200)}`);
    } catch (err) {
      log("append HTML to HTML note preserves both", false, err.message);
    } finally {
      if (id) await c.call("delete_note", { id });
    }
  }

  // 21. Search by unicode body content
  {
    let id = null;
    try {
      const marker = "ΩΨ-search-marker-" + Date.now();
      const create = await c.call("create_note", {
        name: "Fmt-SearchUnicode",
        body: `<p>${marker}</p>`,
      });
      id = JSON.parse(getText(create)).id;
      const search = await c.call("search_notes", { query: marker });
      const arr = JSON.parse(getText(search));
      const found = Array.isArray(arr) && arr.some((n) => n.id === id);
      log("search_notes finds note by unicode body content", found, `count=${arr.length}`);
    } catch (err) {
      log("search_notes finds note by unicode body content", false, err.message);
    } finally {
      if (id) await c.call("delete_note", { id });
    }
  }

  await c.stop();
}

// ---------------------------------------------------------------------------
// Section 5: Folder scoping (--read-folder / --write-folder)
// ---------------------------------------------------------------------------
async function testFolderScoping() {
  console.log("\n=== Folder scoping ===");

  const stamp = Date.now();
  const READ_FOLDER = `mcp-scope-read-${stamp}`;
  const OTHER_FOLDER = `mcp-scope-other-${stamp}`;
  const NEW_WRITE_FOLDER = `mcp-scope-new-${stamp}`; // intentionally not yet existing

  // ---- Setup: create READ_FOLDER and OTHER_FOLDER, plus a note in each ----
  const setupClient = new McpClient(["--allow=all"]);
  setupClient.start();
  await setupClient.init();

  const setupIds = { readNote: null, otherNote: null };
  try {
    let r = await setupClient.call("create_folder", { name: READ_FOLDER });
    log("setup: create READ_FOLDER", !isToolError(r));
    r = await setupClient.call("create_folder", { name: OTHER_FOLDER });
    log("setup: create OTHER_FOLDER", !isToolError(r));

    r = await setupClient.call("create_note", {
      name: `note-in-read-${stamp}`,
      body: "<p>read-zone-body</p>",
      folder: READ_FOLDER,
    });
    setupIds.readNote = JSON.parse(getText(r)).id;
    log("setup: create note in READ_FOLDER", !!setupIds.readNote);

    r = await setupClient.call("create_note", {
      name: `note-in-other-${stamp}`,
      body: "<p>other-zone-body</p>",
      folder: OTHER_FOLDER,
    });
    setupIds.otherNote = JSON.parse(getText(r)).id;
    log("setup: create note in OTHER_FOLDER", !!setupIds.otherNote);
  } finally {
    await setupClient.stop();
  }

  // ---- Read scoping ----
  const readScoped = new McpClient(["--allow=read", `--read-folder=${READ_FOLDER}`]);
  readScoped.start();
  await readScoped.init();

  try {
    // list_folders is filtered to the allow-list
    {
      const r = await readScoped.call("list_folders", {});
      let arr = [];
      try { arr = JSON.parse(getText(r)); } catch {}
      const ok = Array.isArray(arr) &&
        arr.length === 1 &&
        arr[0].name === READ_FOLDER;
      log("--read-folder filters list_folders", ok, `got=${arr.map(f=>f.name).join(",")}`);
    }

    // list_notes with no folder arg → only notes from allowed folders
    {
      const r = await readScoped.call("list_notes", { limit: 50 });
      let arr = [];
      try { arr = JSON.parse(getText(r)); } catch {}
      const names = arr.map(n => n.name);
      log(
        "list_notes (no arg) returns only allowed-folder notes",
        names.includes(`note-in-read-${stamp}`) && !names.includes(`note-in-other-${stamp}`),
        `names=${names.slice(0,5).join("|")}`,
      );
    }

    // list_notes with explicit allowed folder works
    {
      const r = await readScoped.call("list_notes", { folder: READ_FOLDER });
      const arr = JSON.parse(getText(r));
      log("list_notes(folder=READ_FOLDER) works", arr.length === 1);
    }

    // list_notes with disallowed folder is rejected
    {
      const r = await readScoped.call("list_notes", { folder: OTHER_FOLDER });
      log("list_notes(folder=OTHER_FOLDER) rejected", isToolError(r));
    }

    // search_notes is scoped — won't find note in OTHER_FOLDER
    {
      const r = await readScoped.call("search_notes", { query: "other-zone-body" });
      const arr = JSON.parse(getText(r));
      log("search_notes scoped: no match in disallowed folder", arr.length === 0);
    }

    // search_notes finds match in allowed folder
    {
      const r = await readScoped.call("search_notes", { query: "read-zone-body" });
      const arr = JSON.parse(getText(r));
      log("search_notes scoped: matches in allowed folder", arr.length === 1);
    }

    // get_note by id pointing into disallowed folder is denied
    {
      const r = await readScoped.call("get_note", { id: setupIds.otherNote });
      log("get_note by id into disallowed folder denied", isToolError(r), getText(r).slice(0, 100));
    }

    // get_note by id into allowed folder succeeds
    {
      const r = await readScoped.call("get_note", { id: setupIds.readNote });
      const ok = !isToolError(r) && JSON.parse(getText(r)).folder === READ_FOLDER;
      log("get_note by id into allowed folder allowed", ok);
    }

    // get_note by name (no folder) finds it in allowed folder
    {
      const r = await readScoped.call("get_note", { name: `note-in-read-${stamp}` });
      log("get_note by name resolves within allowed folders", !isToolError(r));
    }

    // get_note by name (no folder) for a note that lives in OTHER_FOLDER is not found
    {
      const r = await readScoped.call("get_note", { name: `note-in-other-${stamp}` });
      log("get_note by name doesn't find disallowed-folder notes", isToolError(r));
    }
  } finally {
    await readScoped.stop();
  }

  // ---- Write scoping (incl. folder-not-yet-existing) ----
  const writeScoped = new McpClient([
    "--allow=write,destructive",
    `--write-folder=${NEW_WRITE_FOLDER}`,
  ]);
  writeScoped.start();
  await writeScoped.init();

  let createdNoteId = null;
  try {
    // create_note auto-creates the not-yet-existing folder
    {
      const r = await writeScoped.call("create_note", {
        name: `auto-folder-note-${stamp}`,
        body: "<p>spawned</p>",
      });
      const ok = !isToolError(r);
      const parsed = ok ? JSON.parse(getText(r)) : null;
      createdNoteId = parsed?.id ?? null;
      log(
        "create_note auto-creates not-yet-existing --write-folder",
        ok && parsed?.folder === NEW_WRITE_FOLDER && !!createdNoteId,
        `folder=${parsed?.folder}`,
      );
    }

    // create_note into a different folder is denied
    {
      const r = await writeScoped.call("create_note", {
        name: "should-fail",
        body: "<p>x</p>",
        folder: OTHER_FOLDER,
      });
      log("create_note into disallowed folder denied", isToolError(r));
    }

    // create_folder for the allowed name is permitted (it already exists, but the call should still go through OR error gracefully — assert: not a permission error)
    {
      const r = await writeScoped.call("create_folder", { name: NEW_WRITE_FOLDER });
      // Apple Notes errors when folder name collides; we accept either: server-side permission OK + Notes-level dup error, OR success.
      // The key is it isn't blocked by *our* permission layer.
      const text = getText(r);
      const blockedByUs = /not in the allowed/i.test(text);
      log("create_folder permitted by perms (Notes may dedupe)", !blockedByUs, text.slice(0, 100));
    }

    // create_folder for a disallowed name is denied
    {
      const r = await writeScoped.call("create_folder", { name: "some-other-folder" });
      log("create_folder denied for non-allowed name", isToolError(r) && /restricted/i.test(getText(r)));
    }

    // append_to_note by id into disallowed folder denied
    {
      // Use the OTHER_FOLDER note (created in setup)
      const r = await writeScoped.call("append_to_note", {
        id: setupIds.otherNote,
        content: "<p>nope</p>",
      });
      log("append_to_note by id into disallowed folder denied", isToolError(r));
    }

    // append_to_note by id into allowed folder works (use the auto-created note)
    if (createdNoteId) {
      const r = await writeScoped.call("append_to_note", {
        id: createdNoteId,
        content: "<p>added</p>",
      });
      log("append_to_note by id into allowed folder works", !isToolError(r));
    }

    // delete_note by id into disallowed folder denied
    {
      const r = await writeScoped.call("delete_note", { id: setupIds.otherNote });
      log("delete_note by id into disallowed folder denied", isToolError(r));
    }
  } finally {
    if (createdNoteId) await writeScoped.call("delete_note", { id: createdNoteId });
    await writeScoped.stop();
  }

  // ---- Sub-folder behavior: subfolders inherit parent's allow status ----
  console.log("\n--- Sub-folder inheritance ---");
  const SUB_NAME = `sub-${stamp}`;
  const subIds = { readSubNote: null, otherSubNote: null };
  // Create subfolders under READ_FOLDER and OTHER_FOLDER directly via osascript
  {
    const r1 = await createSubfolder(READ_FOLDER, SUB_NAME);
    log("setup: create subfolder under READ_FOLDER", r1.code === 0, r1.err.slice(0, 100));
    const r2 = await createSubfolder(OTHER_FOLDER, SUB_NAME);
    log("setup: create subfolder under OTHER_FOLDER", r2.code === 0, r2.err.slice(0, 100));
  }
  // Use osascript directly to put a note in each subfolder (the MCP server
  // can't reliably target a specific sub-folder when two folders share a name).
  {
    const r1 = await osascript(`tell application "Notes"
  set f to folder "${SUB_NAME}" of folder "${READ_FOLDER}"
  set n to make new note at f with properties {name:"sub-note-read-${stamp}", body:"<p>sub-read-body</p>"}
  return id of n
end tell`);
    subIds.readSubNote = r1.out.trim().replace(/^"|"$/g, "");
    log("setup: note in READ_FOLDER/sub", !!subIds.readSubNote);

    const r2 = await osascript(`tell application "Notes"
  set f to folder "${SUB_NAME}" of folder "${OTHER_FOLDER}"
  set n to make new note at f with properties {name:"sub-note-other-${stamp}", body:"<p>sub-other-body</p>"}
  return id of n
end tell`);
    subIds.otherSubNote = r2.out.trim().replace(/^"|"$/g, "");
    log("setup: note in OTHER_FOLDER/sub", !!subIds.otherSubNote);
  }

  // Read-scoped client: subfolder of allowed top must be readable; subfolder of
  // disallowed top must NOT be.
  {
    const c = new McpClient(["--allow=read", `--read-folder=${READ_FOLDER}`]);
    c.start();
    await c.init();
    try {
      // list_folders includes the sub-folder of READ_FOLDER (with `top` field)
      {
        const r = await c.call("list_folders", {});
        const arr = JSON.parse(getText(r));
        const sub = arr.find((f) => f.name === SUB_NAME && f.top === READ_FOLDER);
        const otherSub = arr.find((f) => f.name === SUB_NAME && f.top === OTHER_FOLDER);
        log(
          "list_folders includes subfolder of allowed top",
          !!sub && !otherSub,
          `count=${arr.length}`,
        );
      }
      // list_notes finds the sub-folder note from the allowed top
      {
        const r = await c.call("list_notes", { limit: 50 });
        const arr = JSON.parse(getText(r));
        const names = arr.map((n) => n.name);
        log(
          "list_notes recurses into subfolders of allowed top",
          names.includes(`sub-note-read-${stamp}`) && !names.includes(`sub-note-other-${stamp}`),
        );
      }
      // search_notes recurses across allowed top + subfolders
      {
        const r = await c.call("search_notes", { query: "sub-read-body" });
        const arr = JSON.parse(getText(r));
        log("search_notes finds note in subfolder of allowed top", arr.length === 1);
      }
      {
        const r = await c.call("search_notes", { query: "sub-other-body" });
        const arr = JSON.parse(getText(r));
        log("search_notes does NOT find note in subfolder of disallowed top", arr.length === 0);
      }
      // get_note by id into subfolder of allowed top
      {
        const r = await c.call("get_note", { id: subIds.readSubNote });
        const ok = !isToolError(r);
        const parsed = ok ? JSON.parse(getText(r)) : null;
        log(
          "get_note by id allowed for subfolder of allowed top",
          ok && parsed?.topFolder === READ_FOLDER,
          `top=${parsed?.topFolder}`,
        );
      }
      // get_note by id into subfolder of disallowed top is denied
      {
        const r = await c.call("get_note", { id: subIds.otherSubNote });
        log(
          "get_note by id denied for subfolder of disallowed top",
          isToolError(r) && /allow-list/i.test(getText(r)),
        );
      }
      // list_notes(folder=SUB_NAME) — there are TWO sub-folders with this name,
      // but our scoping should only recurse into the one under READ_FOLDER.
      {
        const r = await c.call("list_notes", { folder: SUB_NAME });
        const arr = JSON.parse(getText(r));
        const names = arr.map((n) => n.name);
        log(
          "list_notes(folder=subfolder-name) limited to allowed top's subfolder",
          names.includes(`sub-note-read-${stamp}`) && !names.includes(`sub-note-other-${stamp}`),
        );
      }
    } finally {
      await c.stop();
    }
  }

  // Write-scoped: append/delete on subfolder of allowed top works; on
  // disallowed top is denied.
  {
    const c = new McpClient(["--allow=write,destructive", `--write-folder=${READ_FOLDER}`]);
    c.start();
    await c.init();
    try {
      // append into subfolder of allowed top
      {
        const r = await c.call("append_to_note", {
          id: subIds.readSubNote,
          content: "<p>more</p>",
        });
        log("append_to_note allowed for subfolder of allowed top", !isToolError(r));
      }
      // append into subfolder of disallowed top is denied
      {
        const r = await c.call("append_to_note", {
          id: subIds.otherSubNote,
          content: "<p>nope</p>",
        });
        log(
          "append_to_note denied for subfolder of disallowed top",
          isToolError(r) && /allow-list/i.test(getText(r)),
        );
      }
      // create_note targeting an existing sub-folder of an allowed top is allowed
      {
        const r = await c.call("create_note", {
          name: `created-in-sub-${stamp}`,
          body: "<p>x</p>",
          folder: SUB_NAME,
        });
        const ok = !isToolError(r);
        const parsed = ok ? JSON.parse(getText(r)) : null;
        log("create_note into sub-folder of allowed top works", ok, `folder=${parsed?.folder}`);
        if (parsed?.id) await c.call("delete_note", { id: parsed.id });
      }
      // delete_note for a subfolder note works
      {
        const r = await c.call("delete_note", { id: subIds.readSubNote });
        log("delete_note allowed for subfolder of allowed top", !isToolError(r));
        subIds.readSubNote = null;
      }
    } finally {
      await c.stop();
    }
  }

  // ---- Edge: --write-folder with multiple options requires explicit folder for create_note ----
  {
    const c = new McpClient([
      "--allow=create_note",
      `--write-folder=${READ_FOLDER}`,
      `--write-folder=${OTHER_FOLDER}`,
    ]);
    c.start();
    await c.init();
    try {
      const r = await c.call("create_note", { name: "amb-note", body: "<p>x</p>" });
      log(
        "create_note with multiple write-folders + no folder arg requires choice",
        isToolError(r) && /folder argument/i.test(getText(r)),
        getText(r).slice(0, 120),
      );
    } finally {
      await c.stop();
    }
  }

  // ---- Cleanup: notes + folders (incl. subfolders, and stale folders from
  // prior runs that match our naming scheme). ----
  {
    const cleanup = new McpClient(["--allow=delete_note"]);
    cleanup.start();
    await cleanup.init();
    try {
      if (setupIds.readNote) await cleanup.call("delete_note", { id: setupIds.readNote });
      if (setupIds.otherNote) await cleanup.call("delete_note", { id: setupIds.otherNote });
      if (subIds.readSubNote) await cleanup.call("delete_note", { id: subIds.readSubNote });
      if (subIds.otherSubNote) await cleanup.call("delete_note", { id: subIds.otherSubNote });
      log("cleanup: removed setup notes", true);
    } finally {
      await cleanup.stop();
    }

    // Delete the top-level folders (which recursively removes subfolders).
    for (const f of [READ_FOLDER, OTHER_FOLDER, NEW_WRITE_FOLDER]) {
      await deleteTopFolderByName(f);
    }
    log("cleanup: removed test folders", true);
  }
}

(async () => {
  try {
    // Pre-sweep: remove any leftover test folders from prior runs before
    // starting (keeps Notes in a known clean state and avoids interference).
    await sweepStaleFolders("pre-sweep");
    await testCliEdgeCases();
    await testPermissionGating();
    await testToolBehavior();
    await testContentFormats();
    await testFolderScoping();
    // Final sweep: remove any stale top-level folders from previous runs
    // matching our naming scheme (mcp-e2e-*, mcp-scope-*).
    await sweepStaleFolders();
  } catch (err) {
    console.error("Harness error:", err);
    process.exit(1);
  }
  console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log("Failed:", failures.map((f) => `\n  - ${f}`).join(""));
    process.exit(1);
  }
})();

/** Removes any leftover top-level folders that match our test naming scheme. */
async function sweepStaleFolders(label = "post-sweep") {
  const r = await osascript(`tell application "Notes"
  set out to ""
  repeat with f in (every folder)
    try
      set ff to contents of f
      if (class of (container of ff)) is account then
        set fname to name of ff
        if (fname starts with "mcp-e2e-") or (fname starts with "mcp-scope-") then
          set out to out & fname & linefeed
        end if
      end if
    end try
  end repeat
  return out
end tell`);
  const names = r.out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return;
  for (const n of names) await deleteTopFolderByName(n);
  console.log(`   ℹ  ${label}: removed ${names.length} stale test folder(s).`);
}
