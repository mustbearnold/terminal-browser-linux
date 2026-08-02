import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRequestRouter } from "../core/router";
import { DurableAnnotationStore, MemoryAnnotationStore } from "../core/annotations";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  asDocumentId,
  asFrameId,
  asPageId,
  asSnapshotRef,
  type AgentRequest,
  type PageAnnotationView,
  type SnapshotNode,
} from "../protocol/types";
import { FixtureRuntime, FIXTURE_PAGE_ID } from "./fixture";

const pageId = asPageId("browser/tab/1");
const node: SnapshotNode = {
  ref: asSnapshotRef("ref-1"),
  frameId: asFrameId("main"),
  parent: null,
  role: "button",
  name: "Save",
  visible: true,
  enabled: true,
  focusable: true,
};

function annotationInput() {
  return {
    pageId,
    documentId: asDocumentId("document-1"),
    revision: 2,
    url: "https://example.com",
    title: "Example",
    target: { ref: node.ref },
    node,
    note: "The save control loses focus after a retry.",
  };
}

test("creates stable compact tags and keeps annotations scoped to a page", () => {
  const store = new MemoryAnnotationStore(() => "2026-08-03T00:00:00.000Z");
  const annotation = store.create(annotationInput());

  assert.equal(annotation.annotationId, "annotation-1");
  assert.equal(annotation.tag, "@tb-1");
  assert.equal(annotation.createdAt, "2026-08-03T00:00:00.000Z");
  assert.deepEqual(store.list(pageId), [annotation]);
  assert.equal(store.get(asPageId("other/tab/1"), annotation.annotationId), undefined);
  assert.equal(store.delete(asPageId("other/tab/1"), annotation.annotationId), false);
});

test("reloads and deletes durable annotations without reusing tags", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-annotations-"));
  const filePath = path.join(directory, "annotations.json");
  const first = new DurableAnnotationStore(filePath, 8, () => "2026-08-03T00:00:00.000Z");
  const created = first.create(annotationInput());

  const second = new DurableAnnotationStore(filePath, 8, () => "2026-08-03T00:00:01.000Z");
  assert.deepEqual(second.get(pageId, created.annotationId), created);
  assert.equal(second.delete(pageId, created.annotationId), true);
  const next = second.create(annotationInput());
  assert.equal(next.tag, "@tb-2");
});

test("routes annotation creation and reports stale revisions", async () => {
  const runtime = new FixtureRuntime();
  const router = new AgentRequestRouter(runtime);
  const created = await router.handle(request("page.annotation.create", {
    pageId: FIXTURE_PAGE_ID,
    target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } },
    note: "This is the control the agent should retry.",
  }));
  assert.equal(created.ok, true);
  const annotation = created.result as PageAnnotationView;
  assert.equal(annotation.tag, "@tb-1");
  assert.equal(annotation.stale, false);
  assert.equal(annotation.node.name, "Continue");

  const acted = await router.handle(request("page.act", {
    pageId: FIXTURE_PAGE_ID,
    action: { type: "click", target: { ref: annotation.node.ref } },
  }));
  assert.equal(acted.ok, true);

  const listed = await router.handle(request("page.annotation.list", { pageId: FIXTURE_PAGE_ID }));
  assert.equal(listed.ok, true);
  const annotations = (listed.result as { annotations: PageAnnotationView[] }).annotations;
  assert.equal(annotations[0].stale, true);
  assert.equal(annotations[0].currentRevision, 1);
});

function request<T extends AgentRequest["op"]>(op: T, fields: Record<string, unknown>): AgentRequest {
  return {
    kind: "request",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    requestId: `annotation-${op}`,
    op,
    ...fields,
  } as AgentRequest;
}
