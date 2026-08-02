import assert from "node:assert/strict";
import test from "node:test";

import { AgentError } from "../protocol/errors";
import {
  asDocumentId,
  asPageId,
  asSnapshotId,
  type SnapshotToken,
} from "../protocol/types";
import { RevisionLedger } from "../core/revisions";

test("tracks DOM revisions without changing document identity", () => {
  const ledger = new RevisionLedger();
  const pageId = asPageId("page-1");
  const documentId = asDocumentId("document-1");

  assert.deepEqual(ledger.register(pageId, documentId), { pageId, documentId, revision: 0 });
  assert.deepEqual(ledger.advance(pageId), { pageId, documentId, revision: 1 });
  assert.deepEqual(ledger.register(pageId, documentId), { pageId, documentId, revision: 1 });
});

test("rejects stale snapshot tokens", () => {
  const ledger = new RevisionLedger();
  const pageId = asPageId("page-1");
  const documentId = asDocumentId("document-1");
  ledger.register(pageId, documentId);
  ledger.advance(pageId);

  const token: SnapshotToken = {
    pageId,
    documentId,
    revision: 0,
    snapshotId: asSnapshotId("snapshot-1"),
  };
  assert.throws(
    () => ledger.assertFresh(token),
    (error: unknown) => error instanceof AgentError && error.code === "STALE_SNAPSHOT",
  );
});

test("resets the revision when a document navigates", () => {
  const ledger = new RevisionLedger();
  const pageId = asPageId("page-1");
  ledger.register(pageId, asDocumentId("document-1"));
  ledger.advance(pageId);
  assert.deepEqual(ledger.navigate(pageId, asDocumentId("document-2")), {
    pageId,
    documentId: asDocumentId("document-2"),
    revision: 0,
  });
});

test("rejects same-document revision regressions", () => {
  const ledger = new RevisionLedger();
  const pageId = asPageId("page-1");
  const documentId = asDocumentId("document-1");
  ledger.synchronize(pageId, documentId, 4);

  assert.throws(
    () => ledger.synchronize(pageId, documentId, 3),
    (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal(error.code, "STALE_SNAPSHOT");
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, {
        pageId,
        documentId,
        expectedRevision: 4,
        receivedRevision: 3,
      });
      return true;
    },
  );
  assert.deepEqual(ledger.current(pageId), { pageId, documentId, revision: 4 });
});

test("requires safe integer revisions", () => {
  const ledger = new RevisionLedger();
  assert.throws(
    () => ledger.synchronize(asPageId("page-1"), asDocumentId("document-1"), Number.MAX_SAFE_INTEGER + 1),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_REQUEST",
  );
});
