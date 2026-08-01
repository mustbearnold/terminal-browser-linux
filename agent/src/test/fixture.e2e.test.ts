import assert from "node:assert/strict";
import test from "node:test";

import { AgentRequestRouter, type AgentConnectionContext } from "../core/router";
import type { AgentEvent, AgentRequest, AgentResponse, PageSnapshot, SnapshotNode } from "../protocol/types";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  type PageIdentity,
} from "../protocol/types";
import { FIXTURE_PAGE_ID, FixtureRuntime } from "./fixture";

let requestSequence = 0;

test("runs the deterministic agent control contract", async () => {
  const runtime = new FixtureRuntime();
  const router = new AgentRequestRouter(runtime);
  const events: AgentEvent[] = [];
  const cleanups: (() => void)[] = [];
  const context: AgentConnectionContext = {
    clientId: "fixture-e2e",
    emit: (message) => {
      events.push(message as AgentEvent);
    },
    addSubscription: (cleanup) => cleanups.push(cleanup),
  };

  const hello = result<{ capabilities: readonly string[] }>(
    await router.handle(request("hello", { clientId: "fixture-e2e" }), context),
  );
  assert.equal(hello.capabilities.includes("page.act"), true);

  const pages = result<{ pages: PageIdentity[] }>(await router.handle(request("pages.list"), context));
  assert.equal(pages.pages[0].pageId, FIXTURE_PAGE_ID);

  const snapshot = result<PageSnapshot>(
    await router.handle(
      request("page.snapshot", {
        pageId: FIXTURE_PAGE_ID,
        options: { interactiveOnly: false, includeGeometry: false },
      }),
      context,
    ),
  );
  assert.equal(snapshot.nodes.some((node) => node.role === "generic"), true);

  const read = result<SnapshotNode>(
    await router.handle(
      request("page.read", {
        pageId: FIXTURE_PAGE_ID,
        target: { locator: { kind: "role", role: "textbox", name: "Name", exact: true } },
        token: token(snapshot),
      }),
      context,
    ),
  );
  assert.equal(read.name, "Name");

  result(await router.handle(request("page.observe", { pageId: FIXTURE_PAGE_ID, events: ["dom.changed"] }), context));

  const filled = result<{ verified: boolean; proof?: { value?: string }; snapshot?: PageSnapshot }>(
    await router.handle(
      request("page.act", {
        pageId: FIXTURE_PAGE_ID,
        token: token(snapshot),
        action: { type: "fill", target: { ref: read.ref }, value: "Ada" },
      }),
      context,
    ),
  );
  assert.equal(filled.verified, true);
  assert.equal(filled.proof?.value, "Ada");

  const typed = result<{ verified: boolean; proof?: { value?: string }; snapshot?: PageSnapshot }>(
    await router.handle(
      request("page.act", {
        pageId: FIXTURE_PAGE_ID,
        token: token(filled.snapshot!),
        action: { type: "type", text: " Lovelace" },
      }),
      context,
    ),
  );
  assert.equal(typed.verified, true);
  assert.equal(typed.proof?.value, "Ada Lovelace");

  const pressed = result<{ verified: boolean; proof?: { value?: string }; snapshot?: PageSnapshot }>(
    await router.handle(
      request("page.act", {
        pageId: FIXTURE_PAGE_ID,
        token: token(typed.snapshot!),
        action: { type: "press", key: "Enter" },
        expect: { text: "Ready" },
      }),
      context,
    ),
  );
  assert.equal(pressed.verified, true);
  assert.equal(pressed.proof?.value, "Ada Lovelace");
  assert.equal(pressed.snapshot?.nodes.some((node) => node.name === "Ready"), true);
  assert.deepEqual(events.map((event) => event.event), ["dom.changed", "dom.changed", "dom.changed"]);

  const waited = result<{ satisfied: boolean; snapshot?: PageSnapshot }>(
    await router.handle(
      request("page.wait", { pageId: FIXTURE_PAGE_ID, condition: { type: "text", value: "Ready" } }),
      context,
    ),
  );
  assert.equal(waited.satisfied, true);

  const stale = await router.handle(
    request("page.act", {
      pageId: FIXTURE_PAGE_ID,
      token: token(snapshot),
      action: { type: "fill", target: { ref: read.ref }, value: "stale" },
    }),
    context,
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, "STALE_SNAPSHOT");
  assert.equal(stale.error?.retryable, true);

  for (const cleanup of cleanups) cleanup();
});

function request<T extends AgentRequest["op"]>(op: T, fields: Record<string, unknown> = {}): AgentRequest {
  return {
    kind: "request",
    protocol: AGENT_PROTOCOL,
    version: AGENT_PROTOCOL_VERSION,
    requestId: `${op}-${++requestSequence}`,
    op,
    ...fields,
  } as AgentRequest;
}

function result<T>(response: AgentResponse): T {
  assert.equal(response.ok, true);
  return response.result as T;
}

function token(snapshot: PageSnapshot) {
  return {
    pageId: snapshot.pageId,
    documentId: snapshot.documentId,
    revision: snapshot.revision,
    snapshotId: snapshot.snapshotId,
  };
}
