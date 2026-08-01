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
