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
});

test("rejects incomplete transport frames", () => {
  const decoder = new LineJsonDecoder();
  decoder.push(encodeAgentMessage(listRequest()).trimEnd().slice(0, -1));
  assert.throws(
    () => decoder.flush(),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );
});
