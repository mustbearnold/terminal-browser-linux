import assert from "node:assert/strict";
import test from "node:test";

import { AgentError } from "../protocol/errors";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  type AgentRequest,
} from "../protocol/types";
import { parseAgentMessage } from "../protocol/validate";
import { LineJsonDecoder, encodeAgentMessage } from "../transport/line-json";

function listRequest(): AgentRequest {
  return {
    kind: "request",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    requestId: "request-1",
    op: "pages.list",
  };
}

test("validates and round-trips a line-delimited request", () => {
  const message = listRequest();
  const encoded = encodeAgentMessage(message);
  const decoder = new LineJsonDecoder();

  assert.deepEqual(decoder.push(encoded.slice(0, 12)), []);
  assert.deepEqual(decoder.push(encoded.slice(12)), [message]);
  decoder.flush();
});

test("rejects an unsupported protocol version", () => {
  assert.throws(
    () =>
      parseAgentMessage({
        ...listRequest(),
        version: 99,
      }),
    (error: unknown) => error instanceof AgentError && error.code === "PROTOCOL_MISMATCH",
  );
});

test("rejects unknown and incomplete request operations", () => {
  assert.throws(
    () => parseAgentMessage({ ...listRequest(), op: "pages.nope" }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );
  assert.throws(
    () => parseAgentMessage({ ...listRequest(), op: "page.snapshot" }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );
  assert.throws(
    () => parseAgentMessage({ ...listRequest(), op: "page.frames" }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );
});

test("validates request deadlines and cancellation operations", () => {
  const deadline = parseAgentMessage({ ...listRequest(), deadlineMs: 250 });
  assert.equal(deadline.kind, "request");
  assert.equal((deadline as AgentRequest).deadlineMs, 250);

  const cancellation = parseAgentMessage({
    ...listRequest(),
    requestId: "cancel-1",
    op: "request.cancel",
    targetRequestId: "request-1",
  });
  assert.equal(cancellation.kind, "request");
  assert.equal((cancellation as AgentRequest).op, "request.cancel");

  assert.throws(
    () => parseAgentMessage({ ...listRequest(), deadlineMs: -1 }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );
  assert.throws(
    () => parseAgentMessage({ ...listRequest(), deadlineMs: 1.5 }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );
  assert.throws(
    () => parseAgentMessage({
      ...listRequest(),
      op: "page.observe",
      pageId: "page-1",
      events: ["dom.changed"],
      afterSequence: -1,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );
  assert.throws(
    () => parseAgentMessage({
      ...listRequest(),
      op: "page.act",
      pageId: "page-1",
      action: { type: "click" },
      idempotencyKey: "",
    }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );
  assert.throws(
    () => parseAgentMessage({ ...listRequest(), op: "request.cancel" }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );
});

test("validates nested agent request shapes at the wire boundary", () => {
  const valid = parseAgentMessage({
    ...listRequest(),
    op: "page.act",
    pageId: "page-1",
    action: {
      type: "click",
      target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } },
      button: "left",
      clickCount: 2,
    },
    token: { pageId: "page-1", documentId: "document-1", revision: 3, snapshotId: "snapshot-1" },
    expect: { url: "https://example.com", timeoutMs: 500, quietMs: 20 },
  });
  assert.equal(valid.kind, "request");

  const reload = parseAgentMessage({
    ...listRequest(),
    op: "page.act",
    pageId: "page-1",
    action: { type: "reload", bypassCache: true },
  });
  assert.equal(reload.kind, "request");

  const history = parseAgentMessage({
    ...listRequest(),
    op: "page.act",
    pageId: "page-1",
    action: { type: "history", direction: "back" },
  });
  assert.equal(history.kind, "request");

  const activate = parseAgentMessage({
    ...listRequest(),
    op: "pages.activate",
    pageId: "page-1",
  });
  assert.equal(activate.kind, "request");

  const invalid = (body: Record<string, unknown>) => {
    assert.throws(
      () => parseAgentMessage({ ...listRequest(), ...body }),
      (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
    );
  };

  invalid({ op: "page.read", pageId: "page-1", target: { ref: "r1", locator: { kind: "css", value: "button" } } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "scroll", direction: "diagonal" } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "fill", target: { ref: "r1" } } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "reload", bypassCache: "yes" } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "history", direction: "sideways" } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "click", target: { ref: "r1" } }, expect: { timeoutMs: -1 } });
  invalid({ op: "page.wait", pageId: "page-1", condition: { type: "stable", quietMs: 1.5 } });
  invalid({ op: "page.read", pageId: "page-1", target: { ref: "r1" }, token: { pageId: "page-1" } });
  invalid({ op: "page.observe", pageId: "page-1", events: ["unknown.event"] });
});

test("validates response errors and event sequences", () => {
  assert.throws(
    () => parseAgentMessage({
      kind: "response",
      protocol: AGENT_PROTOCOL,
      version: AGENT_PROTOCOL_VERSION,
      requestId: "request-1",
      ok: false,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );
  assert.throws(
    () => parseAgentMessage({
      kind: "event",
      protocol: AGENT_PROTOCOL,
      version: AGENT_PROTOCOL_VERSION,
      event: "dom.changed",
      pageId: "page-1",
      sequence: -1,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );
});

test("validates page capture options", () => {
  const capture = parseAgentMessage({
    ...listRequest(),
    op: "page.capture",
    pageId: "page-1",
    options: { format: "jpeg", quality: 80, fullPage: true },
  });
  assert.equal(capture.kind, "request");

  for (const options of [
    { format: "gif" },
    { quality: 101 },
    { quality: 1.5 },
    { fullPage: "yes" },
  ]) {
    assert.throws(
      () => parseAgentMessage({ ...listRequest(), op: "page.capture", pageId: "page-1", options }),
      (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
    );
  }
});

test("validates snapshot delta bases", () => {
  const delta = parseAgentMessage({
    ...listRequest(),
    op: "page.snapshot.delta",
    pageId: "page-1",
    base: { pageId: "page-1", documentId: "document-1", revision: 2, snapshotId: "snapshot-1" },
    options: { interactiveOnly: false },
  });
  assert.equal(delta.kind, "request");
  assert.throws(
    () => parseAgentMessage({ ...listRequest(), op: "page.snapshot.delta", pageId: "page-1", base: { pageId: "page-1" } }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );
});

test("rejects incomplete transport frames", () => {
  const decoder = new LineJsonDecoder();
  decoder.push(encodeAgentMessage(listRequest()).trimEnd().slice(0, -1));
  assert.throws(
    () => decoder.flush(),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );
});
