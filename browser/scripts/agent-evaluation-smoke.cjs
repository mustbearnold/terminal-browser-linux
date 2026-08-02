"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {
  AgentClient,
  createAgentEvaluationProvenance,
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
<label for="upload-single">Upload document</label><input id="upload-single" type="file">
<label for="upload-many">Upload attachments</label><input id="upload-many" type="file" multiple>
<input id="upload-hidden" type="file" aria-label="Hidden upload" hidden>
<output id="upload-status">Idle</output>
<label for="full-name">Full name</label><input id="full-name" placeholder="Ignored by label" value="" required>
<button id="schedule-silent-value" aria-label="Schedule silent value" onclick="setTimeout(() => { document.getElementById('full-name').value = 'Silent value'; document.getElementById('silent-button').value = 'New silent action'; document.getElementById('silent-check').checked = true; document.getElementById('silent-choices').options[1].selected = true }, 500)">Schedule silent value</button>
<input id="silent-button" type="button" value="Old silent action">
<input id="silent-check" type="checkbox" aria-label="Silent check">
<select id="silent-choices" multiple aria-label="Silent choices"><option value="silent-a" selected>Silent alpha</option><option value="silent-b">Silent beta</option></select>
<input id="search" type="search" placeholder="Search records">
<input id="amount" type="number" value="3">
<input id="volume" type="range" min="0" max="10" value="4">
<select id="choices" multiple aria-label="Choices"><option value="a" selected>Alpha</option><option value="b">Beta</option></select>
<div id="notifications" role="switch" aria-checked="false" aria-label="Notifications">Notifications</div>
<button id="double" aria-label="Double action">Double action</button>
<button id="pressed" aria-pressed="true">Pressed action</button>
<button id="spaced">  Save <span> now </span> </button>
<button id="continue" aria-label="Continue">Continue</button>
<div id="drag-source" draggable="true" aria-label="Drag source" style="display:inline-block;border:1px solid #888;padding:12px;margin:8px">Drag source</div><div id="drop-target" aria-label="Drop target" style="display:inline-block;border:1px dashed #888;padding:12px;margin:8px">Drop target</div>
<button id="hidden" hidden>Hidden action</button>
<div aria-hidden="true"><button id="aria-hidden">ARIA hidden action</button></div>
<div inert><button id="inert">Inert action</button></div>
<fieldset disabled><button id="disabled">Disabled action</button></fieldset>
<button id="expand" aria-label="Expand" aria-expanded="false">Expand</button>
<input id="readonly" aria-label="Read only" value="Locked" readonly>
<button id="remove" aria-label="Remove me">Remove me</button>
<output id="status">Idle</output>
<script>
  document.getElementById('launch').addEventListener('click', () => document.getElementById('status').textContent = 'Launched');
  document.getElementById('continue').addEventListener('click', () => document.getElementById('status').textContent = 'Ready');
  document.getElementById('notifications').addEventListener('click', event => { event.currentTarget.setAttribute('aria-checked', String(event.currentTarget.getAttribute('aria-checked') !== 'true')); document.getElementById('status').textContent = 'Notifications ' + event.currentTarget.getAttribute('aria-checked') + ' ' + event.isTrusted; });
  let doubleClickCount = 0;
  document.getElementById('double').addEventListener('click', event => { doubleClickCount += 1; document.getElementById('status').textContent = 'Double clicks ' + doubleClickCount + ' detail ' + event.detail + ' trusted ' + event.isTrusted; });
  document.getElementById('double').addEventListener('dblclick', event => { document.getElementById('status').textContent = 'Double dblclick ' + event.detail + ' trusted ' + event.isTrusted; });
  document.getElementById('expand').addEventListener('click', event => event.currentTarget.setAttribute('aria-expanded', String(event.currentTarget.getAttribute('aria-expanded') !== 'true')));
  document.getElementById('remove').addEventListener('click', event => event.currentTarget.remove());
  for (const id of ['upload-single', 'upload-many', 'upload-hidden']) for (const type of ['input', 'change']) document.getElementById(id).addEventListener(type, event => document.getElementById('upload-status').textContent = id + ' ' + type + ' ' + event.isTrusted + ' ' + event.currentTarget.files.length);
  document.getElementById('drag-source').addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', 'drag payload'));
  document.getElementById('drop-target').addEventListener('dragover', event => event.preventDefault());
  document.getElementById('drop-target').addEventListener('drop', event => { event.preventDefault(); document.getElementById('status').textContent = 'Dropped ' + event.dataTransfer.getData('text/plain'); });
</script>`;

const shadowHtml = `<!doctype html><meta charset="utf-8"><title>Shadow evaluation fixture</title><x-control></x-control><x-late></x-late><button aria-label="Attach late control" onclick="const root=document.querySelector('x-late').attachShadow({mode:'closed'});root.innerHTML='<button aria-label=&quot;Late action&quot;>Late action</button>'">Attach late control</button><script>customElements.define('x-control',class extends HTMLElement{constructor(){super();const root=this.attachShadow({mode:'open'});root.innerHTML='<label>Shadow name <input aria-label="Shadow name"></label><label>Shadow upload <input type="file" aria-label="Shadow upload"></label><output id="upload-status">Idle</output><button aria-label="Shadow action">Shadow action</button><span id="status">Idle</span>';const upload=root.querySelector('input[type=file]');for(const type of ['input','change']) upload.addEventListener(type,event=>root.querySelector('#upload-status').textContent=type+' '+event.isTrusted+' '+upload.files.length);root.querySelector('button').addEventListener('click',()=>{root.querySelector('#status').textContent='Clicked';const dynamic=document.createElement('button');dynamic.setAttribute('aria-label','Dynamic action');dynamic.textContent='Dynamic action';root.append(dynamic)})}});</script>`;

const frameChildHtml = `<!doctype html><label>Frame name <input aria-label="Frame name"></label><label>Frame upload <input type="file" aria-label="Frame upload" oninput="document.querySelector('#frame-upload-status').textContent='input '+event.isTrusted+' '+this.files.length" onchange="document.querySelector('#frame-upload-status').textContent='change '+event.isTrusted+' '+this.files.length"></label><output id="frame-upload-status">Idle</output><button aria-label="Frame action" onclick="document.querySelector('#status').textContent='Clicked';const b=document.createElement('button');b.setAttribute('aria-label','Frame dynamic');b.textContent='Frame dynamic';document.body.append(b)">Frame action</button><span id="status">Idle</span>`;
const frameHtml = `<!doctype html><meta charset="utf-8"><title>Frame evaluation fixture</title><iframe title="Control frame"></iframe><script>document.querySelector('iframe').srcdoc=${JSON.stringify(frameChildHtml)}</script>`;

const crossOriginChildHtml = `<!doctype html><label>Frame name <input id="frame-name" aria-label="Frame name"></label><label>Frame choice <select aria-label="Frame choice"><option value="one">One</option><option value="two">Two</option></select></label><label><input id="frame-enabled" type="checkbox" aria-label="Frame enabled">Frame enabled</label><div id="frame-drag-source" draggable="true" aria-label="Frame drag source" style="display:inline-block;border:1px solid #888;padding:10px;margin:8px">Frame drag source</div><div id="frame-drop-target" aria-label="Frame drop target" style="display:inline-block;border:1px dashed #888;padding:10px;margin:8px">Frame drop target</div><output id="frame-drag-status">Idle</output><input id="frame-upload" type="file" aria-label="Frame upload"><button id="schedule-frame-silent" aria-label="Schedule frame silent" onclick="setTimeout(() => { document.getElementById('frame-name').value = 'Silent frame name'; document.getElementById('frame-silent-button').value = 'New frame action'; document.getElementById('frame-enabled').checked = true; document.getElementById('frame-silent-choice').options[1].selected = true }, 500)">Schedule frame silent</button><input id="frame-silent-button" type="button" value="Old frame action"><select id="frame-silent-choice" multiple aria-label="Frame silent choices"><option value="one" selected>Frame silent one</option><option value="two">Frame silent two</option></select><div id="frame-scroll-region" role="region" aria-label="Frame scroll area" style="height:90px;overflow:auto;border:1px solid #888"><div style="height:400px;padding:8px">Scrollable frame content</div></div><button aria-label="Frame action" onclick="document.querySelector('#status').textContent='Clicked';const b=document.createElement('button');b.setAttribute('aria-label','Frame dynamic');b.textContent='Frame dynamic';document.body.append(b)">Frame action</button><span id="status">Idle</span><script>document.getElementById('frame-drag-source').addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', 'frame payload'));document.getElementById('frame-drop-target').addEventListener('dragover', event => event.preventDefault());document.getElementById('frame-drop-target').addEventListener('drop', event => { event.preventDefault(); document.getElementById('frame-drag-status').textContent = 'Frame dropped ' + event.dataTransfer.getData('text/plain'); });document.getElementById('frame-drop-target').addEventListener('mousedown', event => { if (event.button === 1) document.getElementById('frame-drag-status').textContent = 'Middle click ' + event.button + ' ' + event.isTrusted; });document.getElementById('frame-scroll-region').addEventListener('wheel', event => { document.getElementById('frame-drag-status').textContent = 'Wheel ' + event.deltaY + ' ' + event.isTrusted; });</script>`;
const navigationStartHtml = `<!doctype html><meta charset="utf-8"><title>Navigation start</title><button aria-label="Start action">Start action</button><output>Navigation start</output>`;
const navigationNextHtml = `<!doctype html><meta charset="utf-8"><title>Navigation next</title><label>Recovered name <input aria-label="Recovered name"></label><button aria-label="Next action" onclick="document.querySelector('output').textContent='Next clicked'">Next action</button><output>Next ready</output>`;
const eventHtml = `<!doctype html><meta charset="utf-8"><title>Native event fixture</title><button aria-label="Emit console" onclick="console.warn('agent console probe')">Emit console</button><button aria-label="Emit dialog" onclick="alert('agent dialog probe')">Emit dialog</button><button aria-label="Emit confirm" onclick="document.querySelector('#dialog-status').textContent = confirm('agent confirm probe') ? 'Confirmed' : 'Dismissed'">Emit confirm</button><button id="unlock" aria-label="Unlock" disabled>Unlock</button><button aria-label="Schedule update" onclick="setTimeout(() => { document.querySelector('#async-status').textContent = 'Asynchronous update'; document.querySelector('#unlock').disabled = false; setTimeout(() => { document.querySelector('#async-status').textContent = 'Settled' }, 80) }, 180)">Schedule update</button><span id="dialog-status">Idle</span><span id="async-status">Idle</span>`;
const largeWindowHtml = `<!doctype html><meta charset="utf-8"><title>Large window fixture</title><output id="status">Idle</output><div id="controls">${Array.from({ length: 1099 }, (_, index) => `<button id="large-${index}" aria-label="Large ${index}">Large ${index}</button>`).join("")}<button id="tail" data-testid="tail-control" aria-label="Tail action" onclick="document.querySelector('#status').textContent='Tail clicked'">Tail action</button><button id="add-control" aria-label="Add control" onclick="const b=document.createElement('button');b.id='dynamic-control';b.setAttribute('aria-label','Dynamic control');b.textContent='Dynamic control';document.querySelector('#controls').append(b)">Add control</button><button id="retag-control" aria-label="Retag control" onclick="const target=document.querySelector('#tail');target.setAttribute('data-testid','renamed-tail');target.setAttribute('aria-label','Renamed tail')">Retag control</button></div>`;

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error && error.code === code);
}

