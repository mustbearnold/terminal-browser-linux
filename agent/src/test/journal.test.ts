import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentEventBus } from "../core/events";
import { DurableAgentJournal, DurableActionJournal, DurableEventHistory } from "../core/journal";
import { AGENT_PROTOCOL, AGENT_PROTOCOL_VERSION, asPageId, type ActionResult, type AgentEvent } from "../protocol/types";

test("replays completed actions from a new durable journal instance", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-agent-journal-"));
  try {
    const filePath = path.join(directory, "actions.json");
    const first = new DurableActionJournal(filePath);
    const result: ActionResult = { verified: true, effects: [] };
    let calls = 0;
    assert.deepEqual(await first.execute("key", "fingerprint", async () => {
      calls += 1;
      return result;
    }), { result, replayed: false });

    const second = new DurableActionJournal(filePath);
    assert.deepEqual(await second.execute("key", "fingerprint", async () => {
      calls += 1;
      return { verified: false, effects: [] };
    }), { result, replayed: true });
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("does not repeat an action whose durable outcome is uncertain", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-agent-journal-"));
  try {
    const filePath = path.join(directory, "actions.json");
    const first = new DurableActionJournal(filePath);
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = first.execute("key", "fingerprint", async () => {
      started();
      await gate;
      return { verified: true, effects: [] };
    });
    await startedPromise;

    const restarted = new DurableActionJournal(filePath);
    await assert.rejects(
      Promise.resolve().then(() => restarted.execute("key", "fingerprint", async () => ({ verified: false, effects: [] }))),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ACTION_STATUS_UNKNOWN",
    );
    release();
    await pending;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("persists event history for cursor replay", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-agent-journal-"));
  try {
    const pageId = asPageId("durable/page/1");
    const filePath = path.join(directory, "events.json");
    const first = new AgentEventBus(2, new DurableEventHistory(filePath, 2));
    first.publish(event(pageId, 1));
    first.publish(event(pageId, 2));
    first.publish(event(pageId, 3));

    const second = new AgentEventBus(2, new DurableEventHistory(filePath, 2));
    second.publish(event(pageId, 4));
    const received: number[] = [];
    const subscription = second.subscribe((message) => received.push(message.sequence), { afterSequence: 2 });
    assert.deepEqual(received, [3, 4]);
    assert.equal(subscription.replayed, 2);
    subscription.unsubscribe();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("shares a pending action and preserves its journal namespace", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-agent-journal-"));
  try {
    const journal = new DurableAgentJournal(path.join(directory, "agent"));
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = async () => {
      calls += 1;
      await gate;
      return { verified: true, effects: [] };
    };
    const first = journal.actions.execute("key", "fingerprint", operation);
    const second = journal.actions.execute("key", "fingerprint", operation);
    release();
    assert.deepEqual(await first, { result: { verified: true, effects: [] }, replayed: false });
    assert.deepEqual(await second, { result: { verified: true, effects: [] }, replayed: true });
    assert.equal(calls, 1);
    assert.equal(journal.eventHistory(asPageId("durable/page/1")), journal.eventHistory(asPageId("durable/page/1")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function event(pageId: ReturnType<typeof asPageId>, sequence: number): AgentEvent {
  return {
    kind: "event",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    event: "dom.changed",
    pageId,
    sequence,
  };
}
