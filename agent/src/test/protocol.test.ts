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

  const actionStatus = parseAgentMessage({
    ...listRequest(),
    requestId: "status-1",
    op: "page.act.status",
    pageId: "page-1",
    idempotencyKey: "action-1",
  });
  assert.equal(actionStatus.kind, "request");
  assert.equal((actionStatus as AgentRequest).op, "page.act.status");

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
  assert.throws(
    () => parseAgentMessage({ ...listRequest(), op: "page.act.status", pageId: "page-1", idempotencyKey: "" }),
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
      target: {
        locator: { kind: "role", role: "button", name: "Continue", exact: true },
        index: 0,
        frameId: "frame-1",
      },
      button: "left",
      clickCount: 2,
    },
    token: { pageId: "page-1", documentId: "document-1", revision: 3, snapshotId: "snapshot-1" },
    expect: {
      url: "https://example.com",
      element: {
        target: { locator: { kind: "role", role: "status", name: "Ready", exact: true } },
        state: { attached: true, text: "Ready" },
      },
      timeoutMs: 500,
      quietMs: 20,
    },
    output: {
      snapshot: "delta",
      base: { pageId: "page-1", documentId: "document-1", revision: 3, snapshotId: "snapshot-1" },
    },
  });
  assert.equal(valid.kind, "request");

  const window = parseAgentMessage({
    ...listRequest(),
    op: "page.snapshot.window",
    pageId: "page-1",
    options: { interactiveOnly: false, limit: 8 },
    cursor: {
      pageId: "page-1",
      documentId: "document-1",
      revision: 3,
      snapshotId: "snapshot-window-1",
      offset: 8,
      limit: 8,
    },
  });
  assert.equal(window.kind, "request");

  const query = parseAgentMessage({
    ...listRequest(),
    op: "page.query",
    pageId: "page-1",
    locator: {
      kind: "role",
      role: "button",
      name: "Continue",
      exact: true,
      state: { enabled: true, checked: false },
      within: { kind: "role", role: "region", name: "Primary card", exact: true },
    },
    options: { includeHidden: true, limit: 16, frameId: "frame-1" },
  });
  assert.equal(query.kind, "request");

  assert.throws(
    () => parseAgentMessage({
      ...listRequest(),
      op: "page.query",
      pageId: "page-1",
      locator: { kind: "role", role: "button", state: { enabled: "yes" } },
    }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );

  const queryBatch = parseAgentMessage({
    ...listRequest(),
    op: "page.query.batch",
    pageId: "page-1",
    queries: [
      { locator: { kind: "role", role: "button", name: "Continue", exact: true }, options: { limit: 4 } },
      { locator: { kind: "text", text: "Ready", exact: true } },
    ],
  });
  assert.equal(queryBatch.kind, "request");

  assert.throws(
    () => parseAgentMessage({
      ...listRequest(),
      op: "page.snapshot.window",
      pageId: "page-1",
      options: { limit: 1001 },
    }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );

  const reload = parseAgentMessage({
    ...listRequest(),
    op: "page.act",
    pageId: "page-1",
    action: { type: "reload", bypassCache: true },
  });
  assert.equal(reload.kind, "request");

  const targetedKeyboard = parseAgentMessage({
    ...listRequest(),
    op: "page.act",
    pageId: "page-1",
    action: {
      type: "type",
      text: "Ada",
      target: { locator: { kind: "role", role: "textbox", name: "Name", exact: true } },
    },
  });
  assert.equal(targetedKeyboard.kind, "request");

  const targetedPress = parseAgentMessage({
    ...listRequest(),
    op: "page.act",
    pageId: "page-1",
    action: {
      type: "press",
      key: "Enter",
      target: { ref: "r1" },
    },
  });
  assert.equal(targetedPress.kind, "request");

  const upload = parseAgentMessage({
    ...listRequest(),
    op: "page.act",
    pageId: "page-1",
    action: {
      type: "upload",
      target: { locator: { kind: "css", value: "#attachments" } },
      paths: ["/tmp/agent-one.txt", "/tmp/agent-two.txt"],
    },
    expect: {
      element: {
        target: { locator: { kind: "css", value: "#attachments" } },
        state: { fileCount: 2 },
      },
    },
  });
  assert.equal(upload.kind, "request");

  const drag = parseAgentMessage({
    ...listRequest(),
    op: "page.act",
    pageId: "page-1",
    action: {
      type: "drag",
      source: { locator: { kind: "css", value: "#drag-source" } },
      target: { locator: { kind: "css", value: "#drop-target" } },
    },
  });
  assert.equal(drag.kind, "request");

  const history = parseAgentMessage({
    ...listRequest(),
    op: "page.act",
    pageId: "page-1",
    action: { type: "history", direction: "back" },
  });
  assert.equal(history.kind, "request");

  const dialog = parseAgentMessage({
    ...listRequest(),
    op: "page.dialog",
    pageId: "page-1",
    dialogId: "dialog-1",
    action: { type: "accept", promptText: "Ada" },
  });
  assert.equal(dialog.kind, "request");

  const elementWait = parseAgentMessage({
    ...listRequest(),
    op: "page.wait",
    pageId: "page-1",
    condition: {
      type: "element",
      target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } },
      state: {
        attached: true,
        visible: true,
        enabled: true,
        disabled: false,
        focused: false,
        value: "",
        checked: false,
        expanded: false,
        invalid: false,
        pressed: false,
        readOnly: false,
        required: false,
        selected: false,
        text: "Continue",
      },
    },
    output: { snapshot: "none" },
  });
  assert.equal(elementWait.kind, "request");

  const activate = parseAgentMessage({
    ...listRequest(),
    op: "pages.activate",
    pageId: "page-1",
  });
  assert.equal(activate.kind, "request");

  const batch = parseAgentMessage({
    ...listRequest(),
    op: "page.act.batch",
    pageId: "page-1",
    steps: [{
      action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } } },
      expect: { text: "Ready", quietMs: 20 },
    }],
    output: { snapshot: "none" },
    idempotencyKey: "batch-1",
  });
  assert.equal(batch.kind, "request");

  const invalid = (body: Record<string, unknown>) => {
    assert.throws(
      () => parseAgentMessage({ ...listRequest(), ...body }),
      (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
    );
  };

  invalid({ op: "page.read", pageId: "page-1", target: { ref: "r1", locator: { kind: "css", value: "button" } } });
  invalid({ op: "page.read", pageId: "page-1", target: { ref: "r1", index: 0 } });
  invalid({ op: "page.read", pageId: "page-1", target: { locator: { kind: "role", role: "button" }, index: -1 } });
  invalid({ op: "page.read", pageId: "page-1", target: { locator: { kind: "role", role: "button" }, index: 256 } });
  invalid({ op: "page.read", pageId: "page-1", target: { locator: { kind: "role", role: "button" }, frameId: "" } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "scroll", direction: "diagonal" } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "fill", target: { ref: "r1" } } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "upload", target: { ref: "r1" }, paths: ["relative.txt"] } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "upload", target: { ref: "r1" }, paths: ["/tmp/a\u0000.txt"] } });
  invalid({
    op: "page.act",
    pageId: "page-1",
    action: { type: "upload", target: { ref: "r1" }, paths: Array.from({ length: 65 }, (_, index) => `/tmp/${index}.txt`) },
  });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "upload", target: { ref: "r1" }, paths: ["/tmp/a.txt"] }, expect: { element: { target: { ref: "r1" }, state: { fileCount: 65 } } } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "drag", target: { ref: "r1" } } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "drag", source: { ref: "r1", locator: { kind: "css", value: "#source" } }, target: { ref: "r2" } } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "reload", bypassCache: "yes" } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "history", direction: "sideways" } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "click", target: { ref: "r1" } }, expect: { timeoutMs: -1 } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "click", target: { ref: "r1" } }, expect: { element: { target: { ref: "r1" }, state: { visible: "yes" } } } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "click", target: { ref: "r1" } }, expect: { element: { target: { ref: "r1", locator: { kind: "css", value: "button" } } } } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "click", target: { ref: "r1" } }, output: { snapshot: "compressed" } });
  invalid({ op: "page.act", pageId: "page-1", action: { type: "click", target: { ref: "r1" } }, output: { snapshot: "delta" } });
  invalid({ op: "page.act.batch", pageId: "page-1", steps: [] });
  invalid({ op: "page.act.batch", pageId: "page-1", steps: [{ action: { type: "click" } }] });
  invalid({ op: "page.query", pageId: "page-1" });
  invalid({ op: "page.query", pageId: "page-1", locator: { kind: "role", role: "button" }, options: { limit: 257 } });
  invalid({ op: "page.query", pageId: "page-1", locator: { kind: "role", role: "button" }, options: { frameId: "" } });
  invalid({ op: "page.query", pageId: "page-1", locator: { kind: "role", role: "button" }, options: { diagnostics: "full" } });
  invalid({ op: "page.query.batch", pageId: "page-1", queries: [] });
  invalid({ op: "page.query.batch", pageId: "page-1", queries: Array.from({ length: 33 }, () => ({ locator: { kind: "role", role: "button" } })) });
  invalid({ op: "page.query.batch", pageId: "page-1", queries: [{ locator: { kind: "role", role: "button" }, options: { limit: 257 } }] });
  let deepLocator: unknown = { kind: "role", role: "button" };
  for (let index = 0; index < 8; index += 1) {
    deepLocator = { kind: "role", role: "region", within: deepLocator };
  }
  invalid({ op: "page.query", pageId: "page-1", locator: deepLocator });
  invalid({
    op: "page.act",
    pageId: "page-1",
    action: { type: "click", target: { ref: "r1" } },
    output: { snapshot: "none", base: { pageId: "page-1", documentId: "document-1", revision: 0, snapshotId: "snapshot-1" } },
  });
  invalid({ op: "page.wait", pageId: "page-1", condition: { type: "time", ms: 0 }, output: { snapshot: "delta" } });
  invalid({
    op: "page.wait",
    pageId: "page-1",
    condition: { type: "time", ms: 0 },
    output: { snapshot: "none", base: { pageId: "page-1", documentId: "document-1", revision: 0, snapshotId: "snapshot-1" } },
  });
  invalid({ op: "page.dialog", pageId: "page-1", dialogId: "dialog-1", action: { type: "accept", promptText: 1 } });
  invalid({ op: "page.dialog", pageId: "page-1", dialogId: "dialog-1", action: { type: "answer" } });
  invalid({ op: "page.wait", pageId: "page-1", condition: { type: "element", target: { ref: "r1" }, state: { enabled: "yes" } } });
  invalid({ op: "page.wait", pageId: "page-1", condition: { type: "element", target: { ref: "r1" }, state: { attached: "yes" } } });
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