function snapshotToken(snapshot) {
  return {
    pageId: snapshot.pageId,
    documentId: snapshot.documentId,
    revision: snapshot.revision,
    snapshotId: snapshot.snapshotId,
  };
}

function largeWindowScenarios(pageId) {
  return [{
    id: "large-window-ref-reaches-action",
    name: "large-window-ref-reaches-action",
    async run(client) {
      const tailLocator = { locator: { kind: "role", role: "button", name: "Tail action", exact: true } };
      const liveRead = await client.call("page.read", { pageId, target: tailLocator });
      const roleNameQuery = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Tail action", exact: true },
        options: { limit: 1, diagnostics: "summary" },
      });
      const liveGlobalTextWait = await client.call("page.wait", {
        pageId,
        condition: { type: "text", value: "Tail action" },
        timeoutMs: 1_000,
        output: { snapshot: "none" },
      });
      const liveTargetedTextWait = await client.call("page.wait", {
        pageId,
        condition: { type: "text", value: "Tail action", target: tailLocator },
        timeoutMs: 1_000,
        output: { snapshot: "none" },
      });
      const liveElementWait = await client.call("page.wait", {
        pageId,
        condition: {
          type: "element",
          target: tailLocator,
          state: { attached: true, visible: true, text: "Tail action" },
        },
        timeoutMs: 1_000,
        output: { snapshot: "none" },
      });
      const liveElementExpectation = await client.call("page.act", {
        pageId,
        action: { type: "hover", target: tailLocator },
        expect: { element: { target: tailLocator, state: { attached: true, visible: true } }, timeoutMs: 1_000 },
        output: { snapshot: "none" },
      });
      let ambiguity;
      try {
        await client.call("page.read", {
          pageId,
          target: { locator: { kind: "role", role: "button", name: "Large", exact: false } },
        });
      } catch (error) {
        ambiguity = error;
      }
      const locatedClick = await client.call("page.act", {
        pageId,
        action: { type: "click", target: tailLocator },
        expect: {
          text: "Tail action",
          element: { target: tailLocator, state: { attached: true, visible: true } },
          timeoutMs: 1_000,
        },
        output: { snapshot: "none" },
      });
      const inserted = await client.call("page.act", {
        pageId,
        action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Add control", exact: true } } },
        output: { snapshot: "none" },
      });
      const liveDynamicTextWait = await client.call("page.wait", {
        pageId,
        condition: { type: "text", value: "Dynamic control" },
        timeoutMs: 1_000,
        output: { snapshot: "none" },
      });
      let current = await client.call("page.snapshot.window", {
        pageId,
        options: { limit: 256 },
      });
      let tail;
      let windows = 0;
      while (true) {
        windows += 1;
        tail = current.nodes.find((node) => node.attributes?.id === "tail");
        if (tail || current.done) break;
        if (!current.nextCursor) return { passed: false, reason: "window traversal omitted its continuation cursor" };
        current = await client.call("page.snapshot.window", {
          pageId,
          cursor: current.nextCursor,
        });
      }
      if (!tail) return { passed: false, reason: "window traversal did not expose the tail control" };
      const clicked = await client.call("page.act", {
        pageId,
        token: snapshotToken(current),
        action: { type: "click", target: { ref: tail.ref } },
        expect: { text: "Tail clicked" },
        output: { snapshot: "none" },
      });
      const ambiguityDetails = ambiguity?.details;
      return {
        passed: liveRead.node.attributes?.id === "tail"
          && roleNameQuery.nodes[0]?.attributes?.id === "tail"
          && roleNameQuery.diagnostics?.queries[0]?.elementsEvaluated === 1
          && roleNameQuery.diagnostics.queries[0].elementsEvaluated < roleNameQuery.diagnostics.elementsScanned
          && liveGlobalTextWait.satisfied
          && liveTargetedTextWait.satisfied
          && liveElementWait.satisfied
          && liveGlobalTextWait.snapshot === undefined
          && liveTargetedTextWait.snapshot === undefined
          && liveElementWait.snapshot === undefined
          && inserted.verified
          && liveDynamicTextWait.satisfied
          && liveDynamicTextWait.snapshot === undefined
          && liveElementExpectation.verified
          && ambiguity?.code === "AMBIGUOUS_TARGET"
          && ambiguityDetails?.candidateCount === 1099
          && ambiguityDetails?.candidatesTruncated === true
          && locatedClick.verified
          && clicked.verified,
        metrics: {
          largeWindowPages: windows,
          largeWindowNodes: current.totalNodes,
          largeTargetOffset: current.offset,
          liveLocatorRead: liveRead.node.attributes?.id === "tail" ? 1 : 0,
          roleNameIndexedCandidates: roleNameQuery.diagnostics?.queries[0]?.elementsEvaluated ?? 0,
          liveGlobalTextWait: liveGlobalTextWait.satisfied ? 1 : 0,
          liveTargetedTextWait: liveTargetedTextWait.satisfied ? 1 : 0,
          liveElementWait: liveElementWait.satisfied ? 1 : 0,
          liveDynamicTextWait: liveDynamicTextWait.satisfied ? 1 : 0,
          waitSnapshotsOmitted: [liveGlobalTextWait, liveTargetedTextWait, liveElementWait, liveDynamicTextWait].every((wait) => wait.snapshot === undefined) ? 1 : 0,
          liveElementExpectation: liveElementExpectation.verified ? 1 : 0,
          liveLocatorAction: locatedClick.verified ? 1 : 0,
          ambiguousLiveCandidates: ambiguityDetails?.candidateCount ?? 0,
        },
      };
    },
  }];
}

function batchScenarios(pageId) {
  return [{
    id: "live-action-batch-serializes-dependent-controls",
    name: "live-action-batch-serializes-dependent-controls",
    async run(client) {
      const request = {
        pageId,
        steps: [
          {
            action: {
              type: "fill",
              target: { locator: { kind: "role", role: "searchbox", name: "Search records", exact: true } },
              value: "agent",
            },
          },
          {
            action: { type: "type", text: " records" },
            expect: {
              element: {
                target: { locator: { kind: "role", role: "searchbox", name: "Search records", exact: true } },
                state: { value: "agent records" },
              },
              timeoutMs: 1_000,
            },
          },
          {
            action: {
              type: "select",
              target: { locator: { kind: "role", role: "listbox", name: "Choices", exact: true } },
              values: ["a", "b"],
            },
          },
        ],
        output: { snapshot: "none" },
        idempotencyKey: "evaluation-action-batch-1",
      };
      const batch = await client.call("page.act.batch", request);
      const status = await client.call("page.act.status", {
        pageId,
        idempotencyKey: request.idempotencyKey,
      });
      const replay = await client.call("page.act.batch", request);
      const read = await client.call("page.read", {
        pageId,
        target: { locator: { kind: "role", role: "searchbox", name: "Search records", exact: true } },
      });
      const steps = batch.steps ?? [];
      const passed = batch.verified
        && batch.completed === 3
        && steps.length === 3
        && steps.every((step) => step.status === "completed" && step.result?.verified === true)
        && steps[1]?.result?.proof?.value === "agent records"
        && steps[2]?.result?.proof?.value === "a,b"
        && batch.snapshot === undefined
        && status.status === "completed"
        && status.result?.steps?.length === 3
        && replay.replayed === true
        && read.node.state?.value === "agent records";
      return {
        passed,
        metrics: {
          batchSteps: steps.length,
          batchRequests: 1,
          batchReplay: Number(replay.replayed === true),
          compactBatchOutput: Number(batch.snapshot === undefined),
        },
      };
    },
  }];
}

