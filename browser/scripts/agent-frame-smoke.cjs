"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AgentClient } = require("../../agent/dist");

const root = path.resolve(__dirname, "../..");
const electron = path.join(root, "browser/node_modules/.bin/electron");
const browserMain = path.join(root, "browser/dist/main.js");
const runtimeHome = process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".local/state");
const instancesDir = path.join(runtimeHome, "terminal-browser", "instances");

const child = `<!doctype html><style>body{font:16px sans-serif;margin:18px}button,input{font:16px sans-serif;margin:8px;padding:8px}</style><label>Frame name <input aria-label="Frame name"></label><button aria-label="Frame action" onclick="document.querySelector('#status').textContent='Clicked';const b=document.createElement('button');b.setAttribute('aria-label','Frame dynamic');b.textContent='Frame dynamic';document.body.append(b)">Frame action</button><span id="status">Idle</span>`;
const html = `<!doctype html><meta charset="utf-8"><title>Frame control fixture</title><style>body{font:16px sans-serif;margin:24px}iframe{display:block;width:460px;height:220px;border:4px solid #888}</style><iframe title="Control frame"></iframe><script>document.querySelector('iframe').srcdoc=${JSON.stringify(child)}</script>`;

async function run() {
  const existing = new Set(listSockets());
  const host = spawn(
    "script",
    ["-qefc", `${shellQuote(electron)} ${shellQuote(browserMain)} --no-toolbar`, "/dev/null"],
    { cwd: root, detached: true, stdio: "ignore" },
  );
  let client;
  let pageId;
  try {
    const socket = await waitForSocket(existing, 15_000);
    client = await AgentClient.connect(socket, { clientId: "frame-smoke" });
    const opened = await client.call("pages.open", { url: dataUrl(html) });
    pageId = opened.pageId;
    await client.call("page.wait", {
      pageId,
      condition: { type: "text", value: "Frame action" },
      timeoutMs: 5_000,
    });

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
      assert.ok(frameButton, "same-origin frame button was not exposed in the snapshot");
      assert.ok(frameTextbox, "same-origin frame textbox was not exposed in the snapshot");
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
      assert.ok(dynamicButton, "same-origin frame mutation was not exposed in the next snapshot");
      assert.equal(dynamicButton.frameId, frameButton.frameId);
      assert.ok(after.revision > initial.revision, "frame mutation did not advance the revision");
      assert.ok(events.some((event) => event.event === "dom.changed"), "frame mutation emitted no event");

      console.log(JSON.stringify({
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
  }
}

function listSockets() {
  try {
    return fs
      .readdirSync(instancesDir)
      .filter((name) => name.endsWith(".agent.sock"))
      .map((name) => path.join(instancesDir, name));
  } catch {
    return [];
  }
}

async function waitForSocket(existing, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socket = listSockets().find((candidate) => !existing.has(candidate));
    if (socket) return socket;
    await delay(100);
  }
  throw new Error(`agent socket did not appear in ${instancesDir}`);
}

function stopHost(host) {
  if (!host.pid) return;
  try {
    process.kill(-host.pid, "SIGTERM");
  } catch {}
  try {
    host.kill("SIGTERM");
  } catch {}
}

function dataUrl(value) {
  return `data:text/html;base64,${Buffer.from(value).toString("base64")}`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
