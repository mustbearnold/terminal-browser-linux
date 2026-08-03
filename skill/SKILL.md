---
name: terminal-browser
description: A real browser running inside the terminal. It splits the human's terminal pane automatically, so you can show a website side by side with the conversation, render HTML to visualize something, and drive whatever tab is open — snapshot, click, fill, eval — with the `terminal-browser action` subcommand.
---

`terminal-browser open <url>` puts a browser in a terminal pane. With no
direction it takes over the current pane. A direction word (`right`, `down`,
`left`, `up`) opens a new pane beside the human, which is how you show a page
next to the conversation. A path to a local html file works the same as a url,
so writing a page and opening it is a way to show something you built.

`terminal-browser ls` shows the browsers and tabs in this terminal tab, with the
tab ids the other commands take.

`terminal-browser action -- <command>` is an agent-browser compatible CLI for a
tab that is already open. It targets this terminal tab's browser and its active
tab unless you select another one.

## Command reference

```
$ terminal-browser help
Usage: terminal-browser [url] [direction]
       terminal-browser <command> [args]

  open       Open the browser in a terminal pane
  ls         List running browsers and their tabs
  workspace  Pair a browser pane with a coding-agent pane and attach DOM notes
  setup      Configure installed terminals so terminal-browser works best
  action     Use the open browser through the agent-browser CLI
  agent      Connect a persistent JSON agent session to the open browser
  tools      Expose discoverable structured agent tools
  mcp        Expose browser tools through an MCP stdio server

terminal-browser <command> --help for one command's options
```

```
$ terminal-browser open --help
Usage: terminal-browser open [url] [direction] [options]

Opens the browser in the current pane. Pass a direction (right, left, down,
up) to open it in a new split pane instead.

The url can be a normal url, a localhost port, or a path to an html file.

Options:
  --size <fraction>   How much of the space the new pane takes (0.2 to 0.95)

Examples:
  terminal-browser open localhost:3000
  terminal-browser open ./report.html right
  terminal-browser open github.com/zenbu-labs down --size 0.4
```

```
$ terminal-browser ls --help
Usage: terminal-browser ls [options]

Lists the browsers running in this terminal tab, each with its tabs. The tab
ids it prints are what --tab takes in terminal-browser action.

Options:
  --all               Every browser, not just this terminal tab
  --json              Machine readable, including cdp ports and pane ids
```

```
$ terminal-browser workspace --help
Usage: terminal-browser workspace <open|attach|list|panes|close|note|notes>

Manages an explicit browser-to-agent pane binding. Notes are stored against a
semantic DOM target and can be pasted into the attached agent prompt as a
compact @tb-* tag. Pasting never submits the prompt unless --commit is used.
Bindings remember the pane's title, working directory, and foreground command;
workspace list reconciles replacements and reports whether the agent pane is
attached, missing, or ambiguous. A stable binding fails closed rather than
silently sending a note to an unrelated shell.

Commands:
  open [url] [direction] --agent-pane <pane-id> [--agent <kind>]
  open [url] [direction] --left [--agent <kind>]
  attach --browser <key> --pane <pane-id> [--agent <kind>]
  attach --browser <key> --left [--agent <kind>]
  list
  panes [--json]
  close --browser <key>
  notes --browser <key> [--page <page-id>]
  note --browser <key> (--annotation <id> | --target '<json>' | --at <x> <y>) [--note <text>] [--commit] [--force]

Examples:
  terminal-browser workspace panes
  terminal-browser workspace open https://example.com right --agent-pane 3
  terminal-browser workspace attach --browser 90107-1 --pane 3 --agent claude
  terminal-browser workspace note --browser 90107-1 --target '{"locator":{"kind":"role","role":"button","name":"Save"}}' --note 'save control is unreliable'
  terminal-browser workspace note --browser 90107-1 --at 280 160 --note 'this card needs a clearer heading'
  terminal-browser workspace notes --browser 90107-1
  terminal-browser workspace note --browser 90107-1 --annotation annotation-1 --force
```

```
$ terminal-browser setup --help
Usage: terminal-browser setup

Finds the terminals on this machine and fixes any settings that would keep the
browser from drawing in them. Editors built on vscode ship with terminal images
switched off, so this turns "terminal.integrated.enableImages" on in each one.
```

```
$ terminal-browser action --help
Usage: terminal-browser action [selectors] -- <command>

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
```

```
$ terminal-browser agent --help
Usage: terminal-browser agent [options]

Connects stdin and stdout to the selected terminal-browser agent socket. Each
line is one versioned JSON request or response.

Options:
  --browser <key>     A browser key from terminal-browser ls

Examples:
  terminal-browser agent --browser 90107-1
  printf '%s\n' '{"kind":"request",...}' | terminal-browser agent
```

```
$ terminal-browser tools --help
Usage: terminal-browser tools [options]

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
```

```
$ terminal-browser mcp --help
Usage: terminal-browser mcp [options]

Connects to the selected browser and exposes the negotiated agent operations
through the Model Context Protocol over stdin/stdout. It supports the MCP
initialize lifecycle, tools/list, tools/call, cancellation, agent events, and
connection lifecycle notifications.
Hosts can request another recovery attempt with the namespaced method
terminal-browser/connection/reconnect.

Options:
  --browser <key>     A browser key from terminal-browser ls
```
