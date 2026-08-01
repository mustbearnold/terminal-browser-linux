"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  AgentClient,
  fixtureScenarios,
  MemoryTrace,
  runAgentEvaluation,
  serializeAgentEvaluationReport,
  TraceRecorder,
} = require("../../agent/dist");
const { launchHost, listSockets, stopHost, waitForSocket, dataUrl } = require("./agent-smoke-support.cjs");

const html = `<!doctype html><meta charset="utf-8"><title>Agent evaluation fixture</title><label for="name">Name</label><input id="name"><button id="continue">Continue</button><output id="status">Idle</output><script>document.getElementById('continue').addEventListener('click',()=>document.getElementById('status').textContent='Ready');</script>`;

async function run() {
  const existing = new Set(listSockets());
  const { host, output } = launchHost();
  let client;
  let pageId;
  try {
    const socket = await waitForSocket(existing, 15_000, output);
    const trace = new MemoryTrace();
    client = await AgentClient.connect(socket, {
      clientId: "evaluation-smoke",
      trace: new TraceRecorder(trace),
    });
    const hello = await client.hello();
    const opened = await client.call("pages.open", { url: dataUrl(html) });
    pageId = opened.pageId;
    await client.call("page.wait", { pageId, condition: { type: "text", value: "Continue" }, timeoutMs: 3_000 });
    const report = await runAgentEvaluation(client, fixtureScenarios(pageId), {
      trace,
      includeTrace: process.env.TERMINAL_BROWSER_EVALUATION_TRACE === "1",
    });
    const artifactPath = process.env.TERMINAL_BROWSER_EVALUATION_ARTIFACT;
    if (artifactPath) fs.writeFileSync(artifactPath, serializeAgentEvaluationReport(report), "utf8");
    assert.equal(report.failed, 0, JSON.stringify(report));
    assert.equal(report.passRate, 1);
    assert.ok(report.metrics.traceRequests > 0);
    assert.ok(report.metrics.traceResponses > 0);
    assert.ok(report.metrics.traceEvents > 0);
    assert.ok(report.cases.every((entry) => entry.trace && entry.trace.entries > 0));
    console.log(JSON.stringify({
      contract: report.contract,
      version: report.version,
      protocol: `${hello.protocol}/${hello.version}`,
      passRate: report.passRate,
      metrics: report.metrics,
      cases: report.cases.map(({ id, passed, durationMs, trace: window, metrics }) => ({ id, passed, durationMs, trace: window, metrics })),
    }));
  } finally {
    if (client) {
      if (pageId) await client.call("pages.close", { pageId }).catch(() => {});
      await client.close().catch(() => {});
    }
    stopHost(host);
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
