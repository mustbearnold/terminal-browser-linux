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

Use `page.wait` with an `element` condition to wait on semantic state such as
`attached`, `visible`, `enabled`, `disabled`, `focused`, `value`, `checked`,
`expanded`, `invalid`, `pressed`, `readOnly`, `required`, `selected`, or `text`.
Hidden existing elements remain addressable for visibility transitions, and a
targeted `text` condition checks the matched node's text rather than presence alone.

Actions return a full post-action snapshot by default. Set `output.snapshot` to
`none` to keep only the verified action result, or to `delta` with an
`output.base` snapshot token to receive only the changes from that snapshot.
Use `expect.element` for target-specific post-action verification; its optional
state uses the same semantic fields as `page.wait`.

The default agent runtime keeps action deduplication and event history in
memory. Set `TERMINAL_BROWSER_AGENT_JOURNAL=/absolute/path/to/journal` to opt
into durable action outcomes and per-page event history.
