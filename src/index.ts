#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ALL_TOOLS,
  parseAllowList,
  type PermissionContext,
  type ToolName,
  type WriteFolderEntry,
} from "./permissions.js";
import { TOOLS } from "./tools.js";

interface CliArgs {
  allow: string[];
  readFolders: string[];
  writeFolderEntries: WriteFolderEntry[];
  help: boolean;
}

/** Parse "Account/FolderName" or plain "FolderName" into a WriteFolderEntry. */
function parseWriteFolderEntry(raw: string): WriteFolderEntry {
  const slashIdx = raw.indexOf("/");
  if (slashIdx > 0) {
    return { account: raw.slice(0, slashIdx).trim(), folder: raw.slice(slashIdx + 1).trim() };
  }
  return { folder: raw };
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { allow: [], readFolders: [], writeFolderEntries: [], help: false };
  const takeValue = (flag: string, i: number): [string, number] => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return [v, i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--allow") {
      const [v, ni] = takeValue("--allow", i);
      args.allow.push(v);
      i = ni;
    } else if (a.startsWith("--allow=")) {
      args.allow.push(a.slice("--allow=".length));
    } else if (a === "--read-folder") {
      const [v, ni] = takeValue("--read-folder", i);
      args.readFolders.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
      i = ni;
    } else if (a.startsWith("--read-folder=")) {
      args.readFolders.push(
        ...a.slice("--read-folder=".length).split(",").map((s) => s.trim()).filter(Boolean),
      );
    } else if (a === "--write-folder") {
      const [v, ni] = takeValue("--write-folder", i);
      args.writeFolderEntries.push(...v.split(",").map((s) => s.trim()).filter(Boolean).map(parseWriteFolderEntry));
      i = ni;
    } else if (a.startsWith("--write-folder=")) {
      args.writeFolderEntries.push(
        ...a.slice("--write-folder=".length).split(",").map((s) => s.trim()).filter(Boolean).map(parseWriteFolderEntry),
      );
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stderr.write(
    `apple-notes-mcp — MCP server for Apple Notes (macOS)

Usage:
  apple-notes-mcp --allow <tools> [--read-folder <name>...] [--write-folder <name>...]

Tool permissions
  --allow <list>          Comma-separated list of tools/groups to expose.
                          Groups: all, read, write, destructive
                          Tools:  ${ALL_TOOLS.join(", ")}
                          May be repeated.

Folder scoping (optional; each may be repeated or comma-separated)
  --read-folder <name>    Restrict read tools (list_notes, search_notes,
                          get_note) to these folders. Default: all folders.
  --write-folder <name>   Restrict write tools (create_note, append_to_note,
                          create_folder, delete_note) to these folders.
                          A folder named here that doesn't exist yet will be
                          auto-created on first create_note. Default: all.

Examples:
  apple-notes-mcp --allow read
  apple-notes-mcp --allow read --read-folder Work --read-folder Personal
  apple-notes-mcp --allow write --write-folder "Agent Inbox"
  apple-notes-mcp --allow all --read-folder Work --write-folder "Agent Inbox"
`,
  );
}

async function main(): Promise<void> {
  let cli: CliArgs;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n\n`);
    printHelp();
    process.exit(2);
  }

  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  const allowed = (() => {
    try {
      return parseAllowList(cli.allow);
    } catch (err) {
      process.stderr.write(`Error: ${(err as Error).message}\n\n`);
      printHelp();
      process.exit(2);
    }
  })();
  if (allowed.size === 0) {
    process.stderr.write(
      "Error: no tools enabled. Pass --allow with at least one tool or group (e.g. --allow read).\n\n",
    );
    printHelp();
    process.exit(2);
  }

  const writeFolders = cli.writeFolderEntries.map((e) => e.folder);
  const ctx: PermissionContext = {
    tools: allowed,
    folders: {
      readFolders: cli.readFolders,
      writeFolders,
      writeFolderEntries: cli.writeFolderEntries,
    },
  };

  const server = new McpServer(
    { name: "apple-notes-mcp", version: "0.1.0" },
    {
      instructions:
        "Tools to manage Apple Notes on macOS via AppleScript. Only tools enabled by the user's --allow flag are available, and folder scope (if set) is enforced server-side.",
    },
  );

  for (const name of allowed) {
    const def = TOOLS[name as ToolName];
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: (def.inputSchema as any).shape ?? (def.inputSchema as any)._def?.schema?.shape ?? def.inputSchema,
      },
      async (args: unknown) => {
        try {
          const text = await def.handler(args ?? {}, ctx);
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
            isError: true,
          };
        }
      },
    );
  }

  const scopeMsg =
    (ctx.folders.readFolders.length ? ` read-folders=[${ctx.folders.readFolders.join(",")}]` : "") +
    (ctx.folders.writeFolderEntries.length
      ? ` write-folders=[${ctx.folders.writeFolderEntries.map((e) => e.account ? `${e.account}/${e.folder}` : e.folder).join(",")}]`
      : "");
  process.stderr.write(
    `apple-notes-mcp ready. Enabled tools: ${[...allowed].join(", ")}${scopeMsg}\n`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).stack ?? (err as Error).message}\n`);
  process.exit(1);
});
