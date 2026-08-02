"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { AgentClient } = require("../../agent/dist");
const { launchHost, listSockets, stopHost, waitForSocket } = require("./agent-smoke-support.cjs");

const child = `<!doctype html><style>body{font:16px sans-serif;margin:18px}button,input,select{font:16px sans-serif;margin:8px;padding:8px}</style><button aria-label="Navigate frame" onclick="location.href='/frame-next.html'">Navigate frame</button><button aria-label="Remove frame" onclick="parent.postMessage({type:'remove-frame'},'*')">Remove frame</button><label>Frame name <input aria-label="Frame name"></label><label>Frame choice <select aria-label="Frame choice"><option value="one">One</option><option value="two">Two</option></select></label><label><input type="checkbox" aria-label="Frame enabled">Frame enabled</label><div id="frame-scroll-region" role="region" aria-label="Frame scroll area" style="height:90px;overflow:auto;border:1px solid #888"><div style="height:400px;padding:8px">Scrollable frame content</div></div><button aria-label="Frame action" onclick="document.querySelector('#status').textContent='Clicked';const b=document.createElement('button');b.setAttribute('aria-label','Frame dynamic');b.textContent='Frame dynamic';document.body.append(b)">Frame action</button><span id="status">Idle</span><input id="input-status" aria-label="Input status" value="Idle"><script>document.querySelector('input[aria-label="Frame name"]').addEventListener('input',event=>document.getElementById('input-status').value=String(event.isTrusted));document.getElementById('frame-scroll-region').addEventListener('wheel',event=>{document.getElementById('status').textContent='Wheel '+event.deltaY+' '+event.isTrusted});</script>`;