function queryScenarios(pageId) {
  return [{
    id: "live-query-bounds-dynamic-candidates",
    name: "live-query-bounds-dynamic-candidates",
    async run(client) {
      const broad = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Large", exact: false },
        options: { limit: 5 },
      });
      const queryBatch = await client.call("page.query.batch", {
        pageId,
        queries: [
          {
            locator: { kind: "role", role: "button", name: "Large", exact: false },
            options: { limit: 3 },
          },
          {
            locator: { kind: "role", role: "button", name: "Tail action", exact: true },
            options: { limit: 1 },
          },
        ],
      });
      const plannedBatch = await client.call("page.query.batch", {
        pageId,
        queries: [
          {
            locator: { kind: "css", value: "#controls > button" },
            options: { limit: 8, diagnostics: "summary" },
          },
          {
            locator: { kind: "css", value: "#controls > button" },
            options: { limit: 1, diagnostics: "summary" },
          },
        ],
      });
      const indexedTestId = await client.call("page.query", {
        pageId,
        locator: { kind: "testid", value: "tail-control" },
        options: { limit: 1, diagnostics: "summary" },
      });
      const cssStateFiltered = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: "#tail", state: { visible: false } },
        options: { limit: 1, diagnostics: "summary" },
      });
      const batchBroad = queryBatch.queries[0];
      const tail = queryBatch.queries[1];
      const plannedFirst = plannedBatch.queries[0];
      const plannedSecond = plannedBatch.queries[1];
      const indexed = await client.call("page.read", {
        pageId,
        target: {
          locator: { kind: "role", role: "button", name: "Large", exact: false },
          index: 4,
        },
      });
      const read = await client.call("page.read", {
        pageId,
        target: { ref: tail.nodes[0]?.ref },
        token: snapshotToken(queryBatch),
      });
      const retagged = await client.call("page.act", {
        pageId,
        action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Retag control", exact: true } } },
        output: { snapshot: "none" },
      });
      const renamedTestId = await client.call("page.query", {
        pageId,
        locator: { kind: "testid", value: "renamed-tail" },
        options: { limit: 1, diagnostics: "summary" },
      });
      const renamedRole = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Renamed tail", exact: true },
        options: { limit: 1, diagnostics: "summary" },
      });
      const oldRole = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Tail action", exact: true },
        options: { limit: 1, diagnostics: "summary" },
      });
      const oldTestId = await client.call("page.query", {
        pageId,
        locator: { kind: "testid", value: "tail-control" },
        options: { limit: 1, diagnostics: "summary" },
      });
      const inserted = await client.call("page.act", {
        pageId,
        action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Add control", exact: true } } },
        output: { snapshot: "none" },
      });
      const rebuilt = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: "#dynamic-control" },
        options: { limit: 1, diagnostics: "summary" },
      });
      const dynamicRole = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Dynamic control", exact: true },
        options: { limit: 1, diagnostics: "summary" },
      });
      return {
        passed: broad.matchCount === 1099
          && broad.nodes.length === 5
          && broad.truncated === true
          && batchBroad.matchCount === 1099
          && batchBroad.nodes.length === 3
          && batchBroad.truncated === true
          && indexed.node.attributes?.id === "large-4"
          && broad.hiddenMatchCount === 0
          && tail.matchCount === 1
          && tail.nodes.length === 1
          && tail.truncated === false
          && plannedBatch.diagnostics?.mode === "live"
          && plannedBatch.diagnostics.queriesEvaluated === 2
          && (plannedBatch.diagnostics.planCacheHits ?? 0) > 0
          && plannedFirst.matchCount === plannedSecond.matchCount
          && plannedFirst.nodes.length === 8
          && plannedSecond.nodes.length === 1
          && indexedTestId.nodes[0]?.attributes?.id === "tail"
          && indexedTestId.diagnostics?.queries[0]?.elementsEvaluated === 1
          && cssStateFiltered.matchCount === 0
          && read.node.attributes?.id === "tail"
          && read.revision === queryBatch.revision
          && retagged.verified
          && renamedTestId.nodes[0]?.attributes?.id === "tail"
          && renamedTestId.diagnostics?.queries[0]?.elementsEvaluated === 1
          && oldTestId.matchCount === 0
          && renamedRole.nodes[0]?.attributes?.id === "tail"
          && renamedRole.diagnostics?.queries[0]?.elementsEvaluated === 1
          && oldRole.matchCount === 0
          && (plannedBatch.diagnostics.elementIndexHits ?? 0) > 0
          && inserted.verified
          && rebuilt.nodes[0]?.attributes?.id === "dynamic-control"
          && (rebuilt.diagnostics?.elementIndexRebuilds ?? 0) > 0
          && dynamicRole.matchCount === 2
          && dynamicRole.nodes.length === 1
          && dynamicRole.nodes[0]?.attributes?.id === "dynamic-control"
          && dynamicRole.diagnostics?.queries[0]?.elementsEvaluated === 2,
        metrics: {
          queryMatchCount: broad.matchCount,
          queryCandidates: broad.nodes.length,
          queryTruncated: Number(broad.truncated),
          queryBatchQueries: queryBatch.queries.length,
          queryBatchSharedRevision: Number(read.revision === queryBatch.revision),
          queryPlanCacheHits: plannedBatch.diagnostics?.planCacheHits ?? 0,
          queryPlanReuse: Number((plannedBatch.diagnostics?.planCacheHits ?? 0) > 0),
          indexedAttributeCandidates: indexedTestId.diagnostics?.queries[0]?.elementsEvaluated ?? 0,
          attributeIndexMutation: Number(retagged.verified
            && renamedTestId.nodes[0]?.attributes?.id === "tail"
            && oldTestId.matchCount === 0),
          cssStateFiltered: cssStateFiltered.matchCount === 0 ? 1 : 0,
          elementIndexHits: plannedBatch.diagnostics?.elementIndexHits ?? 0,
          elementIndexRebuilds: rebuilt.diagnostics?.elementIndexRebuilds ?? 0,
          elementIndexFallback: Number((rebuilt.diagnostics?.elementIndexRebuilds ?? 0) > 0),
          indexedLocatorRead: Number(indexed.node.attributes?.id === "large-4"),
          roleNameMutationCandidates: dynamicRole.diagnostics?.queries[0]?.elementsEvaluated ?? 0,
          readRevisionBound: Number(read.revision === queryBatch.revision),
        },
      };
    },
  }];
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
        const roleQuery = await client.call("page.query", {
          pageId,
          locator: { kind: "role", role: "textbox", name: "Full name", exact: true },
          options: { limit: 1, diagnostics: "summary" },
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
          && disabled?.visible === true && disabled.enabled === false
          && roleQuery.nodes[0]?.attributes?.id === "full-name"
          && roleQuery.matchCount === 1
          && roleQuery.diagnostics?.queries[0]?.cacheHit === false
          && roleQuery.diagnostics.queries[0].elementsEvaluated < roleQuery.diagnostics.elementsScanned;
        return {
          passed,
          metrics: {
            semanticNodes: snapshot.nodes.length,
            nativeRoleChecks: [search, amount, volume, choices].filter(Boolean).length,
            stateChecks: [fullName, notifications, pressed, hidden, ariaHidden, inert, disabled].filter(Boolean).length,
            roleIndexedCandidates: roleQuery.diagnostics?.queries[0]?.elementsEvaluated ?? 0,
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
        const compactBase = await client.call("page.snapshot", {
          pageId,
          options: { interactiveOnly: false, includeGeometry: false },
        });
        const initialFormStateWait = await client.call("page.wait", {
          pageId,
          condition: {
            type: "element",
            target: { locator: { kind: "role", role: "textbox", name: "Full name", exact: true } },
            state: { attached: true, invalid: true, required: true },
          },
          timeoutMs: 1_000,
        });
        const silentValueSeed = await client.call("page.query", {
          pageId,
          locator: { kind: "role", role: "textbox", name: "Full name", exact: true },
          options: { limit: 1, diagnostics: "summary" },
        });
        const silentNameSeed = await client.call("page.query", {
          pageId,
          locator: { kind: "role", role: "button", name: "Old silent action", exact: true },
          options: { limit: 1, diagnostics: "summary" },
        });
        const silentCheckSeed = await client.call("page.query", {
          pageId,
          locator: { kind: "role", role: "checkbox", name: "Silent check", exact: true },
          options: { limit: 1, diagnostics: "summary" },
        });
        const silentOptionSeed = await client.call("page.query", {
          pageId,
          locator: { kind: "role", role: "option", name: "Silent beta", exact: true },
          options: { limit: 1, diagnostics: "summary" },
        });
        const silentPropertyBase = await client.call("page.snapshot", {
          pageId,
          options: { interactiveOnly: false, includeGeometry: false },
        });
        const scheduleSilentValue = await client.call("page.act", {
          pageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Schedule silent value", exact: true } } },
          output: { snapshot: "none" },
        });
        await new Promise((resolve) => setTimeout(resolve, 700));
        const silentValueAfter = await client.call("page.query", {
          pageId,
          locator: { kind: "role", role: "textbox", name: "Full name", exact: true },
          options: { limit: 1, diagnostics: "summary" },
        });
        const silentNameAfter = await client.call("page.query", {
          pageId,
          locator: { kind: "role", role: "button", name: "New silent action", exact: true },
          options: { limit: 1, diagnostics: "summary" },
        });
        const silentCheckAfter = await client.call("page.query", {
          pageId,
          locator: { kind: "role", role: "checkbox", name: "Silent check", exact: true, state: { checked: true } },
          options: { limit: 1, diagnostics: "summary" },
        });
        const silentOptionAfter = await client.call("page.query", {
          pageId,
          locator: { kind: "role", role: "option", name: "Silent beta", exact: true, state: { selected: true } },
          options: { limit: 1, diagnostics: "summary" },
        });
        const silentPropertyDelta = await client.call("page.snapshot.delta", {
          pageId,
          base: snapshotToken(silentPropertyBase),
        });
        const focused = await client.call("page.act", {
          pageId,
          action: { type: "focus", target: { locator: { kind: "role", role: "textbox", name: "Full name", exact: true } } },
          output: { snapshot: "none" },
        });
        const filled = await client.call("page.act", {
          pageId,
          action: { type: "fill", target: { locator: { kind: "role", role: "textbox", name: "Full name", exact: true } }, value: "Ada" },
          output: { snapshot: "none" },
        });
        const checked = await client.call("page.act", {
          pageId,
          action: { type: "check", target: { locator: { kind: "role", role: "switch", name: "Notifications", exact: true } }, checked: true },
          output: { snapshot: "delta", base: snapshotToken(compactBase) },
        });
        const trustedCheckStatus = await client.call("page.wait", {
          pageId,
          condition: { type: "text", value: "Notifications true true" },
          timeoutMs: 1_000,
          output: { snapshot: "none" },
        });
        const valueWait = await client.call("page.wait", {
          pageId,
          condition: {
            type: "element",
            target: { locator: { kind: "role", role: "textbox", name: "Full name", exact: true } },
            state: { visible: true, enabled: true, value: "Ada" },
          },
          timeoutMs: 1_000,
        });
        const checkedWait = await client.call("page.wait", {
          pageId,
          condition: {
            type: "element",
            target: { locator: { kind: "role", role: "switch", name: "Notifications", exact: true } },
            state: { checked: true },
          },
          timeoutMs: 1_000,
        });
        const validWait = await client.call("page.wait", {
          pageId,
          condition: {
            type: "element",
            target: { locator: { kind: "role", role: "textbox", name: "Full name", exact: true } },
            state: { attached: true, invalid: false, required: true },
          },
          timeoutMs: 1_000,
        });
        const disabledWait = await client.call("page.wait", {
          pageId,
          condition: {
            type: "element",
            target: { locator: { kind: "role", role: "button", name: "Disabled action", exact: true } },
            state: { attached: true, enabled: false, disabled: true },
          },
          timeoutMs: 1_000,
        });
        const pressedWait = await client.call("page.wait", {
          pageId,
          condition: {
            type: "element",
            target: { locator: { kind: "role", role: "button", name: "Pressed action", exact: true } },
            state: { pressed: true },
          },
          timeoutMs: 1_000,
        });
        const selectedWait = await client.call("page.wait", {
          pageId,
          condition: {
            type: "element",
            target: { locator: { kind: "role", role: "option", name: "Alpha", exact: true } },
            state: { selected: true },
          },
          timeoutMs: 1_000,
        });
        const readOnlyWait = await client.call("page.wait", {
          pageId,
          condition: {
            type: "element",
            target: { locator: { kind: "role", role: "textbox", name: "Read only", exact: true } },
            state: { readOnly: true },
          },
          timeoutMs: 1_000,
        });
        const collapsedWait = await client.call("page.wait", {
          pageId,
          condition: {
            type: "element",
            target: { locator: { kind: "role", role: "button", name: "Expand", exact: true } },
            state: { expanded: false },
          },
          timeoutMs: 1_000,
        });
        const expandedAction = await client.call("page.act", {
          pageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Expand", exact: true } } },
          expect: {
            element: {
              target: { locator: { kind: "role", role: "button", name: "Expand", exact: true } },
              state: { expanded: true },
            },
            timeoutMs: 1_000,
          },
        });
        const expandedWait = await client.call("page.wait", {
          pageId,
          condition: {
            type: "element",
            target: { locator: { kind: "role", role: "button", name: "Expand", exact: true } },
            state: { expanded: true },
          },
          timeoutMs: 1_000,
        });
        const removedAction = await client.call("page.act", {
          pageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Remove me", exact: true } } },
          expect: {
            element: {
              target: { locator: { kind: "role", role: "button", name: "Remove me", exact: true } },
              state: { attached: false },
            },
            timeoutMs: 1_000,
          },
        });
        const doubleClicked = await client.call("page.act", {
          pageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Double action", exact: true } }, clickCount: 2 },
          expect: { text: "Double dblclick 2 trusted true", timeoutMs: 1_000 },
          output: { snapshot: "none" },
        });
        const detachedWait = await client.call("page.wait", {
          pageId,
          condition: {
            type: "element",
            target: { locator: { kind: "role", role: "button", name: "Remove me", exact: true } },
            state: { attached: false },
          },
          timeoutMs: 1_000,
        });
        const wrongTargetedTextWait = await client.call("page.wait", {
          pageId,
          condition: {
            type: "text",
            value: "Ready",
            target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } },
          },
          timeoutMs: 100,
        });
        const snapshot = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
        const fullName = snapshot.nodes.find((node) => node.attributes?.id === "full-name");
        const notifications = snapshot.nodes.find((node) => node.attributes?.id === "notifications");
        const compactProof = filled.proof?.pageId === pageId
          && typeof filled.proof?.documentId === "string"
          && Number.isSafeInteger(filled.proof?.revision)
          && typeof filled.proof?.frameId === "string";
        const passed = focused.verified && focused.proof?.focused === true
          && filled.verified && filled.proof?.name === "Full name" && filled.proof.value === "Ada"
          && compactProof
          && scheduleSilentValue.verified
          && silentValueSeed.nodes[0]?.state?.value === ""
          && silentValueAfter.nodes[0]?.state?.value === "Silent value"
          && silentValueAfter.diagnostics?.queries[0]?.cacheHit === false
          && silentNameSeed.nodes[0]?.attributes?.id === "silent-button"
          && silentNameAfter.nodes[0]?.attributes?.id === "silent-button"
          && silentNameAfter.diagnostics?.queries[0]?.elementsEvaluated === 1
          && silentCheckSeed.nodes[0]?.state?.checked === false
          && silentCheckAfter.nodes[0]?.attributes?.id === "silent-check"
          && silentCheckAfter.nodes[0]?.state?.checked === true
          && silentOptionSeed.nodes[0]?.state?.selected === false
          && silentOptionAfter.nodes[0]?.name === "Silent beta"
          && silentOptionAfter.nodes[0]?.state?.selected === true
          && silentPropertyDelta.revision > silentPropertyBase.revision
          && silentPropertyDelta.mode === "full"
          && silentPropertyDelta.updated.some((entry) => entry.node.attributes?.id === "silent-check")
          && silentPropertyDelta.updated.some((entry) => entry.node.name === "Silent beta")
          && checked.verified && checked.proof?.value === "true"
          && trustedCheckStatus.satisfied
          && doubleClicked.verified
          && initialFormStateWait.satisfied && valueWait.satisfied && validWait.satisfied
          && checkedWait.satisfied && disabledWait.satisfied && pressedWait.satisfied
          && selectedWait.satisfied && readOnlyWait.satisfied && collapsedWait.satisfied
          && expandedAction.verified && expandedWait.satisfied
          && removedAction.verified && detachedWait.satisfied
          && wrongTargetedTextWait.satisfied === false
          && fullName?.state?.value === "Ada" && fullName.state.invalid === undefined
          && notifications?.state?.checked === true
          && filled.snapshot === undefined
          && checked.snapshot === undefined
          && checked.snapshotDelta?.base.snapshotId === compactBase.snapshotId;
        return {
          passed,
          metrics: {
            verifiedActions: 4,
            stateUpdates: passed ? 4 : 0,
            elementWaits: [
              initialFormStateWait,
              valueWait,
              validWait,
              checkedWait,
              disabledWait,
              pressedWait,
              selectedWait,
              readOnlyWait,
              collapsedWait,
              expandedWait,
              detachedWait,
            ].filter((wait) => wait.satisfied).length,
            attachedWaits: Number(initialFormStateWait.satisfied) + Number(detachedWait.satisfied),
            targetedTextWaits: Number(wrongTargetedTextWait.satisfied === false),
            silentFormStateRefresh: Number(scheduleSilentValue.verified
              && silentValueSeed.nodes[0]?.state?.value === ""
              && silentValueAfter.nodes[0]?.state?.value === "Silent value"
              && silentValueAfter.diagnostics?.queries[0]?.cacheHit === false),
            silentRoleNameRefresh: Number(silentNameSeed.nodes[0]?.attributes?.id === "silent-button"
              && silentNameAfter.nodes[0]?.attributes?.id === "silent-button"
              && silentNameAfter.diagnostics?.queries[0]?.elementsEvaluated === 1),
            silentCheckedRefresh: Number(silentCheckAfter.nodes[0]?.state?.checked === true),
            silentSelectedRefresh: Number(silentOptionAfter.nodes[0]?.state?.selected === true),
            silentPropertyDelta: Number(silentPropertyDelta.revision > silentPropertyBase.revision
              && silentPropertyDelta.mode === "full"),
            compactActionOutputs: Number(filled.snapshot === undefined && checked.snapshotDelta !== undefined && compactProof),
            trustedCheckEvents: Number(trustedCheckStatus.satisfied),
            nativeDoubleClick: Number(doubleClicked.verified),
            targetedElementExpectations: Number(expandedAction.verified && removedAction.verified),
            focusVerified: Number(focused.verified && focused.proof?.focused === true),
          },
        };
      },
    },
    {
      id: "semantic-visibility-safety",
      name: "semantic-visibility-safety",
      async run(client) {
        const hiddenWait = await client.call("page.wait", {
          pageId,
          condition: {
            type: "element",
            target: { locator: { kind: "role", role: "button", name: "Hidden action", exact: true } },
            state: { visible: false },
          },
          timeoutMs: 1_000,
        });
        await expectCode(client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Hidden action", exact: true } } } }), "TARGET_NOT_FOUND");
        await expectCode(client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "ARIA hidden action", exact: true } } } }), "TARGET_NOT_FOUND");
        await expectCode(client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Inert action", exact: true } } } }), "TARGET_NOT_FOUND");
        await expectCode(client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Disabled action", exact: true } } } }), "NOT_INTERACTABLE");
        return { passed: hiddenWait.satisfied === true, metrics: { unsafeTargetsRejected: 4, hiddenWaits: Number(hiddenWait.satisfied) } };
      },
    },
  ];
}

