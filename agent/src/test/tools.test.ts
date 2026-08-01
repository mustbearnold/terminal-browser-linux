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

  const node = await tools.callTool("terminal_browser_page_read", {
    pageId: String(FIXTURE_PAGE_ID),
    target: { locator: { kind: "role", role: "textbox", name: "Name", exact: true } },
  });
  assert.equal(node.name, "Name");

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
