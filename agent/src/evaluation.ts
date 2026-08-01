import { AgentClient } from "./client";
import { AgentError, type AgentErrorCode } from "./protocol/errors";
import type {
  AgentEvent,
  PageId,
  PageSnapshot,
  SnapshotToken,
} from "./protocol/types";

export const AGENT_EVALUATION_VERSION = 1 as const;

export interface AgentEvaluationOutcome {
  passed: boolean;
  metrics?: Readonly<Record<string, number>>;
  reason?: string;
}

export interface AgentEvaluationScenario {
  name: string;
  run(client: AgentClient): Promise<AgentEvaluationOutcome>;
}

export interface AgentEvaluationCase extends AgentEvaluationOutcome {
  name: string;
  durationMs: number;
  error?: {
    code?: AgentErrorCode;
    message: string;
  };
}

export interface AgentEvaluationReport {
  version: typeof AGENT_EVALUATION_VERSION;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  durationMs: number;
  cases: readonly AgentEvaluationCase[];
}

export async function runAgentEvaluation(
  client: AgentClient,
  scenarios: readonly AgentEvaluationScenario[],
): Promise<AgentEvaluationReport> {
  const started = Date.now();
  const cases: AgentEvaluationCase[] = [];
  for (const scenario of scenarios) {
    const caseStarted = Date.now();
    try {
      const outcome = await scenario.run(client);
      cases.push({
        ...outcome,
        name: scenario.name,
        durationMs: Date.now() - caseStarted,
        metrics: outcome.metrics ?? {},
      });
    } catch (error) {
      cases.push({
        name: scenario.name,
        passed: false,
        durationMs: Date.now() - caseStarted,
        metrics: {},
        error: evaluationError(error),
      });
    }
  }
  const passed = cases.filter((entry) => entry.passed).length;
  return {
    version: AGENT_EVALUATION_VERSION,
    total: cases.length,
    passed,
    failed: cases.length - passed,
    passRate: cases.length === 0 ? 1 : passed / cases.length,
    durationMs: Date.now() - started,
    cases,
  };
}

export function fixtureScenarios(pageId: PageId): readonly AgentEvaluationScenario[] {
  return [
    {
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