function uploadScenarios(pageId, uploadPaths) {
  return [{
    id: "file-input-upload-and-clear",
    name: "file-input-upload-and-clear",
    async run(client) {
      await client.call("page.wait", { pageId, condition: { type: "text", value: "Upload document" }, timeoutMs: 3_000 });
      await client.call("page.wait", { pageId, condition: { type: "stable", quietMs: 50 }, timeoutMs: 3_000 });
      const initial = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
      const single = initial.nodes.find((node) => node.attributes?.id === "upload-single");
      const many = initial.nodes.find((node) => node.attributes?.id === "upload-many");
      const singleQuery = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: "#upload-single" },
        options: { limit: 1, diagnostics: "summary" },
      });
      const singleUpload = await client.call("page.act", {
        pageId,
        action: { type: "upload", target: { ref: singleQuery.nodes[0].ref }, paths: [uploadPaths[0]] },
        expect: { element: { target: { locator: { kind: "css", value: "#upload-single" } }, state: { fileCount: 1 } }, timeoutMs: 1_000 },
        output: { snapshot: "none" },
      });
      const singleAfter = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: "#upload-single" },
        options: { limit: 1, diagnostics: "summary" },
      });
      const manyQuery = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: "#upload-many" },
        options: { limit: 1, diagnostics: "summary" },
      });
      const manyUpload = await client.call("page.act", {
        pageId,
        action: { type: "upload", target: { ref: manyQuery.nodes[0].ref }, paths: uploadPaths },
        expect: { element: { target: { locator: { kind: "css", value: "#upload-many" } }, state: { fileCount: 2 } }, timeoutMs: 1_000 },
        output: { snapshot: "none" },
      });
      const hiddenQuery = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: "#upload-hidden" },
        options: { includeHidden: true, limit: 1, diagnostics: "summary" },
      });
      const hiddenTargetSnapshot = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
      const hiddenTarget = hiddenTargetSnapshot.nodes.find((node) => node.attributes?.id === "upload-hidden");
      const hiddenUpload = await client.call("page.act", {
        pageId,
        action: { type: "upload", target: { ref: hiddenTarget.ref }, paths: [uploadPaths[0]] },
        expect: { element: { target: { locator: { kind: "css", value: "#upload-hidden" } }, state: { fileCount: 1 } }, timeoutMs: 1_000 },
        output: { snapshot: "none" },
      });
      await client.call("page.wait", { pageId, condition: { type: "stable", quietMs: 50 }, timeoutMs: 3_000 });
      const clearTargetSnapshot = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
      const clearTarget = clearTargetSnapshot.nodes.find((node) => node.attributes?.id === "upload-hidden");
      const cleared = await client.call("page.act", {
        pageId,
        action: { type: "upload", target: { ref: clearTarget.ref }, paths: [] },
        expect: { element: { target: { locator: { kind: "css", value: "#upload-hidden" } }, state: { fileCount: 0 } }, timeoutMs: 1_000 },
        output: { snapshot: "none" },
      });
      const uploadStatus = await client.call("page.read", {
        pageId,
        target: { locator: { kind: "css", value: "#upload-status" } },
      });
      const passed = single?.state?.fileCount === 0
        && many?.state?.fileCount === 0
        && hiddenQuery.nodes[0]?.attributes?.id === "upload-hidden"
        && singleUpload.verified
        && singleUpload.proof?.fileCount === 1
        && singleUpload.snapshot === undefined
        && singleAfter.nodes[0]?.state?.fileCount === 1
        && singleAfter.diagnostics?.queries[0]?.cacheHit === false
        && manyUpload.verified
        && manyUpload.proof?.fileCount === 2
        && hiddenUpload.verified
        && hiddenUpload.proof?.fileCount === 1
        && cleared.verified
        && cleared.proof?.fileCount === 0
        && uploadStatus.node.text === "upload-hidden change false 0";
      return {
        passed,
        metrics: {
          fileInputs: [single, many, hiddenQuery.nodes[0]].filter(Boolean).length,
          initialSingleQuery: singleQuery.nodes.length,
          singleUpload: Number(singleUpload.verified && singleUpload.proof?.fileCount === 1),
          multipleUpload: Number(manyUpload.verified && manyUpload.proof?.fileCount === 2),
          hiddenUpload: Number(hiddenUpload.verified),
          clearUpload: Number(cleared.verified && cleared.proof?.fileCount === 0),
          clearUploadEvent: Number(uploadStatus.node.text === "upload-hidden change false 0"),
          singleAfterFileCount: singleAfter.nodes[0]?.state?.fileCount ?? -1,
          volatileFileStateRefresh: Number(singleAfter.diagnostics?.queries[0]?.cacheHit === false),
        },
      };
    },
  }];
}

