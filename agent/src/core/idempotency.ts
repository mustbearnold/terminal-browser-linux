import { AgentError } from "../protocol/errors";

export interface IdempotentResult<Result> {
  result: Result;
  replayed: boolean;
}

export type ActionJournalStatus<Result> =
  | { status: "missing" | "running" | "unknown" }
  | { status: "completed"; result: Result };

export interface ActionJournal<Result> {
  execute(
    key: string,
    fingerprint: string,
    operation: () => Promise<Result>,
  ): Promise<IdempotentResult<Result>>;
  status(key: string): ActionJournalStatus<Result>;
}

interface Entry<Result> {
  fingerprint: string;
  promise: Promise<Result>;
  settled: boolean;
  succeeded: boolean;
  result?: Result;
}

export class IdempotencyCache<Result> implements ActionJournal<Result> {
  private readonly entries = new Map<string, Entry<Result>>();

  constructor(private readonly limit = 256) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new AgentError("INVALID_REQUEST", "idempotency cache limit must be a positive safe integer");
    }
  }

  execute(
    key: string,
    fingerprint: string,
    operation: () => Promise<Result>,
  ): Promise<IdempotentResult<Result>> {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new AgentError("IDEMPOTENCY_CONFLICT", "idempotency key was reused with a different request", {
          details: { key },
        });
      }
      return existing.promise.then((result) => ({ result, replayed: true }));
    }

    const entry: Entry<Result> = {
      fingerprint,
      promise: Promise.resolve().then(operation),
      settled: false,
      succeeded: false,
    };
    this.entries.set(key, entry);
    void entry.promise.then(
      (result) => {
        entry.succeeded = true;
        entry.result = result;
        entry.settled = true;
        this.evict();
      },
      () => {
        entry.settled = true;
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    this.evict();
    return entry.promise.then((result) => ({ result, replayed: false }));
  }

  status(key: string): ActionJournalStatus<Result> {
    const entry = this.entries.get(key);
    if (!entry) return { status: "missing" };
    if (!entry.settled) return { status: "running" };
    if (entry.succeeded) return { status: "completed", result: entry.result as Result };
    return { status: "unknown" };
  }

  private evict(): void {
    if (this.entries.size <= this.limit) return;
    for (const [key, entry] of this.entries) {
      if (!entry.settled) continue;
      this.entries.delete(key);
      if (this.entries.size <= this.limit) return;
    }
  }
}

export function stableSerialize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}
