import { AgentError } from "../protocol/errors";
import type { DocumentId, PageId, SnapshotToken } from "../protocol/types";

export interface RevisionState {
  pageId: PageId;
  documentId: DocumentId;
  revision: number;
}

export class RevisionLedger {
  private readonly pages = new Map<PageId, RevisionState>();

  register(pageId: PageId, documentId: DocumentId): RevisionState {
    const current = this.pages.get(pageId);
    if (current && current.documentId === documentId) return { ...current };
    const next = { pageId, documentId, revision: 0 };
    this.pages.set(pageId, next);
    return { ...next };
  }

  synchronize(pageId: PageId, documentId: DocumentId, revision: number): RevisionState {
    if (!Number.isInteger(revision) || revision < 0) {
      throw new AgentError("INVALID_REQUEST", "revision must be a non-negative integer");
    }
    const next = { pageId, documentId, revision };
    this.pages.set(pageId, next);
    return { ...next };
  }

  navigate(pageId: PageId, documentId: DocumentId): RevisionState {
    const next = { pageId, documentId, revision: 0 };
    this.pages.set(pageId, next);
    return { ...next };
  }

  advance(pageId: PageId): RevisionState {
    const current = this.pages.get(pageId);
    if (!current) throw new AgentError("PAGE_NOT_FOUND", `unknown page: ${pageId}`);
    const next = { ...current, revision: current.revision + 1 };
    this.pages.set(pageId, next);
    return { ...next };
  }

  current(pageId: PageId): RevisionState {
    const current = this.pages.get(pageId);
    if (!current) throw new AgentError("PAGE_NOT_FOUND", `unknown page: ${pageId}`);
    return { ...current };
  }

  assertFresh(token: SnapshotToken): void {
    const current = this.current(token.pageId);
    if (current.documentId === token.documentId && current.revision === token.revision) return;
    throw new AgentError("STALE_SNAPSHOT", "snapshot is no longer current", {
      retryable: true,
      details: {
        pageId: token.pageId,
        expectedDocumentId: current.documentId,
        expectedRevision: current.revision,
        receivedDocumentId: token.documentId,
        receivedRevision: token.revision,
      },
    });
  }
}