function dragScenarios(pageId) {
  return [{
    id: "native-drag-and-drop-action",
    name: "native-drag-and-drop-action",
    async run(client) {
      const source = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: "#drag-source" },
        options: { limit: 1, diagnostics: "summary" },
      });
      const target = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: "#drop-target" },
        options: { limit: 1, diagnostics: "summary" },
      });
      const dragged = await client.call("page.act", {
        pageId,
        action: {
          type: "drag",
          source: { ref: source.nodes[0].ref },
          target: { ref: target.nodes[0].ref },
        },
        expect: { text: "Dropped drag payload", timeoutMs: 1_000 },
        output: { snapshot: "none" },
      });
      const status = await client.call("page.read", {
        pageId,
        target: { locator: { kind: "css", value: "#status" } },
      });
      const passed = source.nodes[0]?.attributes?.id === "drag-source"
        && target.nodes[0]?.attributes?.id === "drop-target"
        && dragged.verified
        && dragged.proof?.source === source.nodes[0].ref
        && dragged.proof?.target === target.nodes[0].ref
        && dragged.proof?.frameId === "main"
        && status.node.text === "Dropped drag payload";
      return {
        passed,
        metrics: {
          sourceCandidates: source.matchCount,
          targetCandidates: target.matchCount,
          dragVerified: Number(dragged.verified),
          dragProofEndpoints: Number(Boolean(dragged.proof?.source && dragged.proof?.target)),
        },
      };
    },
  }];
}

function shadowScenarios(pageId, uploadPaths) {
  return [{
    id: "shadow-dom-resolution-and-mutation",
    name: "shadow-dom-resolution-and-mutation",
    async run(client) {
      await client.call("page.wait", { pageId, condition: { type: "text", value: "Shadow action" }, timeoutMs: 3_000 });
      const initial = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
      const shadowButton = initial.nodes.find((node) => node.name === "Shadow action");
      const shadowTextbox = initial.nodes.find((node) => node.name === "Shadow name");
      const liveShadow = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Shadow action", exact: true },
      });
      const liveShadowButton = liveShadow.nodes[0];
      const focused = await client.call("page.act", {
        pageId,
        action: { type: "focus", target: { locator: { kind: "role", role: "textbox", name: "Shadow name", exact: true } } },
        output: { snapshot: "none" },
      });
      const filled = await client.call("page.act", {
        pageId,
        action: { type: "fill", target: { locator: { kind: "role", role: "textbox", name: "Shadow name", exact: true } }, value: "Ada" },
      });
      const typed = await client.call("page.act", {
        pageId,
        action: {
          type: "type",
          text: " Lovelace",
          target: { locator: { kind: "role", role: "textbox", name: "Shadow name", exact: true } },
        },
      });
      const clicked = await client.call("page.act", {
        pageId,
        action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Shadow action", exact: true } } },
        expect: { text: "Clicked", timeoutMs: 3_000 },
      });
      const shadowUpload = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: 'input[aria-label="Shadow upload"]' },
        options: { limit: 1, diagnostics: "summary" },
      });
      const shadowUploaded = await client.call("page.act", {
        pageId,
        action: { type: "upload", target: { ref: shadowUpload.nodes[0].ref }, paths: [uploadPaths[0]] },
        expect: { element: { target: { locator: { kind: "css", value: 'input[aria-label="Shadow upload"]' } }, state: { fileCount: 1 } }, timeoutMs: 1_000 },
        output: { snapshot: "none" },
      });
      const shadowClearTarget = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: 'input[aria-label="Shadow upload"]' },
        options: { limit: 1, diagnostics: "summary" },
      });
      const shadowCleared = await client.call("page.act", {
        pageId,
        action: { type: "upload", target: { ref: shadowClearTarget.nodes[0].ref }, paths: [] },
        expect: { element: { target: { locator: { kind: "css", value: 'input[aria-label="Shadow upload"]' } }, state: { fileCount: 0 } }, timeoutMs: 1_000 },
        output: { snapshot: "none" },
      });
      const shadowUploadStatus = await client.call("page.read", {
        pageId,
        target: { locator: { kind: "css", value: "#upload-status" } },
      });
      const after = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
      const dynamic = after.nodes.find((node) => node.name === "Dynamic action");
      const attachedLate = await client.call("page.act", {
        pageId,
        action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Attach late control", exact: true } } },
        output: { snapshot: "none" },
      });
      const late = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Late action", exact: true },
        options: { limit: 1, diagnostics: "summary" },
      });
      const passed = shadowButton?.frameId === "main" && shadowTextbox?.frameId === "main"
        && Boolean(liveShadowButton?.parent)
        && focused.verified && focused.proof?.focused === true
        && filled.verified && typed.proof?.value === "Ada Lovelace" && clicked.verified && Boolean(dynamic)
        && attachedLate.verified
        && late.matchCount === 1
        && late.nodes[0]?.name === "Late action"
        && late.nodes[0]?.parent
        && late.diagnostics?.queries[0]?.elementsEvaluated === 1
        && shadowUpload.nodes[0]?.name === "Shadow upload"
        && shadowUploaded.verified && shadowUploaded.proof?.fileCount === 1
        && shadowCleared.verified && shadowCleared.proof?.fileCount === 0
        && shadowUploadStatus.node.text === "change false 0";
      return {
        passed,
        metrics: {
          shadowControls: [shadowButton, shadowTextbox].filter(Boolean).length,
          shadowMutations: dynamic ? 1 : 0,
          shadowAncestry: Number(Boolean(liveShadowButton?.parent)),
          lateShadowRoot: Number(attachedLate.verified && late.matchCount === 1),
          lateShadowCandidates: late.diagnostics?.queries[0]?.elementsEvaluated ?? 0,
          shadowFileUpload: Number(shadowUploaded.verified && shadowUploaded.proof?.fileCount === 1),
          shadowFileClear: Number(shadowCleared.verified && shadowCleared.proof?.fileCount === 0),
          shadowFileClearEvent: Number(shadowUploadStatus.node.text === "change false 0"),
          shadowFocus: Number(focused.verified && focused.proof?.focused === true),
        },
      };
    },
  }];
}

function frameScenarios(pageId, uploadPaths) {
  return [{
    id: "same-origin-frame-resolution-and-mutation",
    name: "same-origin-frame-resolution-and-mutation",
    async run(client) {
      await client.call("page.wait", {
        pageId,
        condition: {
          type: "element",
          target: { locator: { kind: "role", role: "button", name: "Frame action", exact: true } },
          state: { attached: true },
        },
        timeoutMs: 3_000,
      });
      const initial = await client.call("page.snapshot", { pageId, options: { includeGeometry: true } });
      const frameButton = initial.nodes.find((node) => node.name === "Frame action");
      const frameTextbox = initial.nodes.find((node) => node.name === "Frame name");
      const focused = await client.call("page.act", {
        pageId,
        action: { type: "focus", target: { locator: { kind: "role", role: "textbox", name: "Frame name", exact: true } } },
        output: { snapshot: "none" },
      });
      const filled = await client.call("page.act", {
        pageId,
        action: { type: "fill", target: { locator: { kind: "role", role: "textbox", name: "Frame name", exact: true } }, value: "Ada" },
      });
      const frameUpload = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: 'input[aria-label="Frame upload"]' },
        options: { limit: 1, diagnostics: "summary" },
      });
      const frameUploaded = await client.call("page.act", {
        pageId,
        action: { type: "upload", target: { ref: frameUpload.nodes[0].ref }, paths: [uploadPaths[0]] },
        expect: { element: { target: { locator: { kind: "css", value: 'input[aria-label="Frame upload"]' } }, state: { fileCount: 1 } }, timeoutMs: 1_000 },
        output: { snapshot: "none" },
      });
      const frameClearTarget = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: 'input[aria-label="Frame upload"]' },
        options: { limit: 1, diagnostics: "summary" },
      });
      const frameCleared = await client.call("page.act", {
        pageId,
        action: { type: "upload", target: { ref: frameClearTarget.nodes[0].ref }, paths: [] },
        expect: { element: { target: { locator: { kind: "css", value: 'input[aria-label="Frame upload"]' } }, state: { fileCount: 0 } }, timeoutMs: 1_000 },
        output: { snapshot: "none" },
      });
      const frameUploadStatus = await client.call("page.read", {
        pageId,
        target: { locator: { kind: "css", value: "#frame-upload-status" } },
      });
      const clicked = await client.call("page.act", {
        pageId,
        action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Frame action", exact: true } } },
        expect: { text: "Clicked", timeoutMs: 3_000 },
      });
      const after = await client.call("page.snapshot", { pageId, options: { includeGeometry: true } });
      const dynamic = after.nodes.find((node) => node.name === "Frame dynamic");
      const passed = Boolean(frameButton?.frameId && frameButton.frameId !== "main")
        && frameTextbox?.frameId === frameButton.frameId && frameButton.box?.width > 0
        && focused.verified && focused.proof?.focused === true
        && filled.verified && frameUploaded.verified && frameUploaded.proof?.fileCount === 1
        && frameCleared.verified && frameCleared.proof?.fileCount === 0
        && frameUploadStatus.node.text === "change false 0"
        && clicked.verified && dynamic?.frameId === frameButton.frameId;
      return {
        passed,
        metrics: {
          frameControls: [frameButton, frameTextbox].filter(Boolean).length,
          frameMutations: dynamic ? 1 : 0,
          frameFileUpload: Number(frameUploaded.verified && frameUploaded.proof?.fileCount === 1),
          frameFileClear: Number(frameCleared.verified && frameCleared.proof?.fileCount === 0),
          frameFileClearEvent: Number(frameUploadStatus.node.text === "change false 0"),
          frameFocus: Number(focused.verified && focused.proof?.focused === true),
        },
      };
    },
  }];
}

