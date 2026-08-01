import assert from "node:assert/strict";
import test from "node:test";

import { AgentEventBus } from "../core/events";
import { AGENT_PROTOCOL, AGENT_PROTOCOL_VERSION, asPageId, type AgentEvent } from "../protocol/types";

const pageId = asPageId("events/page/1");

test("replays retained events from a cursor and reports the latest sequence", () => {
  const bus = new AgentEventBus(3);
  bus.publish(event(1));
  bus.publish(event(2));

  const received: number[] = [];
  const subscription = bus.subscribe((message) => received.push(message.sequence), { afterSequence: 0 });

  assert.deepEqual(received, [1, 2]);
  assert.equal(subscription.sequence, 2);
  assert.equal(subscription.replayed, 2);
  subscription.unsubscribe();
});

test("rejects a cursor older than retained event history", () => {
  const bus = new AgentEventBus(2);
  bus.publish(event(1));
  bus.publish(event(2));
  bus.publish(event(3));

  assert.throws(
    () => bus.subscribe(() => {}, { afterSequence: 0 }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "EVENT_GAP");
      assert.deepEqual((error as { details?: unknown }).details, {
        afterSequence: 0,
        earliestSequence: 2,
        latestSequence: 3,
      });
      return true;
    },
  );

  const received: number[] = [];
  const subscription = bus.subscribe((message) => received.push(message.sequence), { afterSequence: 1 });
  assert.deepEqual(received, [2, 3]);
  assert.equal(subscription.replayed, 2);
  subscription.unsubscribe();
});

function event(sequence: number): AgentEvent {
  return {
    kind: "event",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    event: "dom.changed",
    pageId,
    sequence,
  };
}
