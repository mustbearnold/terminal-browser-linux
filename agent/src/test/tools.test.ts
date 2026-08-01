import assert from "node:assert/strict";
import test from "node:test";

import { AgentError } from "../protocol/errors";
import { createFixtureAgentHarness } from "../evaluation/loopback";
import { AgentToolClient } from "../tools";
import { FIXTURE_PAGE_ID } from "./fixture";

test("publishes only the structured tools accepted during negotiation", async () => {
  const harness = createFixtureAgentHarness({
    clientId: "tool-manifest-test",
    capabilities: ["snapshot.read", "page.read"],
  });
  const tools = new AgentToolClient(harness.client);

  const manifest = await tools.manifest();

  assert.deepEqual(manifest.capabilities, ["snapshot.read", "page.read"]);
  assert.equal(manifest.protocol, "terminal-browser.agent/tools");
  assert.equal(manifest.version, 1);
  assert.deepEqual(
    manifest.tools.map((definition) => definition.name),
    ["terminal_browser_page_snapshot", "terminal_browser_page_read"],
  );
  const readDefinition = manifest.tools.find((definition) => definition.name === "terminal_browser_page_read");
  assert.ok(readDefinition?.inputSchema.$defs?.locator);
  await tools.close();
});

test("validates and dispatches structured calls through the typed client", async () => {
  const harness = createFixtureAgentHarness({ clientId: "tool-call-test" });
  const tools = new AgentToolClient(harness.client);

  const snapshot = await tools.callTool("terminal_browser_page_snapshot", {
    pageId: String(FIXTURE_PAGE_ID),
    options: { interactiveOnly: false },
  });
  assert.equal(snapshot.pageId, FIXTURE_PAGE_ID);
  assert.equal(snapshot.nodes.some((node) => node.name === "Fixture content"), true);

  const query = await tools.callTool("terminal_browser_page_query", {
    pageId: String(FIXTURE_PAGE_ID),
    locator: {
      kind: "role",
      role: "textbox",
      name: "Name",
      exact: true,
      within: { kind: "role", role: "generic", name: "Fixture content", exact: true },
    },
    options: { limit: 1 },
  });
  assert.equal(query.matchCount, 1);
  assert.equal(query.nodes.length, 1);

  const queryBatch = await tools.callTool("terminal_browser_page_query_batch", {
    pageId: String(FIXTURE_PAGE_ID),
    queries: [
      {
        locator: { kind: "role", role: "textbox", name: "Name", exact: true },
        options: { frameId: String(query.nodes[0].frameId), limit: 1 },
      },
      {
        locator: { kind: "role", role: "button", name: "Continue", exact: true },
        options: { limit: 1 },
      },
    ],
  });
  assert.equal(queryBatch.queries.length, 2);
  assert.equal(queryBatch.queries[0].nodes[0].name, "Name");
  assert.equal(queryBatch.queries[1].nodes[0].name, "Continue");
  assert.equal(queryBatch.queries[0].nodes[0].frameId, queryBatch.queries[1].nodes[0].frameId);

  const read = await tools.callTool("terminal_browser_page_read", {
    pageId: String(FIXTURE_PAGE_ID),
    target: {
      locator: { kind: "role", role: "textbox", name: "Name", exact: true },
      index: 0,
      frameId: String(query.nodes[0].frameId),
    },
  });
  assert.equal(read.node.name, "Name");
  assert.equal(read.revision, 0);

  const batch = await tools.callTool("terminal_browser_page_act_batch", {
    pageId: String(FIXTURE_PAGE_ID),
    steps: [{
      action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Continue", exact: true } } },
      expect: { text: "Ready" },
    }],
    output: { snapshot: "none" },
    idempotencyKey: "tool-batch-1",
  });
  assert.equal(batch.verified, true);
  assert.equal(batch.completed, 1);
  assert.equal(batch.snapshot, undefined);

  const targetedType = await tools.callTool("terminal_browser_page_act", {
    pageId: String(FIXTURE_PAGE_ID),
    action: {
      type: "type",
      text: " Ada",
      target: { locator: { kind: "role", role: "textbox", name: "Name", exact: true } },
    },
    output: { snapshot: "none" },
  });
  assert.equal(targetedType.verified, true);
  assert.equal(targetedType.proof?.target !== undefined, true);

  const compactWait = await tools.callTool("terminal_browser_page_wait", {
    pageId: String(FIXTURE_PAGE_ID),
    condition: { type: "text", value: "Fixture" },
    output: { snapshot: "none" },
  });
  assert.equal(compactWait.satisfied, true);
  assert.equal(compactWait.snapshot, undefined);

  const missingAction = await tools.callTool("terminal_browser_page_act_status", {
    pageId: String(FIXTURE_PAGE_ID),
    idempotencyKey: "not-started",
  });
  assert.equal(missingAction.status, "missing");

  await assert.rejects(
    tools.callTool("terminal_browser_page_act", {
      pageId: String(FIXTURE_PAGE_ID),
      action: { type: "click" },
    }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_MESSAGE",
  );
  await assert.rejects(
    tools.callTool("unknown_tool", {}),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    tools.callTool("terminal_browser_page_snapshot", {
      pageId: String(FIXTURE_PAGE_ID),
      protocol: "terminal-browser.agent",
    }),
    (error: unknown) => error instanceof AgentError && error.code === "INVALID_REQUEST",
  );
  await tools.close();
});

test("exposes request handles for concurrent cancellation", async () => {
  const harness = createFixtureAgentHarness({ clientId: "tool-handle-test" });
  const tools = new AgentToolClient(harness.client);
  try {
    const call = await tools.startTool("terminal_browser_page_wait", {
      pageId: String(FIXTURE_PAGE_ID),
      condition: { type: "time", ms: 1000 },
      timeoutMs: 1000,
    });
    assert.match(call.requestId, /:page\.wait:/);
    assert.equal(await call.cancel(), true);
    await assert.rejects(
      call.promise,
      (error: unknown) => error instanceof AgentError && error.code === "REQUEST_CANCELLED",
    );
  } finally {
    await tools.close();
  }
});
