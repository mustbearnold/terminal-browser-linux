"use strict";

const assert = require("node:assert/strict");
const { AgentClient } = require("../../agent/dist");
const { launchHost, listSockets, stopHost, waitForSocket, dataUrl } = require("./agent-smoke-support.cjs");

const html = `<!doctype html><meta charset="utf-8"><title>Shadow control fixture</title><style>body{font:16px sans-serif;margin:24px}x-control{display:block;width:320px}button,input{font:16px sans-serif;margin:8px;padding:8px}</style><x-control></x-control><script>customElements.define('x-control',class extends HTMLElement{constructor(){super();const root=this.attachShadow({mode:'open'});root.innerHTML='<label>Shadow name <input aria-label="Shadow name"></label><button aria-label="Shadow action">Shadow action</button><span id="status">Idle</span>';const shadowAction=root.querySelector('[aria-label="Shadow action"]');shadowAction.addEventListener('click',()=>{root.querySelector('#status').textContent='Clicked';const dynamic=document.createElement('button');dynamic.setAttribute('aria-label','Dynamic action');dynamic.textContent='Dynamic action';root.append(dynamic);for(const [name,text] of [['Primary card','Primary open'],['Secondary card','Secondary open']]){const region=document.createElement('div');region.setAttribute('role','region');region.setAttribute('aria-label',name);const open=document.createElement('button');open.setAttribute('aria-label','Open');open.textContent=text;open.addEventListener('click',()=>{root.querySelector('#status').textContent='Scoped clicked'});region.append(open);root.append(region)}})}});</script>`;

async function run() {
  const existing = new Set(listSockets());
  const { host, output } = launchHost();
  let client;
  let pageId;
  try {
    const socket = await waitForSocket(existing, 15_000, output);
    client = await AgentClient.connect(socket, { clientId: `shadow-smoke-${process.pid}` });
    const hello = await client.hello();
    const opened = await client.call("pages.open", { url: dataUrl(html) });
    pageId = opened.pageId;
    await client.call("page.wait", {
      pageId,
      condition: { type: "text", value: "Shadow action" },
      timeoutMs: 3_000,
    });
    assert.ok(hello.capabilities.includes("page.capture"), "page capture capability was not advertised");
    assert.ok(hello.capabilities.includes("snapshot.delta"), "snapshot delta capability was not advertised");
    const captured = process.env.TERMINAL_BROWSER_SMOKE_SKIP_CAPTURE === "1"
      ? null
      : await client.capture(pageId, { format: "png" });
    if (captured) {
      assert.equal(captured.format, "png");
      assert.equal(captured.pageId, pageId);
      assert.ok(captured.data.length > 100, "page capture returned too little image data");
    }

    const events = [];
    const unsubscribe = client.onEvent((event) => events.push(event));
    try {
      await client.observe(pageId, ["dom.changed"]);
      const initial = await client.call("page.snapshot", {
        pageId,
        options: { interactiveOnly: false, includeGeometry: false },
      });
      const shadowButton = initial.nodes.find((node) => node.name === "Shadow action");
      const shadowTextbox = initial.nodes.find((node) => node.name === "Shadow name");
      assert.ok(shadowButton, "shadow button was not exposed in the snapshot");
      assert.ok(shadowTextbox, "shadow textbox was not exposed in the snapshot");
      assert.equal(shadowButton.frameId, "main");
      assert.equal(shadowTextbox.frameId, "main");

      const filled = await client.call("page.act", {
        pageId,
        action: {
          type: "fill",
          target: { locator: { kind: "role", role: "textbox", name: "Shadow name", exact: true } },
          value: "Ada",
        },
      });
      const valueDelta = await client.snapshotDelta(pageId, initial);
      assert.equal(valueDelta.mode, "incremental", "input-only mutation did not use the incremental delta path");
      assert.ok(valueDelta.updated.some((entry) => entry.node.name === "Shadow name"), "incremental delta omitted the input state");
      const typed = await client.call("page.act", {
        pageId,
        action: {
          type: "type",
          text: " Lovelace",
          target: { locator: { kind: "role", role: "textbox", name: "Shadow name", exact: true } },
        },
      });
      const pressed = await client.call("page.act", {
        pageId,
        action: {
          type: "press",
          key: "Tab",
          target: { locator: { kind: "role", role: "textbox", name: "Shadow name", exact: true } },
        },
        output: { snapshot: "none" },
      });
      const typedDelta = await client.snapshotDelta(pageId, valueDelta);
      assert.equal(typedDelta.mode, "incremental", "typing did not use the incremental delta path");
      const clicked = await client.call("page.act", {
        pageId,
        action: {
          type: "click",
          target: { locator: { kind: "role", role: "button", name: "Shadow action", exact: true } },
        },
        expect: { text: "Clicked", timeoutMs: 3_000 },
      });
      const scopedOpenLocator = {
        kind: "role",
        role: "button",
        name: "Open",
        exact: true,
        within: { kind: "role", role: "region", name: "Primary card", exact: true },
      };
      const scopedQuery = await client.call("page.query", { pageId, locator: scopedOpenLocator });
      assert.equal(scopedQuery.matchCount, 1);
      assert.equal(scopedQuery.nodes[0].text, "Primary open");
      const scopedRead = await client.call("page.read", {
        pageId,
        target: { locator: scopedOpenLocator },
      });
      assert.equal(scopedRead.node.text, "Primary open");
      const scopedClicked = await client.call("page.act", {
        pageId,
        action: { type: "click", target: { locator: scopedOpenLocator } },
        expect: { text: "Scoped clicked", timeoutMs: 3_000 },
      });
      assert.equal(scopedClicked.verified, true);
      const after = await client.call("page.snapshot", {
        pageId,
        options: { interactiveOnly: false },
      });
      const delta = await client.snapshotDelta(pageId, typedDelta);
      const dynamicButton = after.nodes.find((node) => node.name === "Dynamic action");
      assert.equal(filled.verified, true);
      assert.equal(typed.verified, true);
      assert.equal(typed.proof?.value, "Ada Lovelace");
      assert.equal(clicked.verified, true);
      assert.ok(dynamicButton, "shadow mutation was not exposed in the next snapshot");
      assert.ok(after.revision > initial.revision, "shadow mutation did not advance the revision");
      assert.ok(events.some((event) => event.event === "dom.changed"), "shadow mutation emitted no event");
      assert.equal(delta.reset, false);
      assert.ok(delta.added.some((entry) => entry.node.name === "Dynamic action"), "delta omitted the shadow mutation");
      assert.ok(delta.updated.some((entry) => entry.node.name === "Scoped clicked"), "delta omitted the status update");

      console.log(JSON.stringify({
        protocol: `${hello.protocol}/${hello.version}`,
        shadowNodes: initial.nodes.length,
        typedValue: typed.proof?.value,
        targetedPress: Number(pressed.verified && pressed.proof?.target !== undefined),
        dynamicNode: dynamicButton.name,
        captureBytes: captured?.data.length ?? 0,
        incrementalDeltaMode: typedDelta.mode,
        fallbackDeltaMode: delta.mode,
        deltaAdded: delta.added.length,
        deltaUpdated: delta.updated.length,
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
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
