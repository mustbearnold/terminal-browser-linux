Dependencies:
- cargo
- pnpm

Install dependencies and build the agent contract:
```
pnpm install
pnpm agent:check
```

The agent transport is a versioned JSON-lines session exposed through the
running browser. The CLI can bridge stdin/stdout to it:
```
terminal-browser agent --browser <browser-key>
```

For the browser-compatible control path:
```
pnpm agent:live-smoke
```

Native JavaScript dialogs arrive as `dialog` events with a pending `dialogId`.
Respond with `page.dialog` using `accept` or `dismiss`; prompt responses may
include `promptText` when the underlying browser supports prompts.

The default agent runtime keeps action deduplication and event history in
memory. Set `TERMINAL_BROWSER_AGENT_JOURNAL=/absolute/path/to/journal` to opt
into durable action outcomes and per-page event history.
