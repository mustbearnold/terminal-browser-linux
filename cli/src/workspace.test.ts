import assert from "node:assert/strict";
import test from "node:test";

import { promptTag, resolveAgentPane, selectPeerPane } from "./workspace";
import type { PageAnnotation } from "terminal-browser-agent";
import type { Pane } from "pixel-terminals";

test("formats a compact annotation tag without submitting by default", () => {
  const annotation = {
    annotationId: "annotation-7",
    tag: "@tb-7",
    pageId: "browser/tab/1",
    documentId: "document-1",
    revision: 4,
    url: "https://example.com/settings",
    title: "Settings",
    target: { locator: { kind: "role", role: "button", name: "Save" } },
    node: {
      ref: "ref-7",
      frameId: "main",
      parent: null,
      role: "button",
      name: "Save",
      visible: true,
      enabled: true,
      focusable: true,
    },
    note: "  save\ncontrol   loses focus  ",
    createdAt: "2026-08-03T00:00:00.000Z",
  } as unknown as PageAnnotation;

  assert.equal(
    promptTag(annotation),
    '@tb-7 page=browser/tab/1 url=https://example.com/settings target={"locator":{"kind":"role","role":"button","name":"Save"}} note=save control loses focus',
  );
  assert.equal(promptTag(annotation, true).endsWith("\n"), true);
});

function pane(
  paneId: string,
  self = false,
  title = "agent",
  metadata: Pick<Pane, "cwd" | "command"> = {},
): Pane {
  return { window: "window-1", tab: "tab-1", pane: paneId, title, self, ...metadata };
}

test("--left prefers the one non-self peer when the command shell is also present", () => {
  assert.equal(
    selectPeerPane([
      pane("shell", true, "shell"),
      pane("agent", false, "claude"),
      pane("browser", false, "terminal-browser:browser-1"),
    ], "browser"),
    "agent",
  );
});

test("--left can attach the only peer when the command runs in the agent pane", () => {
  assert.equal(
    selectPeerPane([
      pane("agent", true, "claude"),
      pane("browser", false, "terminal-browser:browser-1"),
    ], "browser"),
    "agent",
  );
});

test("--left keeps rejecting genuinely ambiguous peers", () => {
  assert.throws(
    () => selectPeerPane([
      pane("shell", true, "shell"),
      pane("agent-1", false, "claude"),
      pane("agent-2", false, "codex"),
      pane("browser", false, "terminal-browser:browser-1"),
    ], "browser"),
    /--left found 2 possible agent panes/,
  );
});

test("workspace binding keeps its direct pane when it is still present", () => {
  assert.equal(
    resolveAgentPane([
      pane("shell", true, "shell"),
      pane("agent", false, "claude"),
      pane("browser", false, "terminal-browser:browser-1"),
    ], "browser", {
      browserKey: "browser-1",
      agentPaneId: "agent",
      agentKind: "claude",
      agentPaneWindow: "window-1",
      agentPaneTab: "tab-1",
      agentPaneTitle: "claude",
      updatedAt: "2026-08-03T00:00:00.000Z",
    }),
    "agent",
  );
});

test("workspace binding falls back to the only peer after its pane is replaced", () => {
  assert.equal(
    resolveAgentPane([
      pane("shell", true, "shell"),
      pane("replacement", false, "new-agent"),
      pane("browser", false, "terminal-browser:browser-1"),
    ], "browser", {
      browserKey: "browser-1",
      agentPaneId: "closed-agent",
      agentKind: "claude",
      updatedAt: "2026-08-03T00:00:00.000Z",
    }),
    "replacement",
  );
});

test("workspace binding uses its pane fingerprint when several peers remain", () => {
  assert.equal(
    resolveAgentPane([
      pane("shell", true, "shell"),
      pane("replacement-codex", false, "codex"),
      pane("replacement-claude", false, "claude"),
      pane("browser", false, "terminal-browser:browser-1"),
    ], "browser", {
      browserKey: "browser-1",
      agentPaneId: "closed-agent",
      agentKind: "claude",
      agentPaneWindow: "window-1",
      agentPaneTab: "tab-1",
      agentPaneTitle: "claude",
      updatedAt: "2026-08-03T00:00:00.000Z",
    }),
    "replacement-claude",
  );
});

test("workspace binding keeps rejecting ambiguous replacements", () => {
  assert.throws(
    () => resolveAgentPane([
      pane("shell", true, "shell"),
      pane("replacement-1", false, "codex"),
      pane("replacement-2", false, "claude"),
      pane("browser", false, "terminal-browser:browser-1"),
    ], "browser", {
      browserKey: "browser-1",
      agentPaneId: "closed-agent",
      agentKind: "claude",
      updatedAt: "2026-08-03T00:00:00.000Z",
    }),
    /--left found 2 possible agent panes/,
  );
});

test("workspace binding recovers a replacement in another tab by stable identity", () => {
  assert.equal(
    resolveAgentPane([
      pane("shell", true, "shell"),
      pane("replacement", false, "claude", { cwd: "/work/project", command: "claude" }),
      { ...pane("browser", false, "terminal-browser:browser-1"), window: "window-2", tab: "tab-2" },
    ], "browser", {
      browserKey: "browser-1",
      agentPaneId: "closed-agent",
      agentKind: "claude",
      agentPaneWindow: "window-1",
      agentPaneTab: "tab-1",
      agentPaneTitle: "claude",
      agentPaneCwd: "/work/project",
      agentPaneCommand: "claude",
      updatedAt: "2026-08-03T00:00:00.000Z",
    }),
    "replacement",
  );
});

test("workspace binding recovers by cwd and command when the title changes", () => {
  assert.equal(
    resolveAgentPane([
      pane("replacement", false, "Claude — project", { cwd: "/work/project", command: "claude" }),
      pane("other", false, "Claude — other", { cwd: "/work/other", command: "claude" }),
      pane("browser", false, "terminal-browser:browser-1"),
    ], "browser", {
      browserKey: "browser-1",
      agentPaneId: "closed-agent",
      agentKind: "claude",
      agentPaneCwd: "/work/project",
      agentPaneCommand: "claude",
      updatedAt: "2026-08-03T00:00:00.000Z",
    }),
    "replacement",
  );
});

test("workspace binding rejects ambiguous stable identities across terminal topology", () => {
  assert.throws(
    () => resolveAgentPane([
      pane("replacement-1", false, "agent", { cwd: "/work/project", command: "claude" }),
      { ...pane("replacement-2", false, "agent", { cwd: "/work/project", command: "claude" }), window: "window-2", tab: "tab-2" },
      pane("browser", false, "terminal-browser:browser-1"),
    ], "browser", {
      browserKey: "browser-1",
      agentPaneId: "closed-agent",
      agentKind: "claude",
      agentPaneCwd: "/work/project",
      agentPaneCommand: "claude",
      updatedAt: "2026-08-03T00:00:00.000Z",
    }),
    /workspace binding matches 2 terminal panes/,
  );
});
