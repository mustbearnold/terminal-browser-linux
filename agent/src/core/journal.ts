import fs from "node:fs";
import path from "node:path";

import { AgentError } from "../protocol/errors";
import type { ActionResult, AgentEvent, PageId } from "../protocol/types";
import type { EventHistoryStore } from "./events";
import type { ActionJournal, ActionJournalStatus, IdempotentResult } from "./idempotency";

export interface AgentJournal {
  readonly actions: ActionJournal<ActionResult>;
  eventHistory(pageId: PageId): EventHistoryStore;
}

interface PersistedActionEntry {
  key: string;
  fingerprint: string;
  status: "pending" | "completed";
  result?: ActionResult;
}

interface PersistedActionJournal {
  version: 1;
  entries: PersistedActionEntry[];
}

interface PersistedEventHistory {
  version: 1;
  events: AgentEvent[];
}

interface StoredActionEntry {
  fingerprint: string;
  status: "pending" | "completed";
  result?: ActionResult;
}

let tempSequence = 0;

export class DurableActionJournal implements ActionJournal<ActionResult> {
  private readonly entries = new Map<string, StoredActionEntry>();
  private readonly inFlight = new Map<string, Promise<ActionResult>>();

  constructor(
    private readonly filePath: string,
    private readonly limit = 256,
  ) {
    validateLimit(limit, "action journal limit");
    this.load();
  }

  execute(
    key: string,
    fingerprint: string,
    operation: () => Promise<ActionResult>,
  ): Promise<IdempotentResult<ActionResult>> {
    const existing = this.entries.get(key);
    if (existing) {
      this.assertFingerprint(key, existing.fingerprint, fingerprint);
      if (existing.status === "completed") {
        if (!existing.result) throw new AgentError("INTERNAL_ERROR", "completed action journal entry has no result");
        return Promise.resolve({ result: existing.result, replayed: true });
      }
      const pending = this.inFlight.get(key);
      if (pending) return pending.then((result) => ({ result, replayed: true }));
      throw new AgentError("ACTION_STATUS_UNKNOWN", "action execution was interrupted before completion", {
        retryable: true,
        details: { key },
      });
    }

    const entry: StoredActionEntry = { fingerprint, status: "pending" };
    this.entries.set(key, entry);
    try {
      this.persist();
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }

    const execution = Promise.resolve().then(operation).then((result) => {
      entry.status = "completed";
      entry.result = result;
      try {
        this.persist();
      } catch (error) {
        entry.status = "pending";
        delete entry.result;
        throw error;
      }
      this.evictCompleted();
      return result;
    });
    this.inFlight.set(key, execution);
    void execution.then(
      () => this.inFlight.delete(key),
      (error) => {
        this.inFlight.delete(key);
        if (!safeToRetryBeforeExecution(error) || this.entries.get(key) !== entry) return;
        this.entries.delete(key);
        try {
          this.persist();
        } catch {
          this.entries.set(key, entry);
        }
      },
    );
    return execution.then((result) => ({ result, replayed: false }));
  }

