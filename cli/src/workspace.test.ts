import assert from "node:assert/strict";
import test from "node:test";

import { promptTag } from "./workspace";
import type { PageAnnotation } from "terminal-browser-agent";

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
