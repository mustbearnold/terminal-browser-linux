import { AgentClient } from "./client";
import { AGENT_TRACE_VERSION, type TraceDocument, type TraceEntry } from "./core/trace";
import { AgentError, type AgentErrorCode } from "./protocol/errors";
import type {
  AgentEvent,
  PageId,
  PageSnapshot,
  SnapshotToken,
} from "./protocol/types";

export const AGENT_EVALUATION_PROTOCOL = "terminal-browser.agent/evaluation" as const;
export const AGENT_EVALUATION_VERSION = 2 as const;

export interface AgentEvaluationOutcome {
  passed: boolean;
  metrics?: Readonly<Record<string, number>>;
  reason?: string;
}

export interface AgentEvaluationScenario {
  id: string;
  name: string;
  run(client: AgentClient): Promise<AgentEvaluationOutcome>;
}

export interface AgentEvaluationTraceSource {
  document(): TraceDocument;
}

export interface AgentEvaluationTraceWindow {
  startSequence: number;
  endSequence: number;
  entries: number;
  requests: number;
  responses: number;
  events: number;
}

export interface AgentEvaluationCase extends AgentEvaluationOutcome {
  id: string;
  name: string;
  durationMs: number;
  error?: {
    code?: AgentErrorCode;
    message: string;
  };
  trace?: AgentEvaluationTraceWindow;
}

export interface AgentEvaluationReport {
  contract: typeof AGENT_EVALUATION_PROTOCOL;
  version: typeof AGENT_EVALUATION_VERSION;
  startedAt: number;
  finishedAt: number;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  durationMs: number;
  metrics: Readonly<Record<string, number>>;
  cases: readonly AgentEvaluationCase[];
  trace?: TraceDocument;
}

export interface AgentEvaluationOptions {
  now?: () => number;
  trace?: AgentEvaluationTraceSource;
  includeTrace?: boolean;
}

export async function runAgentEvaluation(
  client: AgentClient,
  scenarios: readonly AgentEvaluationScenario[],
  options: AgentEvaluationOptions = {},
): Promise<AgentEvaluationReport> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (!scenario.id || ids.has(scenario.id)) throw new Error(`evaluation scenario id must be unique: ${scenario.id}`);
    ids.add(scenario.id);
  }
  const cases: AgentEvaluationCase[] = [];
  for (const scenario of scenarios) {
    const caseStarted = now();
    const traceBefore = options.trace?.document();
    try {
      const outcome = await scenario.run(client);
      const finishedAt = now();
      cases.push({
        ...outcome,
        id: scenario.id,
        name: scenario.name,
        durationMs: Math.max(0, finishedAt - caseStarted),
        metrics: outcome.metrics ?? {},
        ...(options.trace ? { trace: traceWindow(traceBefore, options.trace.document()) } : {}),
      });
    } catch (error) {
      const finishedAt = now();
      cases.push({
        id: scenario.id,
        name: scenario.name,
        passed: false,
        durationMs: Math.max(0, finishedAt - caseStarted),
        metrics: {},
        error: evaluationError(error),
        ...(options.trace ? { trace: traceWindow(traceBefore, options.trace.document()) } : {}),
      });
    }
  }
  const passed = cases.filter((entry) => entry.passed).length;
  const finishedAt = now();
  const durationMs = Math.max(0, finishedAt - startedAt);
  const report: AgentEvaluationReport = {
    contract: AGENT_EVALUATION_PROTOCOL,
    version: AGENT_EVALUATION_VERSION,
    startedAt,
    finishedAt,
    total: cases.length,
    passed,
    failed: cases.length - passed,
    passRate: cases.length === 0 ? 1 : passed / cases.length,
    durationMs,
    metrics: aggregateMetrics(cases, durationMs),
    cases,
    ...(options.includeTrace && options.trace ? { trace: options.trace.document() } : {}),
  };
  return assertAgentEvaluationReport(report);
}

