import { RevisionLedger } from "./revisions";
import type {
  ActionExpectation,
  ActionResult,
  AgentAction,
  AgentEvent,
  DocumentId,
  PageIdentity,
  PageSnapshot,
  SnapshotOptions,
  SnapshotToken,
  WaitCondition,
  WaitResult,
} from "../protocol/types";
import { asSnapshotId } from "../protocol/types";
import type { PageId } from "../protocol/types";

export interface PageBackend {
  readonly pageId: PageId;
  identity(): Promise<PageIdentity>;
  snapshot(options?: SnapshotOptions): Promise<Omit<PageSnapshot, "snapshotId">>;
  act(
    action: AgentAction,
    token?: SnapshotToken,
    expect?: ActionExpectation,
  ): Promise<Omit<ActionResult, "snapshot">>;
  wait(condition: WaitCondition, timeoutMs?: number): Promise<Omit<WaitResult, "snapshot">>;
  subscribe(listener: (event: AgentEvent) => void): Promise<() => void>;
}

export interface PageSession {
  readonly pageId: PageId;
  snapshot(options?: SnapshotOptions): Promise<PageSnapshot>;
  assertFresh(token: SnapshotToken): void;
  currentRevision(): { documentId: DocumentId; revision: number };
  advanceRevision(): { documentId: DocumentId; revision: number };
  navigate(documentId: DocumentId): { documentId: DocumentId; revision: number };
  act(action: AgentAction, token?: SnapshotToken, expect?: ActionExpectation): Promise<ActionResult>;
  wait(condition: WaitCondition, timeoutMs?: number): Promise<WaitResult>;
  subscribe(listener: (event: AgentEvent) => void): Promise<() => void>;
}

export class RevisionedPageSession implements PageSession {
  private snapshotSequence = 0;
  private actionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly backend: PageBackend,
    private readonly ledger: RevisionLedger,
  ) {}

  get pageId(): PageId {
    return this.backend.pageId;
  }

  async snapshot(options?: SnapshotOptions): Promise<PageSnapshot> {
    const captured = await this.backend.snapshot(options);
    const state = this.ledger.synchronize(captured.pageId, captured.documentId, captured.revision);
    return {
      ...captured,
      revision: state.revision,
      snapshotId: asSnapshotId(`${this.pageId}:${++this.snapshotSequence}`),
    };
  }

  assertFresh(token: SnapshotToken): void {
    this.ledger.assertFresh(token);
  }

  currentRevision() {
    const current = this.ledger.current(this.pageId);
    return { documentId: current.documentId, revision: current.revision };
  }

  advanceRevision() {
    const current = this.ledger.advance(this.pageId);
    return { documentId: current.documentId, revision: current.revision };
  }

  navigate(documentId: DocumentId) {
    const current = this.ledger.navigate(this.pageId, documentId);
    return { documentId: current.documentId, revision: current.revision };
  }

  async act(
    action: AgentAction,
    token?: SnapshotToken,
    expect?: ActionExpectation,
  ): Promise<ActionResult> {
    return this.enqueueAction(async () => {
      const before = await this.backend.identity();
      this.ledger.synchronize(before.pageId, before.documentId, before.revision);
      if (token) this.ledger.assertFresh(token);
      const result = await this.backend.act(action, token, expect);
      const after = await this.backend.identity();
      this.ledger.synchronize(after.pageId, after.documentId, after.revision);
      return { ...result, snapshot: await this.snapshot() };
    });
  }

  async wait(condition: WaitCondition, timeoutMs?: number): Promise<WaitResult> {
    const result = await this.backend.wait(condition, timeoutMs);
    return result.satisfied ? { ...result, snapshot: await this.snapshot() } : result;
  }

  async subscribe(listener: (event: AgentEvent) => void): Promise<() => void> {
    return this.backend.subscribe(listener);
  }

  private enqueueAction<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.actionTail.then(operation, operation);
    this.actionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
