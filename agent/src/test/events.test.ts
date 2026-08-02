import assert from "node:assert/strict";
import test from "node:test";

import { AgentEventBus } from "../core/events";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  asPageId,
  type AgentEvent,
  type AgentEventType,
} from "../protocol/types";

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

test("filters replay and live delivery before counting subscription events", () => {
  const bus = new AgentEventBus(4);
  bus.publish(event(1, "dom.changed"));
  bus.publish(event(2, "focus.changed"));
  bus.publish(event(3, "dom.changed"));

  const received: number[] = [];
  const subscription = bus.subscribe((message) => received.push(message.sequence), {
    afterSequence: 0,
    filter: (message) => message.event === "dom.changed",
  });

  assert.deepEqual(received, [1, 3]);
  assert.equal(subscription.replayed, 2);
  bus.publish(event(4, "focus.changed"));
  bus.publish(event(5, "dom.changed"));
  assert.deepEqual(received, [1, 3, 5]);
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

test("rejects a cursor from a newer event stream", () => {
  const bus = new AgentEventBus();

  assert.throws(
    () => bus.subscribe(() => {}, { afterSequence: 1 }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "EVENT_GAP");
      assert.deepEqual((error as { details?: unknown }).details, {
        afterSequence: 1,
        earliestSequence: 1,
        latestSequence: 0,
      });
      return true;
    },
  );
});

function event(sequence: number, type: AgentEventType = "dom.changed"): AgentEvent {
  return {
    kind: "event",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    event: type,
    pageId,
    sequence,
  };
}