export function assertAgentEvaluationReport(report: AgentEvaluationReport): AgentEvaluationReport {
  if (report.contract !== AGENT_EVALUATION_PROTOCOL) throw new Error("unsupported agent evaluation contract");
  if (report.version !== AGENT_EVALUATION_VERSION) throw new Error(`unsupported agent evaluation version: ${report.version}`);
  if (!Number.isFinite(report.startedAt) || !Number.isFinite(report.finishedAt) || report.finishedAt < report.startedAt) {
    throw new Error("agent evaluation timestamps are invalid");
  }
  if (report.total !== report.cases.length) throw new Error("agent evaluation total does not match its cases");
  if (report.total < 0 || report.passed < 0 || report.failed < 0) throw new Error("agent evaluation counts are invalid");
  if (report.passed + report.failed !== report.total) throw new Error("agent evaluation pass counts do not add up");
  if (report.passRate < 0 || report.passRate > 1) throw new Error("agent evaluation pass rate is out of range");
  if (!Number.isFinite(report.durationMs) || report.durationMs < 0) throw new Error("agent evaluation duration is invalid");
  const ids = new Set<string>();
  for (const entry of report.cases) {
    if (!entry.id || ids.has(entry.id)) throw new Error(`agent evaluation case id is not unique: ${entry.id}`);
    ids.add(entry.id);
    if (!Number.isFinite(entry.durationMs) || entry.durationMs < 0) throw new Error(`agent evaluation case duration is invalid: ${entry.id}`);
    for (const value of Object.values(entry.metrics ?? {})) {
      if (!Number.isFinite(value)) throw new Error(`agent evaluation metric is not finite: ${entry.id}`);
    }
    if (entry.trace) validateTraceWindow(entry.trace, entry.id);
  }
  if (report.trace) validateTraceDocument(report.trace);
  for (const value of Object.values(report.metrics)) {
    if (!Number.isFinite(value)) throw new Error("agent evaluation aggregate metric is not finite");
  }
  return report;
}

export function fixtureScenarios(pageId: PageId): readonly AgentEvaluationScenario[] {
  return [
    {
      id: "snapshot-locates-semantic-control",
      name: "snapshot-locates-semantic-control",
      async run(client) {
        const snapshot = await client.call("page.snapshot", {
          pageId,
          options: { interactiveOnly: false, includeGeometry: false },
        });
        const node = await client.call("page.read", {
          pageId,
          target: { locator: { kind: "role", role: "textbox", name: "Name", exact: true } },
          token: snapshotToken(snapshot),
        });
        return {
          passed: node.role === "textbox" && node.name === "Name",
          metrics: { nodes: snapshot.nodes.length },
        };
      },
    },
    {
      id: "stale-reference-fails-and-recovers",
      name: "stale-reference-fails-and-recovers",
      async run(client) {
        const initial = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false } });
        const target = initial.nodes.find((node) => node.role === "textbox");
        if (!target) return { passed: false, reason: "fixture snapshot did not expose a textbox" };

        const changed = await client.call("page.act", {
          pageId,
          token: snapshotToken(initial),
          action: { type: "fill", target: { ref: target.ref }, value: "evaluation" },
        });
        let staleCode: AgentErrorCode | undefined;
        try {
          await client.call("page.act", {
            pageId,
            token: snapshotToken(initial),
            action: { type: "fill", target: { ref: target.ref }, value: "stale" },
          });
        } catch (error) {
          if (error instanceof AgentError) staleCode = error.code;
        }
        const revisionDelta = (changed.snapshot?.revision ?? initial.revision) - initial.revision;
        return {
          passed: staleCode === "STALE_SNAPSHOT" && revisionDelta > 0,
          metrics: { revisionDelta, recoverySteps: 1 },
          reason: staleCode === "STALE_SNAPSHOT" ? undefined : `expected STALE_SNAPSHOT, received ${staleCode ?? "no error"}`,
        };
      },
    },
    {
      id: "observation-captures-action-event",
      name: "observation-captures-action-event",
      async run(client) {
        const events: AgentEvent[] = [];
        const unsubscribe = client.onEvent((event) => events.push(event));
        try {
          await client.observe(pageId, ["dom.changed"]);
          await client.call("page.act", {
            pageId,
            action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } } },
          });
        } finally {
          unsubscribe();
        }
        return {
          passed: events.some((event) => event.event === "dom.changed"),
          metrics: { events: events.length },
        };
      },
    },
    {
      id: "deadline-bounds-wait",
      name: "deadline-bounds-wait",
      async run(client) {
        const started = Date.now();
        let code: AgentErrorCode | undefined;
        try {
          await client.call(
            "page.wait",
            { pageId, condition: { type: "time", ms: 1000 }, timeoutMs: 1000 },
            { deadlineMs: 20 },
          );
        } catch (error) {
          if (error instanceof AgentError) code = error.code;
        }
        const elapsedMs = Date.now() - started;
        return {
          passed: code === "TIMEOUT",
          metrics: { elapsedMs, deadlineMs: 20 },
          reason: code === "TIMEOUT" ? undefined : `expected TIMEOUT, received ${code ?? "no error"}`,
        };
      },
    },
  ];
}