function crossOriginScenarios(pageId, uploadPaths) {
  return [{
    id: "cross-origin-frame-actions-and-replay",
    name: "cross-origin-frame-actions-and-replay",
    async run(client) {
      await client.call("page.wait", {
        pageId,
        condition: {
          type: "element",
          target: { locator: { kind: "role", role: "button", name: "Frame action", exact: true } },
          state: { attached: true },
        },
        timeoutMs: 5_000,
      });
      const frames = await client.frames(pageId);
      const childFrame = frames.frames.find((frame) => frame.parentFrameId !== null);
      const initial = await client.call("page.snapshot", { pageId, options: { includeGeometry: true } });
      const frameButton = initial.nodes.find((node) => node.name === "Frame action");
      const frameTextbox = initial.nodes.find((node) => node.name === "Frame name");
      const frameScopedRead = await client.call("page.read", {
        pageId,
        target: {
          locator: { kind: "css", value: "button" },
          index: 1,
          frameId: frameButton?.frameId,
        },
      });
      const frameSilentValueSeed = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "textbox", name: "Frame name", exact: true },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      const frameSilentNameSeed = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Old frame action", exact: true },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      const frameSilentCheckSeed = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "checkbox", name: "Frame enabled", exact: true },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      const frameSilentOptionSeed = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "option", name: "Frame silent two", exact: true },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      const frameSilentBase = await client.call("page.snapshot", {
        pageId,
        options: { interactiveOnly: false, includeGeometry: false },
      });
      const frameSilentSchedule = await client.call("page.act", {
        pageId,
        action: {
          type: "click",
          target: { locator: { kind: "role", role: "button", name: "Schedule frame silent", exact: true, frameId: frameButton.frameId } },
        },
        expect: {
          element: {
            target: { locator: { kind: "role", role: "button", name: "Schedule frame silent", exact: true, frameId: frameButton.frameId } },
            state: { attached: true, visible: true },
          },
          timeoutMs: 1_000,
        },
        output: { snapshot: "none" },
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const frameSilentValueAfter = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "textbox", name: "Frame name", exact: true },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      const frameSilentNameAfter = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "New frame action", exact: true },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      const frameSilentCheckAfter = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "checkbox", name: "Frame enabled", exact: true, state: { checked: true } },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      const frameSilentOptionAfter = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "option", name: "Frame silent two", exact: true, state: { selected: true } },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      const frameSilentDelta = await client.call("page.snapshot.delta", {
        pageId,
        base: snapshotToken(frameSilentBase),
      });
      const frameUploadQuery = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: "#frame-upload" },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      const frameUpload = await client.call("page.act", {
        pageId,
        action: {
          type: "upload",
          target: { ref: frameUploadQuery.nodes[0].ref },
          paths: [uploadPaths[0]],
        },
        expect: {
          element: {
            target: { locator: { kind: "css", value: "#frame-upload" }, frameId: frameButton.frameId },
            state: { fileCount: 1 },
          },
          timeoutMs: 1_000,
        },
        output: { snapshot: "none" },
      });
      const frameDragSource = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: "#frame-drag-source" },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      const frameDropTarget = await client.call("page.query", {
        pageId,
        locator: { kind: "css", value: "#frame-drop-target" },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      const frameDragged = await client.call("page.act", {
        pageId,
        action: {
          type: "drag",
          source: { ref: frameDragSource.nodes[0].ref },
          target: { ref: frameDropTarget.nodes[0].ref },
        },
        expect: {
          element: {
            target: { locator: { kind: "css", value: "#frame-drag-status" }, frameId: frameButton.frameId },
            state: { text: "Frame dropped frame payload" },
          },
          timeoutMs: 1_000,
        },
        output: { snapshot: "none" },
      });
      const frameMiddleClicked = await client.call("page.act", {
        pageId,
        action: {
          type: "click",
          target: { locator: { kind: "css", value: "#frame-drop-target" }, frameId: frameButton.frameId },
          button: "middle",
        },
        expect: {
          element: {
            target: { locator: { kind: "css", value: "#frame-drag-status" }, frameId: frameButton.frameId },
            state: { text: "Middle click 1 true" },
          },
          timeoutMs: 1_000,
        },
        output: { snapshot: "none" },
      });
      const childCacheSeed = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Frame action", exact: true },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      const globalCacheSeed = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Frame action", exact: true },
        options: { limit: 1, diagnostics: "summary" },
      });
      const parentMutation = await client.call("page.act", {
        pageId,
        action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Parent action", exact: true } } },
        expect: { title: "Cross-origin updated", timeoutMs: 1_000 },
      });
      const childCacheAfterParentMutation = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Frame action", exact: true },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      const globalCacheAfterParentMutation = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Frame action", exact: true },
        options: { limit: 1, diagnostics: "summary" },
      });
      const focused = await client.call("page.act", {
        pageId,
        action: {
          type: "focus",
          target: {
            locator: { kind: "role", role: "textbox", name: "Frame name", exact: true },
            frameId: frameTextbox.frameId,
          },
        },
        output: { snapshot: "none" },
      });
      const hovered = await client.call("page.act", {
        pageId,
        action: { type: "hover", target: { locator: { kind: "css", value: 'button[aria-label="Frame action"]' } } },
      });
      const scrolled = await client.call("page.act", {
        pageId,
        idempotencyKey: "evaluation-cross-origin-scroll-1",
        action: { type: "scroll", target: { locator: { kind: "role", role: "region", name: "Frame scroll area", exact: true } }, direction: "down", amount: 60 },
        expect: { text: "Wheel 60 true", timeoutMs: 1_000 },
      });
      const selected = await client.call("page.act", {
        pageId,
        action: { type: "select", target: { locator: { kind: "role", role: "combobox", name: "Frame choice", exact: true } }, values: ["two"] },
      });
      const checked = await client.call("page.act", {
        pageId,
        action: { type: "check", target: { locator: { kind: "role", role: "checkbox", name: "Frame enabled", exact: true } }, checked: true },
      });
      const filled = await client.call("page.act", {
        pageId,
        action: { type: "fill", target: { locator: { kind: "role", role: "textbox", name: "Frame name", exact: true } }, value: "Ada" },
      });
      const typed = await client.call("page.act", {
        pageId,
        action: {
          type: "type",
          text: " Lovelace",
          target: {
            locator: { kind: "role", role: "textbox", name: "Frame name", exact: true },
            frameId: frameTextbox.frameId,
          },
        },
      });
      const clicked = await client.call("page.act", {
        pageId,
        action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Frame action", exact: true } } },
        expect: { text: "Clicked", timeoutMs: 5_000 },
      });
      const retry = await client.call("page.act", {
        pageId,
        idempotencyKey: "evaluation-cross-origin-scroll-1",
        action: { type: "scroll", target: { locator: { kind: "role", role: "region", name: "Frame scroll area", exact: true } }, direction: "down", amount: 60 },
        expect: { text: "Wheel 60 true", timeoutMs: 1_000 },
      });
      const mutated = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
      const dynamic = mutated.nodes.find((node) => node.name === "Frame dynamic");
      const lifecycleEvents = [];
      const unsubscribe = client.onEvent((event) => {
        if (event.event === "frame.lifecycle") lifecycleEvents.push(event);
      });
      try {
        await client.observe(pageId, ["frame.lifecycle"]);
        await client.call("page.act", {
          pageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Navigate frame", exact: true } } },
        });
        const navigatedFrame = await waitFor(async () => {
          const tree = await client.frames(pageId);
          return tree.frames.find((frame) => frame.parentFrameId !== null && frame.url.endsWith("/frame-next.html"));
        });
        await client.call("page.act", {
          pageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Remove frame", exact: true } } },
        });
        await waitFor(async () => {
          const tree = await client.frames(pageId);
          return tree.frames.every((frame) => frame.parentFrameId === null) ? tree : undefined;
        });
        await client.call("page.act", {
          pageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Add frame", exact: true } } },
        });
        const restoredFrame = await waitFor(async () => {
          const tree = await client.frames(pageId);
          return tree.frames.find((frame) => frame.parentFrameId !== null && frame.url.endsWith("/frame-restored.html"));
        });
        const lifecycleTransitions = lifecycleEvents.filter((event) => ["navigated", "detached", "attached"].includes(event.data?.type));
        const passed = Boolean(childFrame && frameButton?.frameId && frameButton.frameId !== "main")
          && frameTextbox?.frameId === frameButton.frameId && frameButton.box?.width > 0
          && frameScopedRead.node.ref === frameButton.ref
          && frameSilentSchedule.verified
          && frameSilentValueSeed.nodes[0]?.state?.value === ""
          && frameSilentValueAfter.nodes[0]?.state?.value === "Silent frame name"
          && frameSilentValueAfter.diagnostics?.queries[0]?.cacheHit === false
          && frameSilentNameSeed.nodes[0]?.attributes?.id === "frame-silent-button"
          && frameSilentNameAfter.nodes[0]?.attributes?.id === "frame-silent-button"
          && frameSilentNameAfter.diagnostics?.queries[0]?.elementsEvaluated === 1
          && frameSilentCheckSeed.nodes[0]?.state?.checked === false
          && frameSilentCheckAfter.nodes[0]?.attributes?.id === "frame-enabled"
          && frameSilentCheckAfter.nodes[0]?.state?.checked === true
          && frameSilentOptionSeed.nodes[0]?.state?.selected === false
          && frameSilentOptionAfter.nodes[0]?.name === "Frame silent two"
          && frameSilentOptionAfter.nodes[0]?.state?.selected === true
          && frameSilentDelta.revision > frameSilentBase.revision
          && frameSilentDelta.mode === "full"
          && frameSilentDelta.updated.some((entry) => entry.node.attributes?.id === "frame-enabled")
          && frameSilentDelta.updated.some((entry) => entry.node.name === "Frame silent two")
          && frameUploadQuery.nodes[0]?.state?.fileCount === 0
          && frameUpload.verified
          && frameUpload.proof?.fileCount === 1
          && frameDragSource.nodes[0]?.attributes?.id === "frame-drag-source"
          && frameDropTarget.nodes[0]?.attributes?.id === "frame-drop-target"
          && frameDragged.verified
          && frameDragged.proof?.source === frameDragSource.nodes[0].ref
          && frameDragged.proof?.target === frameDropTarget.nodes[0].ref
          && frameDragged.proof?.frameId === frameButton.frameId
          && frameMiddleClicked.verified
          && frameMiddleClicked.proof?.target
          && frameMiddleClicked.proof?.frameId === frameButton.frameId
          && childCacheSeed.diagnostics?.queries[0]?.cacheHit === false
          && parentMutation.verified
          && childCacheAfterParentMutation.diagnostics?.queries[0]?.cacheHit === true
          && childCacheAfterParentMutation.diagnostics.queries[0].elementsEvaluated === 0
          && globalCacheSeed.diagnostics?.queries[0]?.cacheHit === false
          && globalCacheAfterParentMutation.diagnostics?.queries[0]?.cacheHit === false
          && focused.verified && focused.proof?.focused === true
          && hovered.verified && scrolled.verified && selected.proof?.value === "two"
          && checked.proof?.value === "true" && filled.verified && typed.proof?.value === "Ada Lovelace"
          && clicked.verified && clicked.proof?.frameId === frameButton.frameId
          && retry.replayed === true && dynamic?.frameId === frameButton.frameId
          && navigatedFrame?.url.endsWith("/frame-next.html") && restoredFrame?.url.endsWith("/frame-restored.html")
          && lifecycleTransitions.length >= 3;
        return {
          passed,
          metrics: {
            crossOriginControls: [frameButton, frameTextbox].filter(Boolean).length,
            frameScopedIndexedRead: Number(frameScopedRead.node.ref === frameButton?.ref),
            frameSilentRoleNameRefresh: Number(frameSilentNameAfter.nodes[0]?.attributes?.id === "frame-silent-button"
              && frameSilentNameAfter.diagnostics?.queries[0]?.elementsEvaluated === 1),
            frameSilentFormStateRefresh: Number(frameSilentValueAfter.nodes[0]?.state?.value === "Silent frame name"
              && frameSilentValueAfter.diagnostics?.queries[0]?.cacheHit === false),
            frameSilentCheckedRefresh: Number(frameSilentCheckAfter.nodes[0]?.state?.checked === true),
            frameSilentSelectedRefresh: Number(frameSilentOptionAfter.nodes[0]?.state?.selected === true),
            frameFocus: Number(focused.verified && focused.proof?.focused === true),
            frameSilentPropertyDelta: Number(frameSilentDelta.revision > frameSilentBase.revision
              && frameSilentDelta.mode === "full"),
            frameUpload: Number(frameUpload.verified && frameUpload.proof?.fileCount === 1),
            frameDrag: Number(frameDragged.verified
              && frameDragged.proof?.source === frameDragSource.nodes[0]?.ref
              && frameDragged.proof?.target === frameDropTarget.nodes[0]?.ref),
            frameNativeMiddleClick: Number(frameMiddleClicked.verified
              && Boolean(frameMiddleClicked.proof?.target)
              && frameMiddleClicked.proof?.frameId === frameButton?.frameId),
            frameScopedCachePreserved: Number(
              childCacheSeed.diagnostics?.queries[0]?.cacheHit === false
                && parentMutation.verified
                && childCacheAfterParentMutation.diagnostics?.queries[0]?.cacheHit === true,
            ),
            globalCacheInvalidation: Number(globalCacheAfterParentMutation.diagnostics?.queries[0]?.cacheHit === false),
            frameActionProof: Number(clicked.proof?.frameId === frameButton?.frameId),
            verifiedActions: [hovered, scrolled, selected, checked, filled, typed, clicked].filter((action) => action.verified).length,
            replayedActions: retry.replayed === true ? 1 : 0,
            lifecycleTransitions: lifecycleTransitions.length,
          },
        };
      } finally {
        unsubscribe();
      }
    },
  }];
}

