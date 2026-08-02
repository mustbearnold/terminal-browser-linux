# Agent platform

This directory is the browser-control platform boundary. It must remain usable without launching Electron so protocol, revision, locator, policy, and transport behavior can be tested as ordinary TypeScript.

Keep the wire protocol independent from CDP, Electron, terminal rendering, and any one agent client. Browser-specific behavior belongs behind adapter interfaces. Snapshot references are revision-scoped and stale references must fail explicitly.

Use `page.act` with `action.type` `focus` when an agent needs to establish focus as an explicit, verified state transition; the same action must work through fixture and live adapters across frames and shadow roots.

Use `page.active` when an agent needs to recover the currently focused semantic control; its result is revision-scoped and may be used as the next action target.

Emit and consume `focus.changed` as a resumable event instead of making agents poll generic DOM changes for focus state.

Cancel each `page.observe` subscription when its event stream is no longer needed; observation lifecycle is part of the agent contract.

Request only the event types an agent needs. Treat the page-bound observation cursor as the reconnect contract, replaying it with `page.observe.after` after transport loss. Replay counts describe delivered events after filtering, and closing a page releases any remaining subscriptions. Recover from `EVENT_GAP` with a fresh page snapshot.

Run `pnpm --filter terminal-browser-agent check` before handing off changes. Build the workspace packages before running a repository-wide typecheck when a package consumes generated declarations.
