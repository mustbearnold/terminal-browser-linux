import assert from "node:assert/strict";
import test from "node:test";

import { AgentError } from "../protocol/errors";
import {
  asDocumentId,
  asFrameId,
  asPageId,
  asSnapshotId,
  asSnapshotRef,
  type PageSnapshot,
} from "../protocol/types";
import { SnapshotLocatorResolver } from "../core/locator";

function snapshot(): PageSnapshot {
  const pageId = asPageId("page-1");
  return {
    pageId,
    documentId: asDocumentId("document-1"),
    snapshotId: asSnapshotId("snapshot-1"),
    revision: 0,
    url: "https://example.com",
    title: "Example",
    rootFrameId: asFrameId("frame-1"),
    truncated: false,
    nodes: [
      {
        ref: asSnapshotRef("r1"),
        frameId: asFrameId("frame-1"),
        parent: null,
        role: "button",
        name: "Continue",
        visible: true,
        enabled: true,
        focusable: true,
      },
      {
        ref: asSnapshotRef("r2"),
        frameId: asFrameId("frame-1"),
        parent: null,
        role: "link",
        name: "Continue",
        visible: true,
        enabled: true,
        focusable: true,
      },
    ],
  };
}

test("resolves an unambiguous semantic locator", () => {
  const result = new SnapshotLocatorResolver().resolve(
    { locator: { kind: "role", role: "button", name: "Continue" } },
    snapshot(),
  );
  assert.equal(result.ref, "r1");
});

test("normalizes whitespace and ignores hidden locator candidates", () => {
  const base = snapshot();
  const result = new SnapshotLocatorResolver().resolve(
    { locator: { kind: "role", role: "button", name: "  Continue\n  ", exact: true } },
    {
      nodes: [
        ...base.nodes,
        {
          ...base.nodes[0],
          ref: asSnapshotRef("hidden"),
          visible: false,
        },
      ],
    },
  );
  assert.equal(result.ref, "r1");
});

test("resolves hidden locator candidates only when requested", () => {
  const hidden = {
    ...snapshot().nodes[0],
    ref: asSnapshotRef("hidden"),
    name: "Hidden action",
    visible: false,
  };
  const target = { locator: { kind: "role" as const, role: "button", name: "Hidden action", exact: true } };
  assert.throws(
    () => new SnapshotLocatorResolver().resolve(target, { nodes: [hidden] }),
    (error: unknown) => error instanceof AgentError && error.code === "TARGET_NOT_FOUND",
  );
  const result = new SnapshotLocatorResolver().resolve(target, { nodes: [hidden] }, { includeHidden: true });
  assert.equal(result.ref, "hidden");
});

test("fails instead of guessing when a locator is ambiguous", () => {
  assert.throws(
    () =>
      new SnapshotLocatorResolver().resolve(
        { locator: { kind: "text", text: "Continue" } },
        snapshot(),
      ),
    (error: unknown) => error instanceof AgentError && error.code === "AMBIGUOUS_TARGET",
  );
});

test("requires a live resolver for CSS locators", () => {
  assert.throws(
    () => new SnapshotLocatorResolver().resolve(
      { locator: { kind: "css", value: "button" } },
      snapshot(),
    ),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_REQUEST",
  );
});
