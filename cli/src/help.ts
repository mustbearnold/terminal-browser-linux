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
  --json              Machine readable, including cdp ports and pane ids
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

Options:
  --browser <key>     A browser key from terminal-browser ls
  --list              Print the negotiated tool manifest and exit

Request shape:
  {"id":"1","name":"terminal_browser_page_snapshot","arguments":{},"deadlineMs":5000}
  {"id":"2","cancelRequestId":"page.wait-3"}
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
