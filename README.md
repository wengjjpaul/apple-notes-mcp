# apple-notes-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets MCP-compatible clients (Claude Desktop, VS Code, Cursor, etc.) read and write **Apple Notes** on macOS via AppleScript.

- **macOS only** — uses `osascript` under the hood.
- **Permission-gated** — every tool is opt-in via `--allow`. Only the tools you enable are exposed to the model.
- **No install step** — run via `npx`.

## Tools

| Tool | Group | Description |
|---|---|---|
| `list_folders` | `read` | List all Notes folders. |
| `list_notes` | `read` | List notes (optionally in a folder). |
| `search_notes` | `read` | Full-text search by name or body. |
| `get_note` | `read` | Fetch a note's full HTML + plaintext. |
| `create_note` | `write` | Create a new note (optional folder; auto-creates the folder if missing). |
| `append_to_note` | `write` | Append HTML/text to an existing note. |
| `create_folder` | `write` | Create a new top-level folder. |
| `delete_note` | `destructive` | Delete a note (moves to Recently Deleted). |

`--allow` accepts groups (`read`, `write`, `destructive`, `all`) and/or individual tool names, comma-separated.

Examples:
```
--allow read
--allow read,create_note,append_to_note
--allow all
```

## Folder scoping (optional)

You can additionally restrict which **folders** the model can read from or write to. Both flags can be repeated (or comma-separated).

| Flag | Effect |
|---|---|
| `--read-folder <name>` | Restrict `list_notes`, `search_notes`, `get_note`, and `list_folders` to these folders. Omit = all folders. |
| `--write-folder <name>` | Restrict `create_note`, `append_to_note`, `create_folder`, and `delete_note` to these folders. **A `--write-folder` that doesn't exist yet is auto-created on the first `create_note`.** Omit = all folders. |

Examples:
```
# Read everything, but writes only land in "Agent Inbox" (auto-created if missing)
--allow all --write-folder "Agent Inbox"

# Read-only sandbox restricted to Work & Personal
--allow read --read-folder Work --read-folder Personal

# Two writable folders — model must pass `folder` arg explicitly
--allow write --write-folder Drafts --write-folder Published
```

Folder scoping is enforced server-side: even if the model passes a disallowed folder name (or an `id` of a note in a disallowed folder), the call is rejected before AppleScript runs.

**Subfolders inherit from their top-level parent.** Allow-list values name **top-level folders only**. All sub-folders nested beneath an allowed top-level folder are automatically included — both for reads (listed/searched/fetched) and writes (notes inside any descendant can be modified, and you may pass a sub-folder name as the `folder` argument). Folders inside a disallowed top-level remain blocked even if they share a name with a permitted sub-folder.

## Install for an MCP client

You don't need to clone this repo. Add one of the snippets below to your client's MCP config and it will be fetched and run via `npx` on demand.

### VS Code (`.vscode/mcp.json` or user `mcp.json`)

```jsonc
{
  "servers": {
    "apple-notes": {
      "command": "npx",
      "args": ["-y", "@wengjjpaul/apple-notes-mcp", "--allow", "read"]
    }
  }
}
```

### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```jsonc
{
  "mcpServers": {
    "apple-notes": {
      "command": "npx",
      "args": ["-y", "@wengjjpaul/apple-notes-mcp", "--allow", "read,create_note,append_to_note"]
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json`)

```jsonc
{
  "mcpServers": {
    "apple-notes": {
      "command": "npx",
      "args": ["-y", "@wengjjpaul/apple-notes-mcp", "--allow", "all"]
    }
  }
}
```

### Sandboxed example: agent can only write into a single folder

```jsonc
{
  "mcpServers": {
    "apple-notes-agent": {
      "command": "npx",
      "args": [
        "-y", "@wengjjpaul/apple-notes-mcp",
        "--allow", "all",
        "--write-folder", "Agent Inbox"
      ]
    }
  }
}
```

The folder `Agent Inbox` is auto-created the first time the agent calls `create_note`.

After saving the config, restart the client. The first time the server runs, macOS will prompt you to grant the calling app (Claude/VS Code/etc.) permission to control **Notes** under  **System Settings → Privacy & Security → Automation**. Approve it.

## Install instructions for an AI agent

> Copy the block below into your conversation with an agent that can edit files.

```
Install the apple-notes-mcp MCP server.

1. Open the user's MCP config file for their client:
   - VS Code:        .vscode/mcp.json (workspace) OR ~/Library/Application Support/Code/User/mcp.json
   - Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json
   - Cursor:         ~/.cursor/mcp.json
2. Merge this server entry into the existing JSON (create the file with `{ "mcpServers": {} }` if missing):

   {
     "mcpServers": {
       "apple-notes": {
         "command": "npx",
         "args": ["-y", "@wengjjpaul/apple-notes-mcp", "--allow", "read"]
       }
     }
   }

   Replace the value of "--allow" with the permissions the user wants:
     - "read"        → list_folders, list_notes, search_notes, get_note
     - "write"       → read + create_note, append_to_note, create_folder
     - "destructive" → delete_note
     - "all"         → everything
     - Or a comma-separated list of specific tool names.

3. Tell the user to restart the MCP client and approve the macOS Automation
   prompt for "Notes" the first time the server runs.
```

## Local development

```bash
git clone https://github.com/wengjjpaul/apple-notes-mcp.git
cd apple-notes-mcp
npm install
npm run build
```

Point your MCP client at the local build:

```jsonc
{
  "mcpServers": {
    "apple-notes-dev": {
      "command": "node",
      "args": ["/absolute/path/to/apple-notes-mcp/dist/index.js", "--allow", "all"]
    }
  }
}
```

Or quick-test the protocol from a shell:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/index.js --allow=read
```

## Security notes

- Tools that aren't included in `--allow` are **not registered** with the server, so the model cannot call them — this is enforced server-side, not just via descriptions.
- AppleScript runs as the current user and can access whatever Notes data that user can see. Treat `delete_note` and write tools accordingly.
- The server only speaks JSON-RPC over stdio. It never opens a network port.

## License

MIT