function traceWindow(before: TraceDocument | undefined, after: TraceDocument): AgentEvaluationTraceWindow {
  const startSequence = lastSequence(before?.entries);
  const endSequence = lastSequence(after.entries);
  const entries = after.entries.filter((entry) => entry.sequence > startSequence);
  return {
    startSequence,
    endSequence,
    entries: entries.length,
    requests: entries.filter((entry) => entry.message.kind === "request").length,
    responses: entries.filter((entry) => entry.message.kind === "response").length,
    events: entries.filter((entry) => entry.message.kind === "event").length,
  };
}

function lastSequence(entries: readonly TraceEntry[] | undefined): number {
  return entries && entries.length > 0 ? entries[entries.length - 1].sequence : 0;
}

function validateTraceWindow(window: AgentEvaluationTraceWindow, id: string): void {
  if (!Number.isSafeInteger(window.startSequence) || !Number.isSafeInteger(window.endSequence)) {
    throw new Error(`agent evaluation trace window is invalid: ${id}`);
  }
  if (window.endSequence < window.startSequence || window.entries < 0) {
    throw new Error(`agent evaluation trace window is out of order: ${id}`);
  }
  if (window.requests + window.responses + window.events > window.entries) {
    throw new Error(`agent evaluation trace counts exceed entries: ${id}`);
  }
}

function validateTraceDocument(document: TraceDocument): void {
  if (document.version !== AGENT_TRACE_VERSION) throw new Error(`unsupported agent trace version: ${document.version}`);
  let previousSequence = 0;
  for (const entry of document.entries) {
    if (entry.version !== AGENT_TRACE_VERSION || !Number.isSafeInteger(entry.sequence) || entry.sequence <= previousSequence) {
      throw new Error("agent evaluation trace entries are invalid");
    }
    previousSequence = entry.sequence;
  }
}

function aggregateMetrics(cases: readonly AgentEvaluationCase[], durationMs: number): Record<string, number> {
  const passed = cases.filter((entry) => entry.passed).length;
  const metrics: Record<string, number> = {
    scenarioCount: cases.length,
    passed,
    failed: cases.length - passed,
    passRate: cases.length === 0 ? 1 : passed / cases.length,
    durationMs,
    traceEntries: cases.reduce((total, entry) => total + (entry.trace?.entries ?? 0), 0),
    traceRequests: cases.reduce((total, entry) => total + (entry.trace?.requests ?? 0), 0),
    traceResponses: cases.reduce((total, entry) => total + (entry.trace?.responses ?? 0), 0),
    traceEvents: cases.reduce((total, entry) => total + (entry.trace?.events ?? 0), 0),
  };
  const names = new Set(cases.flatMap((entry) => Object.keys(entry.metrics ?? {})));
  for (const name of names) {
    const values = cases
      .map((entry) => entry.metrics?.[name])
      .filter((value): value is number => value !== undefined);
    if (values.length === 0) continue;
    metrics[`metric.${name}.samples`] = values.length;
    metrics[`metric.${name}.sum`] = values.reduce((total, value) => total + value, 0);
    metrics[`metric.${name}.average`] = metrics[`metric.${name}.sum`] / values.length;
    metrics[`metric.${name}.min`] = Math.min(...values);
    metrics[`metric.${name}.max`] = Math.max(...values);
  }
  return metrics;
}

function snapshotToken(snapshot: PageSnapshot): SnapshotToken {
  return {
    pageId: snapshot.pageId,
    documentId: snapshot.documentId,
    revision: snapshot.revision,
    snapshotId: snapshot.snapshotId,
  };
}

function evaluationError(error: unknown): { code?: AgentErrorCode; message: string } {
  if (error instanceof AgentError) return { code: error.code, message: error.message };
  return { message: error instanceof Error ? error.message : String(error) };
}
