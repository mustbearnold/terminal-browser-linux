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

const html = `<!doctype html>
<meta charset="utf-8">
<title>Agent evaluation fixture</title>
<style>body{font:16px sans-serif;margin:24px}button,input,select,[role=switch]{display:block;margin:8px 0;padding:8px}[role=switch]{border:1px solid #999;width:160px}</style>
<span id="launch-name">Launch workflow</span>
<button id="launch" aria-label="Wrong name" aria-labelledby="launch-name">Visible button</button>
<label for="agent-name">Name</label><input id="agent-name">
<label for="full-name">Full name</label><input id="full-name" placeholder="Ignored by label" value="" required>
<input id="search" type="search" placeholder="Search records">
<input id="amount" type="number" value="3">
<input id="volume" type="range" min="0" max="10" value="4">
<select id="choices" multiple aria-label="Choices"><option value="a" selected>Alpha</option><option value="b">Beta</option></select>
<div id="notifications" role="switch" aria-checked="false" aria-label="Notifications">Notifications</div>
<button id="pressed" aria-pressed="true">Pressed action</button>
<button id="spaced">  Save <span> now </span> </button>
<button id="continue" aria-label="Continue">Continue</button>
<button id="hidden" hidden>Hidden action</button>
<div aria-hidden="true"><button id="aria-hidden">ARIA hidden action</button></div>
<div inert><button id="inert">Inert action</button></div>
<fieldset disabled><button id="disabled">Disabled action</button></fieldset>
<output id="status">Idle</output>
<script>
  document.getElementById('launch').addEventListener('click', () => document.getElementById('status').textContent = 'Launched');
  document.getElementById('continue').addEventListener('click', () => document.getElementById('status').textContent = 'Ready');
  document.getElementById('notifications').addEventListener('click', event => event.currentTarget.setAttribute('aria-checked', String(event.currentTarget.getAttribute('aria-checked') !== 'true')));
</script>`;

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error && error.code === code);
}

function semanticScenarios(pageId) {
  return [
    {
      id: "semantic-naming-and-state",
      name: "semantic-naming-and-state",
      async run(client) {
        const snapshot = await client.call("page.snapshot", {
          pageId,
          options: { interactiveOnly: false, includeGeometry: false },
        });
        const byId = (id) => snapshot.nodes.find((node) => node.attributes?.id === id);
        const launch = byId("launch");
        const fullName = byId("full-name");
        const search = byId("search");
        const amount = byId("amount");
        const volume = byId("volume");
        const choices = byId("choices");
        const notifications = byId("notifications");
        const pressed = byId("pressed");
        const spaced = byId("spaced");
        const hidden = byId("hidden");
        const ariaHidden = byId("aria-hidden");
        const inert = byId("inert");
        const disabled = byId("disabled");
        const passed = launch?.role === "button" && launch.name === "Launch workflow"
          && fullName?.role === "textbox" && fullName.name === "Full name"
          && fullName.state?.required === true && fullName.state.invalid === true
          && search?.role === "searchbox" && amount?.role === "spinbutton"
          && volume?.role === "slider" && choices?.role === "listbox"
          && notifications?.role === "switch" && notifications.state?.checked === false
          && pressed?.state?.pressed === true && spaced?.name === "Save now"
          && hidden?.visible === false && hidden.enabled === false
          && ariaHidden?.visible === false && ariaHidden.enabled === false
          && inert?.visible === false && inert.enabled === false
          && disabled?.visible === true && disabled.enabled === false;
        return {
          passed,
          metrics: {
            semanticNodes: snapshot.nodes.length,
            nativeRoleChecks: [search, amount, volume, choices].filter(Boolean).length,
            stateChecks: [fullName, notifications, pressed, hidden, ariaHidden, inert, disabled].filter(Boolean).length,
          },
        };
      },
    },
    {
      id: "semantic-text-normalization",
      name: "semantic-text-normalization",
      async run(client) {
        await client.call("page.wait", { pageId, condition: { type: "text", value: "Save\n now" }, timeoutMs: 3_000 });
        return { passed: true, metrics: { normalizedTextChecks: 1 } };
      },
    },
    {
      id: "semantic-actions-verify-state",
      name: "semantic-actions-verify-state",
      async run(client) {
        const filled = await client.call("page.act", {
          pageId,
          action: { type: "fill", target: { locator: { kind: "role", role: "textbox", name: "Full name", exact: true } }, value: "Ada" },
        });
        const checked = await client.call("page.act", {
          pageId,
          action: { type: "check", target: { locator: { kind: "role", role: "switch", name: "Notifications", exact: true } }, checked: true },
        });
        const snapshot = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
        const fullName = snapshot.nodes.find((node) => node.attributes?.id === "full-name");
        const notifications = snapshot.nodes.find((node) => node.attributes?.id === "notifications");
        const passed = filled.verified && filled.proof?.name === "Full name" && filled.proof.value === "Ada"
          && checked.verified && checked.proof?.value === "true"
          && fullName?.state?.value === "Ada" && fullName.state.invalid === undefined
          && notifications?.state?.checked === true;
        return { passed, metrics: { verifiedActions: 2, stateUpdates: passed ? 2 : 0 } };
      },
    },
    {
      id: "semantic-visibility-safety",
      name: "semantic-visibility-safety",
      async run(client) {
        await expectCode(client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Hidden action", exact: true } } } }), "TARGET_NOT_FOUND");
        await expectCode(client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "ARIA hidden action", exact: true } } } }), "TARGET_NOT_FOUND");
        await expectCode(client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Inert action", exact: true } } } }), "TARGET_NOT_FOUND");
        await expectCode(client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Disabled action", exact: true } } } }), "NOT_INTERACTABLE");
        return { passed: true, metrics: { unsafeTargetsRejected: 4 } };
      },
    },
  ];
}

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
    const report = await runAgentEvaluation(client, [...fixtureScenarios(pageId), ...semanticScenarios(pageId)], {
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
