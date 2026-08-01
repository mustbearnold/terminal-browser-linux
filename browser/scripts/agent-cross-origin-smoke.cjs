"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { AgentClient } = require("../../agent/dist");
const { launchHost, listSockets, stopHost, waitForSocket } = require("./agent-smoke-support.cjs");

const child = `<!doctype html><style>body{font:16px sans-serif;margin:18px}button,input,select{font:16px sans-serif;margin:8px;padding:8px}</style><label>Frame name <input aria-label="Frame name"></label><label>Frame choice <select aria-label="Frame choice"><option value="one">One</option><option value="two">Two</option></select></label><label><input type="checkbox" aria-label="Frame enabled">Frame enabled</label><div role="region" aria-label="Frame scroll area" style="height:90px;overflow:auto;border:1px solid #888"><div style="height:400px;padding:8px">Scrollable frame content</div></div><button aria-label="Frame action" onclick="document.querySelector('#status').textContent='Clicked';const b=document.createElement('button');b.setAttribute('aria-label','Frame dynamic');b.textContent='Frame dynamic';document.body.append(b)">Frame action</button><span id="status">Idle</span>`;

async function run() {
  const childServer = await serve(child);
  const parent = `<!doctype html><meta charset="utf-8"><title>Cross-origin frame control fixture</title><style>body{font:16px sans-serif;margin:24px}button{font:16px sans-serif;margin:8px;padding:8px}iframe{display:block;width:460px;height:220px;border:4px solid #888}</style><button aria-label="Navigate frame" onclick="document.querySelector('iframe').src='http://127.0.0.1:${childServer.port}/frame-next.html'">Navigate frame</button><button aria-label="Remove frame" onclick="document.querySelector('iframe').remove()">Remove frame</button><button aria-label="Add frame" onclick="const frame=document.createElement('iframe');frame.title='Control frame';frame.src='http://127.0.0.1:${childServer.port}/frame-restored.html';document.body.append(frame)">Add frame</button><iframe title="Control frame" src="http://127.0.0.1:${childServer.port}/frame.html"></iframe>`;
  const parentServer = await serve(parent);
  const existing = new Set(listSockets());
  const { host, output } = launchHost();
  let client;
  let recoveryClient;
  let pageId;
  try {
    const socket = await waitForSocket(existing, 15_000, output);
    client = await AgentClient.connect(socket, { clientId: "cross-origin-smoke" });
    const hello = await client.hello();
    assert.equal(hello.capabilities.includes("page.act.hover"), true);
    assert.equal(hello.capabilities.includes("page.act.scroll"), true);
    const opened = await client.call("pages.open", { url: `http://127.0.0.1:${parentServer.port}/index.html` });
    pageId = opened.pageId;
    await client.call("page.wait", {
      pageId,
      condition: { type: "text", value: "Frame action" },
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

      const hovered = await client.call("page.act", {
        pageId,
        action: { type: "hover", target: { locator: { kind: "role", role: "button", name: "Frame action", exact: true } } },
      });
      const scrolled = await client.call("page.act", {
        pageId,
        action: {
          type: "scroll",
          target: { locator: { kind: "role", role: "region", name: "Frame scroll area", exact: true } },
          direction: "down",
          amount: 60,
        },
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

      const filled = await client.call("page.act", {
        pageId,
        action: {
          type: "fill",
          target: { locator: { kind: "role", role: "textbox", name: "Frame name", exact: true } },
          value: "Ada",
        },
      });
      const typed = await client.call("page.act", {
        pageId,
        action: { type: "type", text: " Lovelace" },
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
      const dynamicButton = after.nodes.find((node) => node.name === "Frame dynamic");
      assert.equal(filled.verified, true);
      assert.equal(hovered.verified, true);
      assert.equal(scrolled.verified, true);
      assert.match(scrolled.proof?.value ?? "", /,\d+/);
      assert.equal(selected.verified, true);
      assert.equal(selected.proof?.value, "two");
      assert.equal(checked.verified, true);
      assert.equal(checked.proof?.value, "true");
      assert.equal(typed.proof?.value, "Ada Lovelace");
      assert.equal(clicked.verified, true);
      assert.ok(dynamicButton, "cross-origin frame mutation was not exposed in the next snapshot");
      assert.equal(dynamicButton.frameId, frameButton.frameId);
      assert.ok(after.revision > initial.revision, "cross-origin frame mutation did not advance the revision");
      assert.ok(events.some((event) => event.event === "dom.changed"), "cross-origin frame mutation emitted no event");
      assert.ok(
        events.some((event) => event.event === "dom.changed" && event.data && typeof event.data === "object" && event.data.frameId === frameButton.frameId),
        "cross-origin frame event did not preserve its frame identity",
      );

      const recoveryEvents = [];
      recoveryClient = await AgentClient.connect(socket, { clientId: "cross-origin-recovery" });
      recoveryClient.onEvent((event) => recoveryEvents.push(event));
      const recovered = await recoveryClient.observe(pageId, ["dom.changed", "frame.lifecycle"], {
        afterSequence: events[0].sequence,
      });
      assert.ok(recovered.replayed > 0, "event cursor replayed no retained events");
      assert.ok(recoveryEvents.some((event) => event.sequence > events[0].sequence), "recovery client received no replayed event");

      await client.call("page.act", {
        pageId,
        action: {
          type: "click",
          target: { locator: { kind: "role", role: "button", name: "Navigate frame", exact: true } },
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
          target: { locator: { kind: "role", role: "button", name: "Remove frame", exact: true } },
        },
      });
      const detachedEvent = await waitForEvent(
        events,
        (event) => event.event === "frame.lifecycle" && event.data?.type === "detached" && event.data.frameId === frameButton.frameId,
      );
      const detachedFrameTree = await client.frames(pageId);
      assert.equal(detachedEvent.data.frameId, frameButton.frameId);
      assert.equal(detachedFrameTree.frames.some((frame) => frame.frameId === frameButton.frameId), false);

      await client.call("page.act", {
        pageId,
        action: {
          type: "click",
          target: { locator: { kind: "role", role: "button", name: "Add frame", exact: true } },
        },
      });
      const attachedEvent = await waitForEvent(
        events,
        (event) => event.event === "frame.lifecycle" && event.data?.type === "attached",
      );
      const restoredFrameTree = await client.frames(pageId);
      const restoredFrame = restoredFrameTree.frames.find((frame) => frame.parentFrameId !== null);
      assert.equal(attachedEvent.data.parentFrameId, "main");
      assert.equal(restoredFrame?.url, `http://127.0.0.1:${childServer.port}/frame-restored.html`);
      assert.ok(restoredFrameTree.revision >= detachedFrameTree.revision);

      const navigatedPage = await client.call("page.act", {
        pageId,
        action: { type: "navigate", url: `http://127.0.0.1:${parentServer.port}/navigated.html` },
        expect: { url: `http://127.0.0.1:${parentServer.port}/navigated.html`, timeoutMs: 5_000 },
      });
      assert.equal(navigatedPage.verified, true);

      console.log(JSON.stringify({
        parentPort: parentServer.port,
        childPort: childServer.port,
        frameId: frameButton.frameId,
        box: frameButton.box,
        typedValue: typed.proof?.value,
        dynamicNode: dynamicButton.name,
        revisionDelta: after.revision - initial.revision,
        domEvents: events.filter((event) => event.event === "dom.changed").length,
        frameLifecycleEvents: events.filter((event) => event.event === "frame.lifecycle").length,
        hoverVerified: hovered.verified,
        scrollVerified: scrolled.verified,
        navigationVerified: navigatedPage.verified,
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
