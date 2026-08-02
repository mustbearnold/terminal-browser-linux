# Agent platform

This directory is the browser-control platform boundary. It must remain usable without launching Electron so protocol, revision, locator, policy, and transport behavior can be tested as ordinary TypeScript.

Keep the wire protocol independent from CDP, Electron, terminal rendering, and any one agent client. Browser-specific behavior belongs behind adapter interfaces. Snapshot references are revision-scoped and stale references must fail explicitly.

Use `page.act` with `action.type` `focus` when an agent needs to establish focus as an explicit, verified state transition; the same action must work through fixture and live adapters across frames and shadow roots.

Run `pnpm --filter terminal-browser-agent check` before handing off changes. Build the workspace packages before running a repository-wide typecheck when a package consumes generated declarations.
