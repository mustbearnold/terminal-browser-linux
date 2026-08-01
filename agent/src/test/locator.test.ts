import assert from "node:assert/strict";
import test from "node:test";

import { AgentError } from "../protocol/errors";
import { matchesWaitElementState } from "../core/element-state";
import {
  asDocumentId,
  asFrameId,
  asPageId,
  asSnapshotId,
  asSnapshotRef,
  type PageSnapshot,
} from "../protocol/types";
import { querySnapshot, SnapshotLocatorResolver } from "../core/locator";

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

test("resolves a semantic locator within its matching ancestor", () => {
  const base = snapshot();
  const primary = {
    ref: asSnapshotRef("region-primary"),
    frameId: asFrameId("frame-1"),
    parent: null,
    role: "region",
    name: "Primary card",
    visible: true,
    enabled: true,
    focusable: false,
  };
  const secondary = { ...primary, ref: asSnapshotRef("region-secondary"), name: "Secondary card" };
  const primaryButton = {
    ...base.nodes[0],
    ref: asSnapshotRef("primary-button"),
    parent: primary.ref,
  };
  const secondaryButton = {
    ...base.nodes[0],
    ref: asSnapshotRef("secondary-button"),
    parent: secondary.ref,
  };
  const scoped = {
    locator: {
      kind: "role" as const,
      role: "button",
      name: "Continue",
      exact: true,
      within: { kind: "role" as const, role: "region", name: "Primary card", exact: true },
    },
  };
  const nodes = [primary, secondary, primaryButton, secondaryButton];
  const resolved = new SnapshotLocatorResolver().resolve(scoped, { nodes });
  assert.equal(resolved.ref, primaryButton.ref);
  const queried = querySnapshot(scoped.locator, { nodes });
  assert.deepEqual(queried.candidates.map((node) => node.ref), [primaryButton.ref]);
  assert.equal(queried.candidateCount, 1);
});

test("selects an indexed locator match within a frame", () => {
  const base = snapshot();
  const sameFrame = { ...base.nodes[0], ref: asSnapshotRef("r3") };
  const otherFrame = { ...base.nodes[0], ref: asSnapshotRef("r4"), frameId: asFrameId("frame-2") };
  const resolver = new SnapshotLocatorResolver();

  const sameFrameResult = resolver.resolve(
    {
      locator: { kind: "role", role: "button", name: "Continue", exact: true },
      index: 1,
      frameId: asFrameId("frame-1"),
    },
    { nodes: [...base.nodes, sameFrame, otherFrame] },
  );
  assert.equal(sameFrameResult.ref, "r3");

  const otherFrameResult = resolver.resolve(
    {
      locator: { kind: "role", role: "button", name: "Continue", exact: true },
      index: 0,
      frameId: asFrameId("frame-2"),
    },
    { nodes: [...base.nodes, sameFrame, otherFrame] },
  );
  assert.equal(otherFrameResult.ref, "r4");
});

test("reports the selector when an indexed locator match is missing", () => {
  let error: AgentError | undefined;
  assert.throws(
    () => new SnapshotLocatorResolver().resolve(
      {
        locator: { kind: "role", role: "button", name: "Continue", exact: true },
        index: 2,
        frameId: asFrameId("frame-1"),
      },
      snapshot(),
    ),
    (candidate: unknown) => {
      error = candidate instanceof AgentError ? candidate : undefined;
      return error?.code === "TARGET_NOT_FOUND";
    },
  );
  assert.deepEqual(error?.details, {
    candidateCount: 1,
    candidateRefs: ["r1"],
    candidates: [{
      ref: "r1",
      frameId: "frame-1",
      role: "button",
      name: "Continue",
      visible: true,
      enabled: true,
      focusable: true,
    }],
    hiddenCandidateCount: 0,
    hiddenCandidates: [],
    snapshotTruncated: false,
    targetIndex: 2,
    frameId: "frame-1",
  });
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
  let hiddenError: AgentError | undefined;
  assert.throws(
    () => new SnapshotLocatorResolver().resolve(target, { nodes: [hidden] }),
    (error: unknown) => {
      hiddenError = error instanceof AgentError ? error : undefined;
      return hiddenError?.code === "TARGET_NOT_FOUND";
    },
  );
  assert.deepEqual(hiddenError?.details, {
    candidateCount: 0,
    candidateRefs: [],
    candidates: [],
    hiddenCandidateCount: 1,
    hiddenCandidates: [{
      ref: "hidden",
      frameId: "frame-1",
      role: "button",
      name: "Hidden action",
      visible: false,
      enabled: true,
      focusable: true,
    }],
    snapshotTruncated: false,
  });
  const result = new SnapshotLocatorResolver().resolve(target, { nodes: [hidden] }, { includeHidden: true });
  assert.equal(result.ref, "hidden");
});