  status(key: string): ActionJournalStatus<ActionResult> {
    const entry = this.entries.get(key);
    if (!entry) return { status: "missing" };
    if (entry.status === "completed") {
      if (!entry.result) throw new AgentError("INTERNAL_ERROR", "completed action journal entry has no result");
      return { status: "completed", result: entry.result };
    }
    return { status: this.inFlight.has(key) ? "running" : "unknown" };
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new AgentError("INTERNAL_ERROR", `could not read action journal: ${errorMessage(error)}`);
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new AgentError("INTERNAL_ERROR", "action journal has an unsupported format");
    }
    for (const value of parsed.entries) {
      if (!isRecord(value) || typeof value.key !== "string" || typeof value.fingerprint !== "string") {
        throw new AgentError("INTERNAL_ERROR", "action journal contains an invalid entry");
      }
      if (value.status !== "pending" && value.status !== "completed") {
        throw new AgentError("INTERNAL_ERROR", "action journal contains an invalid entry status");
      }
      if (value.status === "completed" && !isRecord(value.result)) {
        throw new AgentError("INTERNAL_ERROR", "completed action journal entry has no result");
      }
      this.entries.set(value.key, {
        fingerprint: value.fingerprint,
        status: value.status,
        ...(value.result === undefined ? {} : { result: value.result as ActionResult }),
      });
    }
    this.evictCompleted();
  }

  private persist(): void {
    const data: PersistedActionJournal = {
      version: 1,
      entries: [...this.entries].map(([key, entry]) => ({
        key,
        fingerprint: entry.fingerprint,
        status: entry.status,
        ...(entry.result === undefined ? {} : { result: entry.result }),
      })),
    };
    atomicWrite(this.filePath, data);
  }

  private evictCompleted(): void {
    let completed = [...this.entries.values()].filter((entry) => entry.status === "completed").length;
    if (completed <= this.limit) return;
    for (const [key, entry] of this.entries) {
      if (entry.status !== "completed") continue;
      this.entries.delete(key);
      completed -= 1;
      if (completed <= this.limit) return;
    }
  }

  private assertFingerprint(key: string, expected: string, actual: string): void {
    if (expected === actual) return;
    throw new AgentError("IDEMPOTENCY_CONFLICT", "idempotency key was reused with a different request", {
      details: { key },
    });
  }
}

export class DurableEventHistory implements EventHistoryStore {
  private readonly events: AgentEvent[];

  constructor(
    private readonly filePath: string,
    private readonly limit = 256,
  ) {
    validateLimit(limit, "event history limit");
    this.events = this.read();
  }

  load(): readonly AgentEvent[] {
    return [...this.events];
  }

  append(event: AgentEvent): void {
    const next = [...this.events, event].slice(-this.limit);
    atomicWrite(this.filePath, { version: 1, events: next } satisfies PersistedEventHistory);
    this.events.splice(0, this.events.length, ...next);
  }

  private read(): AgentEvent[] {
    if (!fs.existsSync(this.filePath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new AgentError("INTERNAL_ERROR", `could not read event history: ${errorMessage(error)}`);
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.events)) {
      throw new AgentError("INTERNAL_ERROR", "event history has an unsupported format");
    }
    const events = parsed.events as AgentEvent[];
    for (let index = 0; index < events.length; index += 1) {
      if (!isRecord(events[index]) || !Number.isSafeInteger(events[index].sequence)) {
        throw new AgentError("INTERNAL_ERROR", "event history contains an invalid event");
      }
      if (index > 0 && events[index].sequence <= events[index - 1].sequence) {
        throw new AgentError("INTERNAL_ERROR", "event history sequences must be strictly increasing");
      }
    }
    return events.slice(-this.limit);
  }
}

export class DurableAgentJournal implements AgentJournal {
  readonly actions: DurableActionJournal;
  private readonly eventHistories = new Map<string, DurableEventHistory>();

  constructor(
    private readonly basePath: string,
    private readonly limit = 256,
  ) {
    this.actions = new DurableActionJournal(`${basePath}.actions.json`, limit);
  }

  eventHistory(pageId: PageId): DurableEventHistory {
    const key = String(pageId);
    const existing = this.eventHistories.get(key);
    if (existing) return existing;
    const history = new DurableEventHistory(`${this.basePath}.${encodeURIComponent(key)}.events.json`, this.limit);
    this.eventHistories.set(key, history);
    return history;
  }
}

function validateLimit(limit: number, label: string): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new AgentError("INVALID_REQUEST", `${label} must be a positive safe integer`);
  }
}

function atomicWrite(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${++tempSequence}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeToRetryBeforeExecution(error: unknown): boolean {
  if (!(error instanceof AgentError) || error.code !== "RESOURCE_EXHAUSTED") return false;
  if (!isRecord(error.details)) return false;
  return error.details.scope === "page-actions" && error.details.safeToRetry === true;
}
