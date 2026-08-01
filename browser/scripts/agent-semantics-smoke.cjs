"use strict";

const assert = require("node:assert/strict");
const { AgentClient } = require("../../agent/dist");
const { launchHost, listSockets, stopHost, waitForSocket, dataUrl } = require("./agent-smoke-support.cjs");

const html = `<!doctype html>
<meta charset="utf-8">
<title>Semantic control fixture</title>
<style>
  body { font: 16px sans-serif; margin: 24px; }
  button, input, select, [role=switch] { display: block; margin: 8px 0; padding: 8px; }
  [role=switch] { border: 1px solid #999; width: 160px; }
</style>
<span id="launch-name">Launch workflow</span>
<button id="launch" aria-label="Wrong name" aria-labelledby="launch-name">Visible button</button>
<label for="full-name">Full name</label>
<input id="full-name" placeholder="Ignored by label" value="" required>
<input id="search" type="search" placeholder="Search records">
<input id="amount" type="number" value="3">
<input id="volume" type="range" min="0" max="10" value="4">
<select id="choices" multiple aria-label="Choices"><option value="a" selected>Alpha</option><option value="b">Beta</option></select>
<div id="notifications" role="switch" aria-checked="false" aria-label="Notifications">Notifications</div>
<button id="pressed" aria-pressed="true">Pressed action</button>
<button id="spaced">  Save <span> now </span> </button>
<button id="hidden" hidden>Hidden action</button>
<div aria-hidden="true"><button id="aria-hidden">ARIA hidden action</button></div>
<div inert><button id="inert">Inert action</button></div>
<fieldset disabled><button id="disabled">Disabled action</button></fieldset>
<output id="status">Idle</output>
<script>
  document.getElementById('launch').addEventListener('click', () => document.getElementById('status').textContent = 'Launched');
  document.getElementById('notifications').addEventListener('click', (event) => event.currentTarget.setAttribute('aria-checked', String(event.currentTarget.getAttribute('aria-checked') !== 'true')));
  document.getElementById('disabled').addEventListener('click', () => document.getElementById('status').textContent = 'Disabled clicked');
</script>`;

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error && error.code === code);
}

async function run() {
  const existing = new Set(listSockets());
  const { host, output } = launchHost();
  let client;
  let pageId;
  try {
    const socket = await waitForSocket(existing, 15_000, output);
    client = await AgentClient.connect(socket, { clientId: "semantics-smoke" });
    await client.hello();
    const opened = await client.call("pages.open", { url: dataUrl(html) });
    pageId = opened.pageId;
    await client.call("page.wait", { pageId, condition: { type: "text", value: "Launch workflow" }, timeoutMs: 3_000 });

    const snapshot = await client.call("page.snapshot", {
      pageId,
      options: { interactiveOnly: false, includeGeometry: false },
    });
    const byId = (id) => snapshot.nodes.find((node) => node.attributes?.id === id);
    const launchNode = byId("launch");
    const nameNode = byId("full-name");
    const searchNode = byId("search");
    const amountNode = byId("amount");
    const volumeNode = byId("volume");
    const choicesNode = byId("choices");
    const notificationsNode = byId("notifications");
    const pressedNode = byId("pressed");
    const spacedNode = byId("spaced");
    const hiddenNode = byId("hidden");
    const ariaHiddenNode = byId("aria-hidden");
    const inertNode = byId("inert");
    const disabledNode = byId("disabled");

    assert.equal(launchNode?.role, "button");
    assert.equal(launchNode?.name, "Launch workflow");
    assert.equal(nameNode?.role, "textbox");
    assert.equal(nameNode?.name, "Full name");
    assert.equal(nameNode?.state?.value, "");
    assert.equal(nameNode?.state?.required, true);
    assert.equal(nameNode?.state?.invalid, true);
    assert.equal(searchNode?.role, "searchbox");
    assert.equal(amountNode?.role, "spinbutton");
    assert.equal(volumeNode?.role, "slider");
    assert.equal(choicesNode?.role, "listbox");
    assert.equal(notificationsNode?.role, "switch");
    assert.equal(notificationsNode?.state?.checked, false);
    assert.equal(pressedNode?.state?.pressed, true);
    assert.equal(spacedNode?.name, "Save now");
    assert.equal(hiddenNode?.visible, false);
    assert.equal(hiddenNode?.enabled, false);
    assert.equal(ariaHiddenNode?.visible, false);
    assert.equal(ariaHiddenNode?.enabled, false);
    assert.equal(inertNode?.visible, false);
    assert.equal(inertNode?.enabled, false);
    assert.equal(disabledNode?.visible, true);
    assert.equal(disabledNode?.enabled, false);
    await client.call("page.wait", { pageId, condition: { type: "text", value: "Save\n now" }, timeoutMs: 3_000 });

    const filled = await client.call("page.act", {
      pageId,
      action: { type: "fill", target: { locator: { kind: "role", role: "textbox", name: "Full name", exact: true } }, value: "Ada" },
    });
    assert.equal(filled.proof?.name, "Full name");
    assert.equal(filled.proof?.value, "Ada");

    const checked = await client.call("page.act", {
      pageId,
      action: { type: "check", target: { locator: { kind: "role", role: "switch", name: "Notifications", exact: true } }, checked: true },
    });
    assert.equal(checked.proof?.value, "true");

    const after = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
    const afterName = after.nodes.find((node) => node.attributes?.id === "full-name");
    const afterNotifications = after.nodes.find((node) => node.attributes?.id === "notifications");
    assert.equal(afterName?.name, "Full name");
    assert.equal(afterName?.state?.value, "Ada");
    assert.equal(afterName?.state?.invalid, undefined);
    assert.equal(afterNotifications?.state?.checked, true);

    await expectCode(
      client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Hidden action", exact: true } } } }),
      "TARGET_NOT_FOUND",
    );
    await expectCode(
      client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "ARIA hidden action", exact: true } } } }),
      "TARGET_NOT_FOUND",
    );
    await expectCode(
      client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Inert action", exact: true } } } }),
      "TARGET_NOT_FOUND",
    );
    await expectCode(
      client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Disabled action", exact: true } } } }),
      "NOT_INTERACTABLE",
    );
    const readLaunch = await client.call("page.read", {
      pageId,
      target: { locator: { kind: "role", role: "button", name: "Launch workflow", exact: true } },
    });
    const final = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
    const status = final.nodes.find((node) => node.attributes?.id === "status");
    assert.equal(readLaunch.node.attributes?.id, "launch");
    assert.equal(status?.name, "Idle");

    console.log(JSON.stringify({
      semanticNames: true,
      nativeRoles: [searchNode?.role, amountNode?.role, volumeNode?.role, choicesNode?.role],
      switchChecked: afterNotifications?.state?.checked,
      filledValue: afterName?.state?.value,
      unsafeTargetsRejected: true,
      status: status.name,
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