function topLevelNavigationScenarios(pageId, urls) {
  return [{
    id: "top-level-navigation-and-stale-recovery",
    name: "top-level-navigation-and-stale-recovery",
    async run(client) {
      await client.call("page.wait", { pageId, condition: { type: "text", value: "Navigation start" }, timeoutMs: 5_000 });
      const start = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
      const lifecycleEvents = [];
      const navigationEvents = [];
      const unsubscribe = client.onEvent((event) => {
        if (event.event === "frame.lifecycle") lifecycleEvents.push(event);
        if (event.event === "navigation") navigationEvents.push(event);
      });
      try {
        await client.observe(pageId, ["frame.lifecycle", "navigation", "load"]);
        const navigated = await client.call("page.act", {
          pageId,
          token: snapshotToken(start),
          action: { type: "navigate", url: urls.next },
          expect: { url: "/next.html", title: "Navigation next", text: "Next ready", timeoutMs: 5_000 },
        });
        await expectCode(client.call("page.act", {
          pageId,
          token: snapshotToken(start),
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Start action", exact: true } } },
        }), "STALE_SNAPSHOT");
        const next = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
        const filled = await client.call("page.act", {
          pageId,
          action: { type: "fill", target: { locator: { kind: "role", role: "textbox", name: "Recovered name", exact: true } }, value: "Ada" },
        });
        const clicked = await client.call("page.act", {
          pageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Next action", exact: true } } },
          expect: { text: "Next clicked", timeoutMs: 3_000 },
        });
        const reloaded = await client.call("page.act", {
          pageId,
          action: { type: "reload" },
          expect: { url: "/next.html", title: "Navigation next", text: "Next ready", timeoutMs: 5_000 },
        });
        await expectCode(client.call("page.act", {
          pageId,
          token: snapshotToken(next),
          action: { type: "fill", target: { locator: { kind: "role", role: "textbox", name: "Recovered name", exact: true } }, value: "stale" },
        }), "STALE_SNAPSHOT");
        const restored = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
        const back = await client.call("page.act", {
          pageId,
          token: snapshotToken(restored),
          action: { type: "history", direction: "back" },
          expect: { url: "/start.html", title: "Navigation start", text: "Navigation start", timeoutMs: 5_000 },
        });
        await expectCode(client.call("page.act", {
          pageId,
          token: snapshotToken(restored),
          action: { type: "history", direction: "forward" },
        }), "STALE_SNAPSHOT");
        const forward = await client.call("page.act", {
          pageId,
          action: { type: "history", direction: "forward" },
          expect: { url: "/next.html", title: "Navigation next", text: "Next ready", timeoutMs: 5_000 },
        });
        await expectCode(client.call("page.act", {
          pageId,
          action: { type: "history", direction: "forward" },
        }), "HISTORY_UNAVAILABLE");
        const final = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
        const mainNavigations = lifecycleEvents.filter((event) => event.data?.type === "navigated" && event.data.frame?.frameId === "main");
        const passed = navigated.verified && navigated.effects.some((effect) => effect.type === "navigation")
          && filled.verified && clicked.verified
          && reloaded.verified && next.documentId !== restored.documentId
          && back.verified && forward.verified
          && mainNavigations.length >= 4 && navigationEvents.length >= 4
          && final.nodes.some((node) => node.name === "Recovered name");
        return {
          passed,
          metrics: {
            topLevelNavigations: mainNavigations.length,
            navigationEvents: navigationEvents.length,
            staleTokenRejections: 3,
            recoveredControls: final.nodes.filter((node) => node.name === "Recovered name").length,
          },
        };
      } finally {
        unsubscribe();
      }
    },
  }];
}

function tabActivationScenarios(pageId, otherPageId) {
  return [{
    id: "tab-activation-reports-active-page",
    name: "tab-activation-reports-active-page",
    async run(client) {
      const before = await client.call("pages.list", {});
      const target = before.pages.find((page) => page.pageId === pageId);
      const other = before.pages.find((page) => page.pageId === otherPageId);
      if (!target || !other || target.pageId === other.pageId) {
        return { passed: false, reason: "evaluation did not expose two distinct pages", metrics: { pages: before.pages.length } };
      }
      const activated = await client.call("pages.activate", { pageId });
      const after = await client.call("pages.list", {});
      const activeTarget = after.pages.find((page) => page.pageId === pageId);
      const inactiveOther = after.pages.find((page) => page.pageId === otherPageId);
      const restored = await client.call("pages.activate", { pageId: otherPageId });
      const final = await client.call("pages.list", {});
      const inactiveTarget = final.pages.find((page) => page.pageId === pageId);
      const activeOther = final.pages.find((page) => page.pageId === otherPageId);
      const passed = activated.active && restored.active
        && activeTarget?.active === true && inactiveOther?.active === false
        && inactiveTarget?.active === false && activeOther?.active === true;
      return {
        passed,
        metrics: {
          pages: before.pages.length,
          activeReadbacks: Number(activated.active) + Number(restored.active),
        },
      };
    },
  }];
}

