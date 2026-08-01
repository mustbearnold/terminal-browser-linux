import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_EVALUATION_PROTOCOL,
  AGENT_EVALUATION_VERSION,
  assertAgentEvaluationReport,
  fixtureScenarios,
  parseAgentEvaluationReport,
  runAgentEvaluation,
  serializeAgentEvaluationReport,
  type AgentEvaluationScenario,
} from "../evaluation";
import { createFixtureAgentHarness } from "../evaluation/loopback";
import { FIXTURE_PAGE_ID } from "./fixture";

test("produces a versioned fixture report with trace windows and aggregate metrics", async () => {
  const harness = createFixtureAgentHarness({ clientId: "evaluation-test" });
  try {
    await harness.client.hello();
    const report = await runAgentEvaluation(harness.client, fixtureScenarios(FIXTURE_PAGE_ID), {
      now: () => 1000,
      trace: harness.trace,
      includeTrace: true,
      provenance: { source: { commit: "test-commit" }, runtime: { node: "test-node" } },
    });

    assert.equal(report.contract, AGENT_EVALUATION_PROTOCOL);
    assert.equal(report.version, AGENT_EVALUATION_VERSION);
    assert.equal(report.total, 5);
    assert.equal(report.passed, 5);
    assert.equal(report.failed, 0);
    assert.equal(report.passRate, 1);
    assert.deepEqual(report.provenance, { source: { commit: "test-commit" }, runtime: { node: "test-node" } });
    assert.ok(report.trace);
    assert.ok(report.trace.entries.length > 0);
    assert.ok(report.metrics.traceRequests > 0);
    assert.ok(report.metrics.traceResponses > 0);
    assert.ok(report.metrics.traceEvents > 0);
    assert.ok(report.metrics["metric.nodes.samples"] === 1);
    assert.ok(report.cases.every((entry) => entry.trace && entry.trace.entries > 0));
    assert.equal(assertAgentEvaluationReport(report), report);
    assert.deepEqual(parseAgentEvaluationReport(serializeAgentEvaluationReport(report)), report);
  } finally {
    await harness.client.close();
  }
});

test("rejects duplicate scenario identifiers before execution", async () => {
  const harness = createFixtureAgentHarness();
  const scenario = { id: "duplicate", name: "first", run: async () => ({ passed: true }) } satisfies AgentEvaluationScenario;
  try {
    await assert.rejects(
      runAgentEvaluation(harness.client, [scenario, { ...scenario, name: "second" }]),
      /evaluation scenario id must be unique/,
    );
  } finally {
    await harness.client.close();
  }
});

test("rejects malformed evaluation reports", async () => {
  const harness = createFixtureAgentHarness();
  try {
    await harness.client.hello();
    const report = await runAgentEvaluation(harness.client, [], { now: () => 1000 });
    assert.throws(
      () => assertAgentEvaluationReport({ ...report, passRate: 2 }),
      /pass rate is out of range/,
    );
    assert.throws(
      () => assertAgentEvaluationReport({ ...report, provenance: { runtime: { node: 1 as unknown as string } } }),
      /provenance runtime contains an invalid value/,
    );
  } finally {
    await harness.client.close();
  }
});

test("rejects malformed evaluation artifacts before reading report fields", () => {
  assert.throws(() => parseAgentEvaluationReport("null"), /expected an object/);
  assert.throws(() => parseAgentEvaluationReport("not-json"), /invalid agent evaluation artifact/);
});
