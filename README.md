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

The default connection budget is 128 in-flight requests. When that budget is
reached, the agent returns retryable `RESOURCE_EXHAUSTED` errors; cancellation
requests remain available so an agent can release capacity deliberately.

For MCP-compatible agent hosts, expose the same negotiated tools over stdio:
```
terminal-browser mcp --browser <browser-key>
```

For line-oriented named tool calls without an MCP host:
```
terminal-browser tools --browser <browser-key> --list
```

For the browser-compatible control path:
```
pnpm agent:live-smoke
```

Native JavaScript dialogs arrive as `dialog` events with a pending `dialogId`.
Respond with `page.dialog` using `accept` or `dismiss`; prompt responses may
include `promptText` when the underlying browser supports prompts.

Subscribe to `focus.changed` when an agent needs to react to focus transitions.
Each event includes the affected frame, that frame's new DOM revision, and
whether the transition entered or left focus; call `page.active` to recover the
current page revision-bound control.

`page.observe` returns a page-bound `cursor` and a `subscriptionId`; pass the
cursor as `after` when reconnecting so events missed during transport loss are
replayed. Use `page.observe.cancel` when the event stream is no longer needed
so a long-lived connection does not accumulate listeners. Replay counts and
delivery are limited to the requested event types, and closing a page releases
its remaining subscriptions. If the cursor falls outside retained history,
recover with a fresh page snapshot before observing again.

Use `page.wait` with an `element` condition to wait on semantic state such as
`attached`, `visible`, `enabled`, `disabled`, `focused`, `value`, `checked`,
`expanded`, `invalid`, `pressed`, `readOnly`, `required`, `selected`, or `text`.
Hidden existing elements remain addressable for visibility transitions, and a
targeted `text` condition checks the matched node's text rather than presence alone.

Actions return a full post-action snapshot by default. Set `output.snapshot` to
`none` to keep only the verified action result, or to `delta` with an
`output.base` snapshot token to receive only the changes from that snapshot.
Even without a snapshot, action proof includes the page document and revision;
targeted actions also include the resolved frame ID.
Use `expect.element` for target-specific post-action verification; its optional
state uses the same semantic fields as `page.wait`.

Use `page.act.batch` for a short sequence of dependent actions. Steps execute
serially against the live page, stop on the first unverified result, return a
proof for every step, and emit one final snapshot or delta instead of one per
action. An `idempotencyKey` makes the whole sequence safely replayable.

Successful waits return a full snapshot by default as well. Set
`output.snapshot` to `none` for a compact satisfaction result, or to `delta`
with an `output.base` snapshot token when the changed page state is needed.

For large pages, use `page.snapshot.window` with a bounded `limit`. The first
window reports `totalNodes` and a revision-bound `nextCursor`; send that cursor
alone to continue without transferring one oversized snapshot. A cursor becomes
stale when the page changes, so the agent can restart from a fresh window. Refs
returned by any window can be passed to `page.act` with that window's token;
the live backend resolves the ref directly instead of rebuilding only the
default snapshot prefix.

Locator failures include bounded candidate summaries, hidden-candidate counts,
and whether the snapshot was truncated so an agent can recover without blindly
repeating the same lookup.

Use `page.query` when a locator is expected to match several controls. It reads
the live DOM at one revision, returns a bounded candidate set plus total and
hidden-match counts, and gives each returned ref a token that can be passed to
the next action. Pass `options.frameId` from `page.frames` when the locator
should search only one frame.

Use `page.query.batch` when several locator result sets are needed. It evaluates
up to 32 bounded queries against one revision and returns one shared token, so
an agent can inspect related controls without separate round trips or mixed
page state. Each query can independently use `options.frameId` for precise
cross-frame matching. In the live Electron backend, queries in one batch share
frame discovery, DOM traversal, and captured-node work. Live result nodes retain
composed DOM parent refs, including shadow-root hosts, for local context without
requiring a full snapshot.

Pass `options.diagnostics: "summary"` when an agent needs bounded search
telemetry. The result reports whether matching used the live DOM or snapshot
fallback, plus frames searched, shadow roots searched, and elements scanned. It
also includes per-query entries with the number of candidate elements evaluated
and visible or hidden matches found. A `cacheHit` entry means the same locator
was reused safely within the current page revision and frame tree; cache hits
have no new traversal cost. In a query batch those shared search counts are not
additive per query. `planCacheHits` counts selector and nested-ancestor matcher
work reused within this batch; each entry's `index` identifies the requested
query, and entries are returned only for queries that requested diagnostics.
`elementIndexHits` and `elementIndexRebuilds` show whether the live backend
reused its per-frame element index or conservatively rebuilt it after a
structural DOM mutation.

Use `page.read` when one control is expected. The result contains the node plus
the document, revision, and read token that prove which page state was observed;
that token can be passed to the next action to reject a changed page.
When a locator is intentionally broad, pass its zero-based `index` and optionally
the candidate `frameId` from `page.query` to select one match deterministically.
Locators can also include a recursive `within` locator to scope a match to an
ancestor, such as a button within a named row or dialog. Scope depth is bounded
so malformed agent requests cannot turn DOM matching into unbounded work.

Use `page.active` to read the currently focused semantic control without guessing
its locator. The result carries a revision-bound ref and node, including the frame
or shadow-root context; when focus is only on the document body, it returns
`active: false` with no target.

Locators can also include state predicates such as `visible`, `enabled`,
`focused`, `checked`, `expanded`, `selected`, `value`, and related semantic
state, allowing an agent to select the current control without a second
wait/read round trip. Use `includeHidden` when intentionally querying invisible
state.

Keyboard actions can optionally include a `target`. Targeted `type` and `press`
actions focus and verify that element before dispatching input, so they do not
depend on ambient focus; omitting the target keeps the compact active-element
path.

Use `page.act` with `action.type: "focus"` when focus itself is the intended
state transition. The action resolves and verifies a visible focusable control
and returns `proof.focused: true`, including for controls inside frames and
shadow roots.

Use `page.act` with `action.type: "drag"` and semantic `source` and `target`
references for native drag-and-drop. The live adapter resolves both elements,
scrolls them into reach, sends a bounded native pointer path through Chromium,
and returns proof for both references. The source and drop target must be
reachable in the same viewport; a stale or occluded endpoint is rejected.

In the live Electron runtime, semantic and CSS locators used by `page.read`,
`page.act`, `page.wait`, and post-action expectations search the current DOM
directly across frames and shadow roots. This keeps locator and text search
independent of the first snapshot's node cap; ambiguous matches fail with
bounded diagnostics instead of being guessed. Global text waits reuse the same
per-frame element index as live locators and rebuild it when the DOM structure
changes, including shadow roots attached after the index is warm. Exact `testid`
and simple `#id` CSS locators use stable lookup buckets
when available; complex selectors and semantic text retain the conservative
full-index fallback.
Role locators also narrow through mutation-aware role buckets before applying
accessible-name and state matching. Exact role names use a second mutation-aware
bucket, so large same-role populations do not require repeated name evaluation.
Results carrying volatile form state are deliberately re-evaluated instead of
being reused from the host cache, covering silent `value`, `checked`, and
`selected` property changes that do not produce DOM mutations. The live page
state also invalidates its role/name index when native form setters change an
accessible name, such as an `input[type=button]` value.

Set `expect.quietMs` when a verified post-action state must remain unchanged for
that revision interval before the action is reported complete.

The default agent runtime keeps action deduplication and event history in
memory. Set `TERMINAL_BROWSER_AGENT_JOURNAL=/absolute/path/to/journal` to opt
into durable action outcomes and per-page event history.