function nativeEventScenarios(eventPageId, downloadPageId, failureUrl) {
  return [{
    id: "native-page-events-are-delivered",
    name: "native-page-events-are-delivered",
    async run(client) {
      const events = [];
      const dialogResults = [];
      const dialogCalls = [];
      const dialogActions = new Map([
        ["agent dialog probe", { type: "accept" }],
        ["agent confirm probe", { type: "dismiss" }],
      ]);
      let downloadedPath;
      const unsubscribe = client.onEvent((event) => {
        if (["console", "dialog", "download", "page.error"].includes(event.event)) events.push(event);
        if (event.event !== "dialog" || event.data?.handled !== "pending") return;
        const action = dialogActions.get(event.data.message);
        if (!action) return;
        const call = client.dialog(event.pageId, event.data.dialogId, action)
          .then((result) => {
            dialogResults.push(result);
            return result;
          });
        dialogCalls.push(call);
      });
      try {
        await client.call("page.wait", { pageId: eventPageId, condition: { type: "text", value: "Emit console" }, timeoutMs: 3_000 });
        await client.call("page.wait", { pageId: downloadPageId, condition: { type: "text", value: "Download file" }, timeoutMs: 3_000 });
        await client.observe(eventPageId, ["console", "dialog", "page.error"]);
        await client.observe(downloadPageId, ["download"]);
        await client.call("pages.activate", { pageId: eventPageId });
        await client.call("page.act", {
          pageId: eventPageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Emit console", exact: true } } },
        });
        const consoleEvent = await waitFor(() => events.find(
          (event) => event.event === "console" && event.data?.message === "agent console probe",
        ));
        await client.call("page.act", {
          pageId: eventPageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Emit dialog", exact: true } } },
        });
        const dialogEvent = await waitFor(() => events.find(
          (event) => event.event === "dialog" && event.data?.message === "agent dialog probe",
        ));
        const dialogResult = await waitFor(() => dialogResults.find(
          (result) => result.dialogId === dialogEvent?.data?.dialogId,
        ));
        await expectCode(
          client.dialog(eventPageId, dialogResult.dialogId, { type: "accept" }),
          "DIALOG_NOT_FOUND",
        );
        const dialogCountBeforeNavigation = events.filter((event) => event.event === "dialog").length;
        await client.call("page.act", {
          pageId: eventPageId,
          action: { type: "navigate", url: dataUrl(eventHtml) },
          expect: { title: "Native event fixture", text: "Emit dialog", timeoutMs: 5_000 },
        });
        await client.call("page.act", {
          pageId: eventPageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Emit dialog", exact: true } } },
        });
        const dialogAfterNavigation = await waitFor(() => {
          const dialogs = events.filter((event) => event.event === "dialog");
          return dialogs.length > dialogCountBeforeNavigation ? dialogs[dialogs.length - 1] : undefined;
        });
        const dialogAfterNavigationResult = await waitFor(() => dialogResults.find(
          (result) => result.dialogId === dialogAfterNavigation?.data?.dialogId,
        ));
        await client.call("page.act", {
          pageId: eventPageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Emit confirm", exact: true } } },
        });
        const confirmResult = await waitFor(() => dialogResults.find(
          (result) => result.message === "agent confirm probe",
        ));
        await client.call("page.wait", {
          pageId: eventPageId,
          condition: { type: "text", value: "Dismissed" },
          timeoutMs: 1_000,
        });
        const externalWaitCall = client.call("page.wait", {
          pageId: eventPageId,
          condition: { type: "text", value: "Settled" },
          timeoutMs: 2_000,
          output: { snapshot: "none" },
        });
        const enabledWaitCall = client.call("page.wait", {
          pageId: eventPageId,
          condition: {
            type: "element",
            target: { locator: { kind: "role", role: "button", name: "Unlock", exact: true } },
            state: { visible: true, enabled: true },
          },
          timeoutMs: 2_000,
          output: { snapshot: "none" },
        });
        const quietActionStarted = Date.now();
        const quietAction = await client.call("page.act", {
          pageId: eventPageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Schedule update", exact: true } } },
          expect: {
            text: "Settled",
            element: {
              target: { locator: { kind: "role", role: "button", name: "Unlock", exact: true } },
              state: { visible: true, enabled: true },
            },
            timeoutMs: 2_000,
            quietMs: 100,
          },
          output: { snapshot: "none" },
        });
        const quietActionElapsedMs = Date.now() - quietActionStarted;
        const [externalWait, enabledWait] = await Promise.all([externalWaitCall, enabledWaitCall]);
        const stableWait = await client.call("page.wait", {
          pageId: eventPageId,
          condition: { type: "stable", quietMs: 50 },
          timeoutMs: 1_000,
        });
        const timedOutWait = await client.call("page.wait", {
          pageId: eventPageId,
          condition: { type: "text", value: "This text never appears" },
          timeoutMs: 100,
        });
        await client.call("pages.activate", { pageId: downloadPageId });
        await client.call("page.act", {
          pageId: downloadPageId,
          action: { type: "click", target: { locator: { kind: "role", role: "link", name: "Download file", exact: true } } },
        });
        const downloadEvent = await waitFor(() => events.find(
          (event) => event.event === "download" && event.data?.state === "done",
        ));
        downloadedPath = downloadEvent?.data?.path;
        await client.call("pages.activate", { pageId: eventPageId });
        await client.call("page.act", {
          pageId: eventPageId,
          action: { type: "navigate", url: failureUrl },
          expect: { title: "unreachable", timeoutMs: 500 },
        });
        const errorEvent = await waitFor(() => events.find(
          (event) => event.event === "page.error" && event.data?.kind === "load",
        ));
        const passed = consoleEvent?.data?.level === "warning"
          && dialogEvent?.data?.dialogType === "alert"
          && dialogEvent?.data?.handled === "pending"
          && dialogResult?.handled === "accepted"
          && dialogAfterNavigation?.data?.handled === "pending"
          && dialogAfterNavigationResult?.handled === "accepted"
          && confirmResult?.handled === "dismissed"
          && quietAction.verified === true
          && quietActionElapsedMs >= 300
          && externalWait.satisfied === true
          && enabledWait.satisfied === true
          && stableWait.satisfied === true
          && timedOutWait.satisfied === false
          && timedOutWait.elapsedMs >= 90
          && downloadEvent?.data?.filename === "agent-control-download.txt"
          && downloadEvent?.data?.receivedBytes > 0
          && errorEvent?.data?.mainFrame === true
          && errorEvent?.data?.code !== 0;
        return {
          passed,
          metrics: {
            consoleEvents: events.filter((event) => event.event === "console").length,
            dialogEvents: events.filter((event) => event.event === "dialog").length,
            quietExpectationVerified: Number(quietAction.verified),
            quietExpectationElapsedMs: quietActionElapsedMs,
            externalWaitMs: externalWait.elapsedMs,
            elementWaitMs: enabledWait.elapsedMs,
            stableWaitMs: stableWait.elapsedMs,
            timedOutWaitMs: timedOutWait.elapsedMs,
            downloadStates: new Set(events.filter((event) => event.event === "download").map((event) => event.data?.state)).size,
            pageErrors: events.filter((event) => event.event === "page.error").length,
          },
        };
      } finally {
        unsubscribe();
        await Promise.allSettled(dialogCalls);
        if (typeof downloadedPath === "string") {
          try { fs.unlinkSync(downloadedPath); } catch {}
        }
      }
    },
  }];
}

async function run() {
  const existing = new Set(listSockets());
  const { host, output } = launchHost();
  let childServer;
  let parentServer;
  let client;
  let pageId;
  let shadowPageId;
  let framePageId;
  let crossOriginPageId;
  let navigationPageId;
  let eventPageId;
  let downloadPageId;
  let uploadPageId;
  let largePageId;
  let navigationServer;
  let downloadServer;
  let largeServer;
  let failurePort;
  const uploadDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-agent-upload-"));
  const uploadPaths = [
    path.join(uploadDirectory, "agent-one.txt"),
    path.join(uploadDirectory, "agent-two.txt"),
  ];
  fs.writeFileSync(uploadPaths[0], "agent upload one\n", "utf8");
  fs.writeFileSync(uploadPaths[1], "agent upload two\n", "utf8");
  try {
    childServer = await serve(crossOriginChildHtml);
    parentServer = await serve(`<!doctype html><meta charset="utf-8"><title>Cross-origin evaluation fixture</title><button aria-label="Navigate frame" onclick="document.querySelector('iframe').src='http://127.0.0.1:${childServer.port}/frame-next.html'">Navigate frame</button><button aria-label="Remove frame" onclick="document.querySelector('iframe').remove()">Remove frame</button><button aria-label="Add frame" onclick="const frame=document.createElement('iframe');frame.title='Control frame';frame.src='http://127.0.0.1:${childServer.port}/frame-restored.html';document.body.append(frame)">Add frame</button><button aria-label="Parent action" onclick="document.title='Cross-origin updated'">Parent action</button><iframe title="Control frame" src="http://127.0.0.1:${childServer.port}/frame.html"></iframe>`);
    navigationServer = await serveRoutes({ "/start.html": navigationStartHtml, "/next.html": navigationNextHtml });
    downloadServer = await serveDownload();
    largeServer = await serve(largeWindowHtml);
    failurePort = await closedPort();
    const socket = await waitForSocket(existing, 15_000, output);
    const trace = new MemoryTrace();
    client = await AgentClient.connect(socket, {
      clientId: "evaluation-smoke",
      trace: new TraceRecorder(trace),
    });
    const hello = await client.hello();
    assert.equal(hello.capabilities.includes("page.dialog"), true);
    assert.equal(hello.capabilities.includes("page.act.upload"), true);
    const opened = await client.call("pages.open", { url: dataUrl(html) });
    pageId = opened.pageId;
    shadowPageId = (await client.call("pages.open", { url: dataUrl(shadowHtml) })).pageId;
    framePageId = (await client.call("pages.open", { url: dataUrl(frameHtml) })).pageId;
    crossOriginPageId = (await client.call("pages.open", { url: `http://127.0.0.1:${parentServer.port}/index.html` })).pageId;
    uploadPageId = (await client.call("pages.open", { url: dataUrl(html) })).pageId;
    navigationPageId = (await client.call("pages.open", { url: `http://127.0.0.1:${navigationServer.port}/start.html` })).pageId;
    eventPageId = (await client.call("pages.open", { url: dataUrl(eventHtml) })).pageId;
    downloadPageId = (await client.call("pages.open", { url: `http://127.0.0.1:${downloadServer.port}/index.html` })).pageId;
    largePageId = (await client.call("pages.open", { url: `http://127.0.0.1:${largeServer.port}/index.html` })).pageId;
    await client.call("page.wait", { pageId, condition: { type: "text", value: "Continue" }, timeoutMs: 3_000 });
    await client.call("page.wait", { pageId: largePageId, condition: { type: "text", value: "Tail action" }, timeoutMs: 3_000 });
    const scenarios = [
      ...fixtureScenarios(pageId),
      ...largeWindowScenarios(largePageId),
      ...queryScenarios(largePageId),
      ...batchScenarios(pageId),
      ...dragScenarios(pageId),
      ...semanticScenarios(pageId),
      ...uploadScenarios(uploadPageId, uploadPaths),
      ...shadowScenarios(shadowPageId, uploadPaths),
      ...frameScenarios(framePageId, uploadPaths),
      ...crossOriginScenarios(crossOriginPageId, uploadPaths),
      ...topLevelNavigationScenarios(navigationPageId, {
        next: `http://127.0.0.1:${navigationServer.port}/next.html`,
      }),
      ...tabActivationScenarios(pageId, navigationPageId),
      ...nativeEventScenarios(eventPageId, downloadPageId, `http://127.0.0.1:${failurePort}/unreachable.html`),
    ];
    const report = await runAgentEvaluation(client, scenarios, {
      trace,
      includeTrace: process.env.TERMINAL_BROWSER_EVALUATION_TRACE === "1",
      provenance: createAgentEvaluationProvenance(),
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
      if (shadowPageId) await client.call("pages.close", { pageId: shadowPageId }).catch(() => {});
      if (framePageId) await client.call("pages.close", { pageId: framePageId }).catch(() => {});
      if (crossOriginPageId) await client.call("pages.close", { pageId: crossOriginPageId }).catch(() => {});
      if (navigationPageId) await client.call("pages.close", { pageId: navigationPageId }).catch(() => {});
      if (eventPageId) await client.call("pages.close", { pageId: eventPageId }).catch(() => {});
      if (downloadPageId) await client.call("pages.close", { pageId: downloadPageId }).catch(() => {});
      if (uploadPageId) await client.call("pages.close", { pageId: uploadPageId }).catch(() => {});
      if (largePageId) await client.call("pages.close", { pageId: largePageId }).catch(() => {});
      await client.close().catch(() => {});
    }
    stopHost(host);
    if (parentServer) await closeServer(parentServer);
    if (childServer) await closeServer(childServer);
    if (navigationServer) await closeServer(navigationServer);
    if (downloadServer) await closeServer(downloadServer);
    if (largeServer) await closeServer(largeServer);
    fs.rmSync(uploadDirectory, { recursive: true, force: true });
  }
}

function serve(body) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, port: server.address().port });
    });
  });
}

function serveRoutes(routes) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const body = routes[pathname];
    if (body === undefined) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, port: server.address().port });
    });
  });
}

function serveDownload() {
  const body = Buffer.from("agent download payload\n", "utf8");
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<!doctype html><a href="/agent-control-download.txt">Download file</a>');
      return;
    }
    if (pathname === "/agent-control-download.txt") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="agent-control-download.txt"',
        "content-length": body.length,
      });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, port: server.address().port });
    });
  });
}

function closedPort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function closeServer(entry) {
  return new Promise((resolve) => entry.server.close(() => resolve()));
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for evaluation state");
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
