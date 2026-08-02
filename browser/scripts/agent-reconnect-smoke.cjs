"use strict";

const assert = require("node:assert/strict");
const { AgentClient } = require("../../agent/dist");
const { dataUrl, launchHost, listSockets, stopHost, waitForSocket } = require("./agent-smoke-support.cjs");

const html = `<!doctype html><meta charset="utf-8"><title>Reconnect fixture</title><button aria-label="Continue">Continue</button><output>Idle</output><script>document.querySelector('button').addEventListener('click',()=>document.querySelector('output').textContent='Ready')</script>`;

async function run() {
  const existing = new Set(listSockets());
  const { host, output } = launchHost();
  let client;
  let peer;
  let pageId;
  let unsubscribe = () => {};
  let unsubscribeEvents = () => {};
  try {
    const socket = await waitForSocket(existing, 15_000, output);
    client = await AgentClient.connect(socket, { clientId: "reconnect-smoke" });
    const states = [];
    const events = [];
    const firstHello = await client.hello();
    const unsubscribeState = client.onConnectionState((state) => states.push(state));
    unsubscribe = () => {
      unsubscribeState();
      unsubscribeEvents();
    };
    unsubscribeEvents = client.onEvent((event) => events.push(event));
    const opened = await client.call("pages.open", { url: dataUrl(html) });
    pageId = opened.pageId;
    await client.call("page.wait", {
      pageId,
      condition: { type: "text", value: "Continue" },
      timeoutMs: 3_000,
    });
    await client.observe(pageId, ["dom.changed"]);

    const idempotentAction = {
      pageId,
      idempotencyKey: "reconnect-action-1",
      action: {
        type: "click",
        target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } },
      },
      output: { snapshot: "none" },
    };
    const completed = await client.call("page.act", idempotentAction);
    assert.equal(completed.verified, true);
    const firstEvent = events.find((event) => event.event === "dom.changed");
    assert.ok(firstEvent, "initial observed DOM event was not delivered");

    await client.disconnect();
    assert.equal(client.state, "disconnected");
    await assert.rejects(
      client.call("pages.list", {}),
      (error) => error && error.code === "TRANSPORT_CLOSED",
    );

    peer = await AgentClient.connect(socket, { clientId: "reconnect-peer" });
    const peerHello = await peer.hello();
    assert.equal(peerHello.protocol, firstHello.protocol);
    const missed = await peer.call("page.act", {
      pageId,
      idempotencyKey: "reconnect-peer-action-1",
      action: {
        type: "click",
        target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } },
      },
      output: { snapshot: "none" },
    });
    assert.equal(missed.verified, true);
    await peer.close();
    peer = null;

    const resumedHello = await client.reconnect();
    assert.equal(resumedHello.clientId, "reconnect-smoke");
    assert.equal(client.state, "connected");
    const replayedEvents = events.filter((event) => event.sequence > firstEvent.sequence);
    assert.ok(replayedEvents.length > 0, "reconnect did not replay the missed DOM event");
    const replayedAction = await client.call("page.act", idempotentAction);
    assert.equal(replayedAction.replayed, true);
    assert.equal(replayedAction.proof?.value, completed.proof?.value);

    console.log(JSON.stringify({
      protocol: `${firstHello.protocol}/${firstHello.version}`,
      pageId,
      stateTransitions: states,
      firstEventSequence: firstEvent.sequence,
      replayedEventSequences: replayedEvents.map((event) => event.sequence),
      reconnectHello: resumedHello.clientId,
      actionReplayVerified: replayedAction.replayed === true,
    }));
  } finally {
    unsubscribe();
    if (peer) await peer.close().catch(() => {});
    if (client) {
      if (pageId && client.state === "connected") await client.call("pages.close", { pageId }).catch(() => {});
      await client.close().catch(() => {});
    }
    stopHost(host);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
