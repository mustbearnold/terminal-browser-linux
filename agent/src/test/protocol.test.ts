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
    () => parseAgentMessage({ ...listRequest(), op: "request.cancel" }),
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