test("bounds snapshot query results while preserving hidden-match counts", () => {
  const base = snapshot();
  const hidden = { ...base.nodes[0], ref: asSnapshotRef("hidden"), visible: false };
  const target = { kind: "role" as const, role: "button", name: "Continue", exact: true };
  const bounded = querySnapshot(target, { nodes: [base.nodes[0], hidden] }, { limit: 1 });
  assert.equal(bounded.candidateCount, 1);
  assert.equal(bounded.candidates.length, 1);
  assert.equal(bounded.hiddenCandidateCount, 1);
  assert.equal(bounded.hiddenCandidates.length, 1);
  assert.equal(bounded.candidatesTruncated, false);
  const inclusive = querySnapshot(target, { nodes: [base.nodes[0], hidden] }, { includeHidden: true, limit: 2 });
  assert.equal(inclusive.candidateCount, 2);
  assert.equal(inclusive.candidates.length, 2);
  assert.equal(inclusive.hiddenCandidateCount, 0);
  assert.equal(inclusive.hiddenCandidatesTruncated, false);
});

test("matches the complete semantic wait state", () => {
  const node = {
    ...snapshot().nodes[0],
    state: {
      disabled: true,
      expanded: true,
      focused: true,
      invalid: true,
      pressed: true,
      readOnly: true,
      required: true,
      value: "Ada",
      checked: true,
      selected: true,
    },
  };
  assert.equal(matchesWaitElementState(node, {
    attached: true,
    visible: true,
    enabled: true,
    disabled: true,
    focused: true,
    value: "Ada",
    checked: true,
    expanded: true,
    invalid: true,
    pressed: true,
    readOnly: true,
    required: true,
    selected: true,
  }), true);
  assert.equal(matchesWaitElementState(node, { invalid: false }), false);
  assert.equal(matchesWaitElementState(node, { attached: false }), false);
});

test("fails instead of guessing when a locator is ambiguous", () => {
  let ambiguousError: AgentError | undefined;
  assert.throws(
    () =>
      new SnapshotLocatorResolver().resolve(
        { locator: { kind: "text", text: "Continue" } },
        snapshot(),
      ),
    (error: unknown) => {
      ambiguousError = error instanceof AgentError ? error : undefined;
      return ambiguousError?.code === "AMBIGUOUS_TARGET";
    },
  );
  const details = ambiguousError?.details as { candidateCount: number; candidates: Array<{ ref: string }> };
  assert.equal(details.candidateCount, 2);
  assert.deepEqual(details.candidates.map((candidate) => candidate.ref), ["r1", "r2"]);
});

test("marks truncated snapshots in not-found diagnostics", () => {
  let error: AgentError | undefined;
  assert.throws(
    () => new SnapshotLocatorResolver().resolve(
      { locator: { kind: "role", role: "textbox", name: "Missing", exact: true } },
      { nodes: [], truncated: true },
    ),
    (candidate: unknown) => {
      error = candidate instanceof AgentError ? candidate : undefined;
      return error?.code === "TARGET_NOT_FOUND";
    },
  );
  assert.equal((error?.details as { snapshotTruncated: boolean }).snapshotTruncated, true);
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
