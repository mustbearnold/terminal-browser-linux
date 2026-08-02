import assert from "node:assert/strict";
import test from "node:test";

import { promptTag, selectPeerPane } from "./workspace";
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

function pane(paneId: string, self = false, title = "agent"): Pane {
  return { window: "window-1", tab: "tab-1", pane: paneId, title, self };
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