async function run() {
  const childServer = await serve(child);
  const parent = `<!doctype html><meta charset="utf-8"><title>Cross-origin frame control fixture</title><style>body{font:16px sans-serif;margin:24px}button{font:16px sans-serif;margin:8px;padding:8px}iframe{display:block;width:460px;height:220px;border:4px solid #888}</style><button aria-label="Parent action" onclick="document.title='Cross-origin updated'">Parent action</button><iframe title="Control frame" src="http://127.0.0.1:${childServer.port}/frame.html"></iframe><script>window.addEventListener('message',event=>{if(!event.data||event.data.type!=='remove-frame')return;const frame=document.querySelector('iframe');if(frame)frame.remove();setTimeout(()=>{const restored=document.createElement('iframe');restored.title='Control frame';restored.src='http://127.0.0.1:${childServer.port}/frame-restored.html';document.body.append(restored)},50)})</script>`;
  const parentServer = await serve(parent);
  const existing = new Set(listSockets());
  const { host, output } = launchHost();
  let client;
  let recoveryClient;
  let pageId;
  try {
    const socket = await waitForSocket(existing, 15_000, output);
    client = await AgentClient.connect(socket, {
      clientId: "cross-origin-smoke",
      capabilities: ["page.act.hover", "page.act.focus", "page.active", "unsafe.eval"],
    });
    const hello = await client.hello();
    assert.equal(hello.capabilities.includes("page.act.hover"), true);
    assert.equal(hello.capabilities.includes("page.act.focus"), true);
    assert.equal(hello.capabilities.includes("page.active"), true);
    assert.equal(hello.capabilities.includes("page.act.scroll"), true);
    assert.deepEqual(hello.accepted, ["page.act.hover", "page.act.focus", "page.active"]);
    assert.deepEqual(hello.unsupported, ["unsafe.eval"]);
    const opened = await client.call("pages.open", { url: `http://127.0.0.1:${parentServer.port}/index.html` });
    pageId = opened.pageId;
    await client.call("page.wait", {
      pageId,
      condition: {
        type: "element",
        target: { locator: { kind: "role", role: "button", name: "Frame action", exact: true } },
        state: { attached: true },
      },
      timeoutMs: 5_000,
    });
    const frameTree = await client.frames(pageId);
    const rootFrame = frameTree.frames.find((frame) => frame.parentFrameId === null);
    const childFrame = frameTree.frames.find((frame) => frame.parentFrameId !== null);
    assert.equal(rootFrame?.frameId, "main");
    assert.ok(childFrame, "cross-origin child frame was not enumerated");
    assert.equal(childFrame.url, `http://127.0.0.1:${childServer.port}/frame.html`);
    assert.equal(frameTree.pageId, pageId);
    assert.equal(frameTree.documentId.length > 0, true);

    const events = [];
    const unsubscribe = client.onEvent((event) => events.push(event));
    try {
      await client.observe(pageId, ["dom.changed", "frame.lifecycle"]);
      const initial = await client.call("page.snapshot", {
        pageId,
        options: { includeGeometry: true },
      });
      const frameButton = initial.nodes.find((node) => node.name === "Frame action");
      const frameTextbox = initial.nodes.find((node) => node.name === "Frame name");
      assert.ok(frameButton, "cross-origin frame button was not exposed in the snapshot");
      assert.ok(frameTextbox, "cross-origin frame textbox was not exposed in the snapshot");
      assert.notEqual(frameButton.frameId, "main");
      assert.equal(frameButton.frameId, frameTextbox.frameId);
      assert.ok(frameButton.box && frameButton.box.x > 0 && frameButton.box.y > 0);
      const queryBatch = await client.call("page.query.batch", {
        pageId,
        queries: [
          { locator: { kind: "role", role: "button" }, options: { frameId: frameButton.frameId, limit: 8, diagnostics: "summary" } },
          { locator: { kind: "role", role: "textbox", name: "Frame name", exact: true }, options: { frameId: frameButton.frameId, limit: 1 } },
          { locator: { kind: "role", role: "checkbox", name: "Frame enabled", exact: true, state: { checked: false } }, options: { frameId: frameButton.frameId, limit: 1 } },
          { locator: { kind: "role", role: "button", name: "Parent action", exact: true }, options: { limit: 1 } },
        ],
      });
      assert.equal(queryBatch.revision, initial.revision);
      assert.equal(queryBatch.diagnostics?.mode, "live");
      assert.equal(queryBatch.diagnostics?.queriesEvaluated, 4);
      assert.equal(queryBatch.diagnostics?.framesSearched, 2);
      assert.ok((queryBatch.diagnostics?.elementsScanned ?? 0) > 0);
      assert.deepEqual(queryBatch.diagnostics?.queries.map(({ index }) => index), [0]);
      assert.equal(queryBatch.diagnostics?.queries[0]?.matchCount, 3);
      assert.ok((queryBatch.diagnostics?.queries[0]?.elementsEvaluated ?? 0) > 0);
      assert.equal(queryBatch.queries[0].matchCount, 3);
      assert.equal(queryBatch.queries[0].nodes.every((node) => node.frameId === frameButton.frameId), true);
      assert.equal(queryBatch.queries[0].nodes.some((node) => node.name === "Parent action"), false);
      assert.equal(queryBatch.queries[1].nodes[0]?.ref, frameTextbox.ref);
      assert.equal(queryBatch.queries[0].nodes[0]?.frameId, queryBatch.queries[1].nodes[0]?.frameId);
      assert.ok(queryBatch.queries[0].nodes[0]?.parent, "live query omitted the child control parent");
      assert.equal(queryBatch.queries[2].nodes[0]?.name, "Frame enabled");
      assert.equal(queryBatch.queries[2].nodes[0]?.state?.checked, false);
      assert.equal(queryBatch.queries[3].nodes[0]?.name, "Parent action");
      assert.equal(queryBatch.queries[3].nodes[0]?.frameId, "main");
      assert.ok(queryBatch.queries[3].nodes[0]?.parent, "live query omitted the parent control parent");
      const diagnosticQuery = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Frame action", exact: true },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      assert.equal(diagnosticQuery.diagnostics?.mode, "live");
      assert.equal(diagnosticQuery.diagnostics?.queriesEvaluated, 1);
      assert.equal(diagnosticQuery.diagnostics?.framesSearched, 1);
      assert.ok((diagnosticQuery.diagnostics?.elementsScanned ?? 0) > 0);
      assert.equal(diagnosticQuery.diagnostics?.queries[0]?.index, 0);
      assert.equal(diagnosticQuery.diagnostics?.queries[0]?.matchCount, 1);
      const cachedDiagnosticQuery = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Frame action", exact: true },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      assert.equal(cachedDiagnosticQuery.diagnostics?.queries[0]?.cacheHit, true);
      assert.equal(cachedDiagnosticQuery.diagnostics?.queries[0]?.elementsEvaluated, 0);
      const plannedBatch = await client.call("page.query.batch", {
        pageId,
        queries: [
          { locator: { kind: "css", value: "button[aria-label]" }, options: { frameId: frameButton.frameId, limit: 8, diagnostics: "summary" } },
          { locator: { kind: "css", value: "button[aria-label]" }, options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" } },
        ],
      });
      assert.equal(plannedBatch.diagnostics?.mode, "live");
      assert.equal(plannedBatch.diagnostics?.queriesEvaluated, 2);
      assert.ok((plannedBatch.diagnostics?.planCacheHits ?? 0) > 0);
      assert.equal(plannedBatch.queries[0].matchCount, plannedBatch.queries[1].matchCount);
      const cssRead = await client.call("page.read", {
        pageId,
        target: { locator: { kind: "css", value: 'button[aria-label="Frame action"]' } },
      });
      assert.equal(cssRead.node.ref, frameButton.ref, "CSS locator did not resolve the cross-origin frame button");
      assert.ok(cssRead.node.parent, "live read omitted the child control parent");
      const frameScopedRead = await client.call("page.read", {
        pageId,
        target: {
          locator: { kind: "css", value: 'button[aria-label="Frame action"]' },
          index: 0,
          frameId: frameButton.frameId,
        },
      });
      assert.equal(frameScopedRead.node.ref, frameButton.ref, "frame-scoped indexed locator did not resolve the frame button");
      assert.equal(frameScopedRead.revision, initial.revision);
      await assert.rejects(
        client.call("page.read", { pageId, target: { locator: { kind: "css", value: "button" } } }),
        (error) => {
          assert.equal(error?.code, "AMBIGUOUS_TARGET");
          assert.ok(error.details.candidateCount > 1, "ambiguous locator omitted candidate count");
          assert.ok(error.details.candidates.length > 1, "ambiguous locator omitted candidate diagnostics");
          assert.equal(error.details.snapshotTruncated, false);
          return true;
        },
        "ambiguous CSS locator was not rejected",
      );
      await assert.rejects(
        client.call("page.read", { pageId, target: { locator: { kind: "css", value: "button[" } } }),
        (error) => error?.code === "INVALID_REQUEST",
        "invalid CSS locator was not rejected",
      );
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
      const preservedFrameCacheQuery = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Frame action", exact: true },
        options: { frameId: frameButton.frameId, limit: 1, diagnostics: "summary" },
      });
      const globalCacheAfterParentMutation = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "button", name: "Frame action", exact: true },
        options: { limit: 1, diagnostics: "summary" },
      });
      assert.equal(parentMutation.verified, true);
      assert.equal(preservedFrameCacheQuery.diagnostics?.queries[0]?.cacheHit, true);
      assert.equal(preservedFrameCacheQuery.diagnostics?.queries[0]?.elementsEvaluated, 0);
      assert.equal(globalCacheSeed.diagnostics?.queries[0]?.cacheHit, false);
      assert.equal(globalCacheAfterParentMutation.diagnostics?.queries[0]?.cacheHit, false);

      await client.call("page.act", {
        pageId,
        action: {
          type: "click",
          target: {
            locator: { kind: "role", role: "button", name: "Navigate frame", exact: true },
            frameId: frameButton.frameId,
          },
        },
      });
      const navigatedEvent = await waitForEvent(
        events,
        (event) => event.event === "frame.lifecycle" && event.data?.type === "navigated" && event.data.frame?.frameId === frameButton.frameId,
      );
      const navigatedFrameTree = await client.frames(pageId);
      const navigatedFrame = navigatedFrameTree.frames.find((frame) => frame.frameId === frameButton.frameId);
      assert.equal(navigatedEvent.data.frame.url, `http://127.0.0.1:${childServer.port}/frame-next.html`);
      assert.equal(navigatedFrame?.url, `http://127.0.0.1:${childServer.port}/frame-next.html`);
      assert.ok(navigatedFrameTree.revision >= frameTree.revision);

      await client.call("page.act", {
        pageId,
        action: {
          type: "click",
          target: {
            locator: { kind: "role", role: "button", name: "Remove frame", exact: true },
            frameId: frameButton.frameId,
          },
        },
      });
      const detachedEvent = await waitForEvent(
        events,
        (event) => event.event === "frame.lifecycle" && event.data?.type === "detached" && event.data.frameId === frameButton.frameId,
      );
      const detachedFrameTree = await waitForFrameTree(
        client,
        pageId,
        (tree) => tree.frames.every((frame) => frame.frameId !== frameButton.frameId),
      );
      assert.equal(detachedEvent.data.frameId, frameButton.frameId);
      assert.equal(detachedFrameTree.frames.some((frame) => frame.frameId === frameButton.frameId), false);

      const attachedEvent = await waitForEvent(
        events,
        (event) => event.event === "frame.lifecycle" && event.data?.type === "attached",
      );
      const restoredFrameTree = await waitForFrameTree(
        client,
        pageId,
        (tree) => tree.frames.some(
          (frame) => frame.parentFrameId !== null && frame.url === `http://127.0.0.1:${childServer.port}/frame-restored.html`,
        ),
      );
      const restoredFrame = restoredFrameTree.frames.find((frame) => frame.parentFrameId !== null);
      assert.equal(attachedEvent.data.parentFrameId, "main");
      assert.equal(restoredFrame?.url, `http://127.0.0.1:${childServer.port}/frame-restored.html`);
      assert.ok(restoredFrameTree.revision >= detachedFrameTree.revision);
      const activeFrameId = restoredFrame?.frameId;
      assert.ok(activeFrameId, "restored frame was not available for control");

      const focused = await client.call("page.act", {
        pageId,
        action: {
          type: "focus",
          target: {
            locator: { kind: "role", role: "textbox", name: "Frame name", exact: true },
            frameId: activeFrameId,
          },
        },
        output: { snapshot: "none" },
      });
      assert.equal(focused.verified, true);
      assert.equal(focused.proof?.focused, true);

      const active = await client.active(pageId);
      assert.equal(active.active, true);
      assert.equal(active.node?.name, "Frame name");
      assert.equal(active.node?.frameId, activeFrameId);
      assert.equal(active.node?.state?.focused, true);
      assert.equal(active.target?.ref, active.node?.ref);

      const hovered = await client.call("page.act", {
        pageId,
        action: { type: "hover", target: { locator: { kind: "css", value: 'button[aria-label="Frame action"]' } } },
      });
      const scrolled = await client.call("page.act", {
        pageId,
        idempotencyKey: "cross-origin-scroll-1",
        action: {
          type: "scroll",
          target: { locator: { kind: "role", role: "region", name: "Frame scroll area", exact: true } },
          direction: "down",
          amount: 60,
        },
        expect: { text: "Wheel 60 true", timeoutMs: 1_000 },
      });

      const selected = await client.call("page.act", {
        pageId,
        action: {
          type: "select",
          target: { locator: { kind: "role", role: "combobox", name: "Frame choice", exact: true } },
          values: ["two"],
        },
      });
      const checked = await client.call("page.act", {
        pageId,
        action: {
          type: "check",
          target: { locator: { kind: "role", role: "checkbox", name: "Frame enabled", exact: true } },
          checked: true,
        },
      });
      const deltaBase = await client.call("page.snapshot", {
        pageId,
        options: { interactiveOnly: false, includeGeometry: false },
      });

      const filled = await client.call("page.act", {
        pageId,
        action: {
          type: "fill",
          target: { locator: { kind: "role", role: "textbox", name: "Frame name", exact: true } },
          value: "Ada",
        },
      });
      await client.call("page.wait", {
        pageId,
        condition: {
          type: "element",
          target: { locator: { kind: "role", role: "textbox", name: "Input status", exact: true } },
          state: { value: "true" },
        },
        timeoutMs: 1_000,
      });
      const postMutationQuery = await client.call("page.query", {
        pageId,
        locator: { kind: "role", role: "textbox", name: "Frame name", exact: true },
        options: { frameId: activeFrameId, limit: 1, diagnostics: "summary" },
      });
      assert.equal(postMutationQuery.diagnostics?.queries[0]?.cacheHit, false);
      const valueDelta = await client.snapshotDelta(pageId, deltaBase);
      assert.equal(valueDelta.mode, "incremental", "cross-origin frame input did not use the incremental delta path");
      const typed = await client.call("page.act", {
        pageId,
        action: {
          type: "type",
          text: " Lovelace",
          target: {
            locator: { kind: "role", role: "textbox", name: "Frame name", exact: true },
            frameId: activeFrameId,
          },
        },
      });
      const typedDelta = await client.snapshotDelta(pageId, valueDelta);
      assert.equal(typedDelta.mode, "incremental", "cross-origin frame typing did not use the incremental delta path");
      const pressed = await client.call("page.act", {
        pageId,
        action: {
          type: "press",
          key: "Tab",
          target: {
            locator: { kind: "role", role: "textbox", name: "Frame name", exact: true },
            frameId: activeFrameId,
          },
        },
        output: { snapshot: "none" },
      });
      const clicked = await client.call("page.act", {
        pageId,
        action: {
          type: "click",
          target: { locator: { kind: "role", role: "button", name: "Frame action", exact: true } },
        },
        expect: { text: "Clicked", timeoutMs: 5_000 },
      });
      const after = await client.call("page.snapshot", {
        pageId,
        options: { interactiveOnly: false, includeGeometry: true },
      });
      const delta = await client.snapshotDelta(pageId, typedDelta);
      const dynamicButton = after.nodes.find((node) => node.name === "Frame dynamic");
      assert.equal(filled.verified, true);
      assert.equal(focused.verified, true);
      assert.equal(hovered.verified, true);
      assert.equal(scrolled.verified, true);
      assert.match(scrolled.proof?.value ?? "", /,\d+/);
      assert.equal(selected.verified, true);
      assert.equal(selected.proof?.value, "two");
      assert.equal(checked.verified, true);
      assert.equal(checked.proof?.value, "true");
      assert.equal(typed.proof?.value, "Ada Lovelace");
      assert.equal(pressed.verified, true);
      assert.ok(pressed.proof?.target, "targeted frame press omitted its target proof");
      assert.equal(clicked.verified, true);
      assert.ok(dynamicButton, "cross-origin frame mutation was not exposed in the next snapshot");
      assert.equal(dynamicButton.frameId, activeFrameId);
      assert.ok(after.revision > initial.revision, "cross-origin frame mutation did not advance the revision");
      assert.ok(events.some((event) => event.event === "dom.changed"), "cross-origin frame mutation emitted no event");
      assert.equal(delta.mode, "full", "cross-origin structural mutation did not use the full fallback path");
      assert.ok(delta.added.some((entry) => entry.node.name === "Frame dynamic"), "cross-origin fallback delta omitted the new node");
      assert.ok(
        events.some((event) => event.event === "dom.changed" && event.data && typeof event.data === "object" && event.data.frameId === activeFrameId),
        "cross-origin frame event did not preserve its frame identity",
      );

      const recoveryEvents = [];
      recoveryClient = await AgentClient.connect(socket, { clientId: "cross-origin-smoke" });
      await recoveryClient.hello();
      recoveryClient.onEvent((event) => recoveryEvents.push(event));
      const recovered = await recoveryClient.observe(pageId, ["dom.changed", "frame.lifecycle"], {
        afterSequence: events[0].sequence,
      });
      assert.ok(recovered.replayed > 0, "event cursor replayed no retained events");
      assert.ok(recoveryEvents.some((event) => event.sequence > events[0].sequence), "recovery client received no replayed event");
      const scrolledRetry = await recoveryClient.call("page.act", {
        pageId,
        idempotencyKey: "cross-origin-scroll-1",
        action: {
          type: "scroll",
          target: { locator: { kind: "role", role: "region", name: "Frame scroll area", exact: true } },
          direction: "down",
          amount: 60,
        },
        expect: { text: "Wheel 60 true", timeoutMs: 1_000 },
      });
      assert.equal(scrolledRetry.replayed, true, "retrying an action did not replay the cached result");
      assert.equal(scrolledRetry.proof?.value, scrolled.proof?.value, "replayed action result changed");

      console.log(JSON.stringify({
        parentPort: parentServer.port,
        childPort: childServer.port,
        frameId: frameButton.frameId,
        box: frameButton.box,
        typedValue: typed.proof?.value,
        dynamicNode: dynamicButton.name,
        incrementalDeltaMode: typedDelta.mode,
        fallbackDeltaMode: delta.mode,
        revisionDelta: after.revision - initial.revision,
        domEvents: events.filter((event) => event.event === "dom.changed").length,
        frameLifecycleEvents: events.filter((event) => event.event === "frame.lifecycle").length,
        hoverVerified: hovered.verified,
        scrollVerified: scrolled.verified,
        targetedPressVerified: pressed.verified && pressed.proof?.target !== undefined,
        focusVerified: focused.verified && focused.proof?.focused === true,
        activeElementVerified: active.active && active.node?.name === "Frame name" && active.node?.frameId === activeFrameId,
        frameScopedQueryVerified: queryBatch.queries[0].matchCount === 3
          && queryBatch.queries[0].nodes.every((node) => node.frameId === frameButton.frameId),
        liveAncestryVerified: Boolean(queryBatch.queries[0].nodes[0]?.parent)
          && Boolean(queryBatch.queries[3].nodes[0]?.parent),
        queryDiagnosticsVerified: queryBatch.diagnostics?.mode === "live"
          && queryBatch.diagnostics.framesSearched === 2
          && diagnosticQuery.diagnostics?.framesSearched === 1,
        queryCacheVerified: cachedDiagnosticQuery.diagnostics?.queries[0]?.cacheHit === true
          && cachedDiagnosticQuery.diagnostics.queries[0].elementsEvaluated === 0,
        queryCacheInvalidationVerified: postMutationQuery.diagnostics?.queries[0]?.cacheHit === false,
        frameScopedCachePreservedVerified: parentMutation.verified
          && preservedFrameCacheQuery.diagnostics?.queries[0]?.cacheHit === true,
        globalCacheInvalidationVerified: globalCacheAfterParentMutation.diagnostics?.queries[0]?.cacheHit === false,
        queryPlanVerified: (plannedBatch.diagnostics?.planCacheHits ?? 0) > 0,
        stateLocatorVerified: queryBatch.queries[2].nodes[0]?.state?.checked === false,
        mixedFrameBatchVerified: queryBatch.queries[3].nodes[0]?.frameId === "main",
        idempotentReplayVerified: scrolledRetry.replayed === true,
        frameLifecycleVerified: events.some((event) => event.event === "frame.lifecycle"),
      }));
    } finally {
      unsubscribe();
    }
  } finally {
    if (client) {
      if (pageId) await client.call("pages.close", { pageId }).catch(() => {});
      await client.close().catch(() => {});
    }
    if (recoveryClient) await recoveryClient.close().catch(() => {});
    stopHost(host);
    await closeServer(parentServer);
    await closeServer(childServer);
  }
}

async function waitForEvent(events, predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    const event = events.find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for frame lifecycle event");
}

async function waitForFrameTree(client, pageId, predicate) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const tree = await client.frames(pageId);
      if (predicate(tree)) return tree;
    } catch (error) {
      if (error?.code !== "STALE_SNAPSHOT") throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw lastError ?? new Error("timed out waiting for a stable frame tree");
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

function closeServer(entry) {
  return new Promise((resolve) => entry.server.close(() => resolve()));
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
