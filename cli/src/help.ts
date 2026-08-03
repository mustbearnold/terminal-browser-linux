interface CommandHelp {
  summary: string;
  usage: string;
  body: string;
}

const COMMANDS: Record<string, CommandHelp> = {
  open: {
    summary: "Open the browser in a terminal pane",
    usage: "terminal-browser open [url] [direction] [options]",
    body: `
Opens the browser in the current pane. Pass a direction (right, left, down,
up) to open it in a new split pane instead.

The url can be a normal url, a localhost port, or a path to an html file.

Options:
  --size <fraction>   How much of the space the new pane takes (0.2 to 0.95)

Examples:
  terminal-browser open localhost:3000
  terminal-browser open ./report.html right
  terminal-browser open github.com/zenbu-labs down --size 0.4
`,
  },
  ls: {
    summary: "List running browsers and their tabs",
    usage: "terminal-browser ls [options]",
    body: `
Lists the browsers running in this terminal tab, each with its tabs. The tab
ids it prints are what --tab takes in terminal-browser action.

Options:
  --all               Every browser, not just this terminal tab
  --json              Machine readable, including cdp ports, pane ids, and readiness state

JSON state:
  ready               At least one tab has a CDP target and the browser has a debugging port
  loading             The active page is navigating; ready can remain true during navigation
`,
  },
  workspace: {
    summary: "Pair a browser pane with a coding-agent pane and attach DOM notes",
    usage: "terminal-browser workspace <open|attach|list|panes|close|note|notes|sync>",
    body: `
Manages an explicit browser-to-agent pane binding. Notes are stored against a
semantic DOM target and can be pasted into the attached agent prompt as a
compact @tb-* tag. Pasting never submits the prompt unless --commit is used.
Bindings remember the pane's title, working directory, foreground command, and
process identity when the terminal exposes one;
workspace list reconciles replacements and reports whether the agent pane is
attached, missing, or ambiguous. A stable binding fails closed rather than
silently sending a note to an unrelated shell. Sync remembers which annotation
tags reached the current pane, skips them on later syncs, and resets that ledger
when the binding moves to a replacement pane or the foreground agent process
restarts in place. Use --force to replay delivered notes or stale observations;
an explicit note replay always sends. Workspace commands serialize through a
short cross-process lock so concurrent syncs do not duplicate pending notes.
Stale refresh reuses an existing fresh descendant at the current revision
instead of creating duplicate annotations. Use --dry-run to report the tags that
would be sent without writing to the agent pane or changing its delivery ledger;
dry runs cannot combine with --refresh-stale because refresh creates annotations.

Commands:
  open [url] [direction] --agent-pane <pane-id> [--agent <kind>]
  open [url] [direction] --left [--agent <kind>]
  attach --browser <key> --pane <pane-id> [--agent <kind>] [--sync-notes] [--refresh-stale]
  attach --browser <key> --left [--agent <kind>] [--sync-notes] [--refresh-stale]
  open [url] [direction] --left [--agent <kind>] [--sync-notes] [--refresh-stale]
  list
  panes [--json]
  close --browser <key>
  notes --browser <key> [--page <page-id>]
  note --browser <key> (--annotation <id> | --target '<json>' | --at <x> <y>) [--note <text>] [--commit] [--force] [--refresh]
  sync --browser <key> [--page <page-id>] [--force | --refresh-stale | --dry-run]

Examples:
  terminal-browser workspace panes
  terminal-browser workspace open https://example.com right --agent-pane 3
  terminal-browser workspace attach --browser 90107-1 --pane 3 --agent claude
  terminal-browser workspace note --browser 90107-1 --target '{"locator":{"kind":"role","role":"button","name":"Save"}}' --note 'save control is unreliable'
  terminal-browser workspace note --browser 90107-1 --at 280 160 --note 'this card needs a clearer heading'
  terminal-browser workspace notes --browser 90107-1
  terminal-browser workspace note --browser 90107-1 --annotation annotation-1 --force
  terminal-browser workspace note --browser 90107-1 --annotation annotation-1 --refresh
  terminal-browser workspace sync --browser 90107-1
  terminal-browser workspace sync --browser 90107-1 --refresh-stale
  terminal-browser workspace sync --browser 90107-1 --dry-run
  terminal-browser workspace attach --browser 90107-1 --left --sync-notes
`,
  },
  setup: {
    summary: "Configure installed terminals so terminal-browser works best",
    usage: "terminal-browser setup",
    body: `
Finds the terminals on this machine and fixes any settings that would keep the
browser from drawing in them. Editors built on vscode ship with terminal images
switched off, so this turns "terminal.integrated.enableImages" on in each one.
`,
  },
  action: {
    summary: "Use the open browser through the agent-browser CLI",
    usage: "terminal-browser action [selectors] -- <command>",
    body: `
An agent-browser compatible CLI for the browser you already have open.
Everything after -- is an agent-browser command. With no selectors it targets
the browser in this terminal tab and that browser's active tab.
Actions wait briefly for a starting tab to expose its CDP target and for the
agent session to become usable.

Selectors:
  --browser <key>     A browser key from terminal-browser ls
  --tab <id>          A tab id from terminal-browser ls
  --target <id>       A CDP target id
  --follow            Bring the tab to the front before running the command

Examples:
  terminal-browser action -- snapshot
  terminal-browser action -- click @e14
  terminal-browser action -- eval "document.title"
  terminal-browser action --browser 90107-1 --tab 2 -- fill @e3 "hello"
`,
  },
  agent: {
    summary: "Connect a persistent JSON agent session to the open browser",
    usage: "terminal-browser agent [options]",
    body: `
Connects stdin and stdout to the selected terminal-browser agent socket. Each
line is one versioned JSON request or response.

Options:
  --browser <key>     A browser key from terminal-browser ls

Examples:
  terminal-browser agent --browser 90107-1
  printf '%s\\n' '{"kind":"request",...}' | terminal-browser agent
  `,
  },
  tools: {
    summary: "Expose discoverable structured agent tools",
    usage: "terminal-browser tools [options]",
    body: `
Connects to the selected browser and exposes the negotiated agent operations
as named tools. Pass --list to print the tool manifest. Without --list, read
one JSON tool request per line from stdin. Calls are concurrent: each first
returns an accepted line, then a correlated result or event line.
Streaming mode also reports connection lifecycle lines and performs one
reconnect attempt after transport loss; in-flight calls are not replayed.

Options:
  --browser <key>     A browser key from terminal-browser ls
  --list              Print the negotiated tool manifest and exit

Request shape:
  {"id":"1","name":"terminal_browser_page_snapshot","arguments":{},"deadlineMs":5000}
  {"id":"2","cancelRequestId":"page.wait-3"}
  {"kind":"control","id":"r1","op":"connection.reconnect"}
`,
  },
  mcp: {
    summary: "Expose browser tools through an MCP stdio server",
    usage: "terminal-browser mcp [options]",
    body: `
Connects to the selected browser and exposes the negotiated agent operations
through the Model Context Protocol over stdin/stdout. It supports the MCP
initialize lifecycle, tools/list, tools/call, cancellation, agent events, and
connection lifecycle notifications.
Hosts can request another recovery attempt with the namespaced method
terminal-browser/connection/reconnect.

Options:
  --browser <key>     A browser key from terminal-browser ls
`,
  },
};

function block(text: string): string {
  return `${text.trim()}\n`;
}

export function rootHelp(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = Object.entries(COMMANDS).map(
    ([name, help]) => `  ${name.padEnd(width)}  ${help.summary}`,
  );
  return block(`
Usage: terminal-browser [url] [direction]
       terminal-browser <command> [args]

${lines.join("\n")}

terminal-browser <command> --help for one command's options
`);
}

export function commandHelp(name: string): string | null {
  const help = COMMANDS[name];
  if (!help) return null;
  return block(`Usage: ${help.usage}\n${help.body}`);
}

export function helpTopics(): string[] {
  return Object.keys(COMMANDS);
}
