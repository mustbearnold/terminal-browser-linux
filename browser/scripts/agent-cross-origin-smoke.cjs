"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { AgentClient } = require("../../agent/dist");
const { launchHost, listSockets, stopHost, waitForSocket } = require("./agent-smoke-support.cjs");

const child = `<!doctype html><style>body{font:16px sans-serif;margin:18px}button,input{font:16px sans-serif;margin:8px;padding:8px}</style><label>Frame name <input aria-label="Frame name"></label><button aria-label="Frame action" onclick="document.querySelector('#status').textContent='Clicked';const b=document.createElement('button');b.setAttribute('aria-label','Frame dynamic');b.textContent='Frame dynamic';document.body.append(b)">Frame action</button><span id="status">Idle</span>`;

async function run() {
  const childServer = await serve(child);
  const parent = `<!doctype html><meta charset="utf-8"><title>Cross-origin frame control fixture</title><style>body{font:16px sans-serif;margin:24px}iframe{display:block;width:460px;height:220px;border:4px solid #888}</style><iframe title="Control frame" src="http://127.0.0.1:${childServer.port}/frame.html"></iframe>`;
  const parentServer = await serve(parent);
  const existing = new Set(listSockets());
  const { host, output } = launchHost();
  let client;
  let pageId;
  try {
    const socket = await waitForSocket(existing, 15_000, output);
    client = await AgentClient.connect(socket, { clientId: "cross-origin-smoke" });
    const opened = await client.call("pages.open", { url: `http://127.0.0.1:${parentServer.port}/index.html` });
    pageId = opened.pageId;
    await client.call("page.wait", {
      pageId,
      condition: { type: "text", value: "Frame action" },
      timeoutMs: 5_000,
    });
    const frames = await client.frames(pageId);
    const rootFrame = frames.find((frame) => frame.parentFrameId === null);
    const childFrame = frames.find((frame) => frame.parentFrameId !== null);
    assert.equal(rootFrame?.frameId, "main");
    assert.ok(childFrame, "cross-origin child frame was not enumerated");
    assert.equal(childFrame.url, `http://127.0.0.1:${childServer.port}/frame.html`);

    const events = [];
    const unsubscribe = client.onEvent((event) => events.push(event));
    try {
      await client.observe(pageId, ["dom.changed"]);
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

      console.log(JSON.stringify({
        parentPort: parentServer.port,
        childPort: childServer.port,
        frameId: frameButton.frameId,
        box: frameButton.box,
        typedValue: typed.proof?.value,
        dynamicNode: dynamicButton.name,
        revisionDelta: after.revision - initial.revision,
        domEvents: events.filter((event) => event.event === "dom.changed").length,
      }));
    } finally {
      unsubscribe();
    }
  } finally {
    if (client) {
      if (pageId) await client.call("pages.close", { pageId }).catch(() => {});
      await client.close().catch(() => {});
    }
    stopHost(host);
    await closeServer(parentServer);
    await closeServer(childServer);
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

function closeServer(entry) {
  return new Promise((resolve) => entry.server.close(() => resolve()));
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
