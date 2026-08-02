"use strict";

const assert = require("node:assert/strict");
const { AgentClient, AgentToolClient } = require("../../agent/dist");
const { AgentToolLineSession } = require("../../cli/dist/agent-tools.js");
const { MCP_CONNECTION_RECONNECT_METHOD, McpServerSession } = require("../../cli/dist/agent-mcp.js");
const { superviseAgentConnection } = require("../../cli/dist/agent-recovery.js");
const { dataUrl, launchHost, listSockets, stopHost, waitForSocket } = require("./agent-smoke-support.cjs");

const html = "<!doctype html><meta charset=\"utf-8\"><title>Host protocol smoke</title><main>Protocol host</main>";

async function run() {
  const existing = new Set(listSockets());
  const { host, output } = launchHost();
  let jsonClient;
  let jsonTools;
  let jsonSupervisor;
  let mcpClient;
  let mcpTools;
  let mcpSupervisor;
  let pageId;
  try {
    const socket = await waitForSocket(existing, 15_000, output);
    jsonClient = await AgentClient.connect(socket, { clientId: "host-jsonl-smoke" });
    jsonTools = new AgentToolClient(jsonClient);
    const manifest = await jsonTools.manifest();
    assert.equal(manifest.protocol, "terminal-browser.agent/tools");
    assert.ok(manifest.tools.some((tool) => tool.name === "terminal_browser_pages_open"));

    const lifecycle = [];
    jsonSupervisor = superviseAgentConnection(jsonTools, (state) => lifecycle.push(state.state));
    const jsonlMessages = [];
    const jsonl = new AgentToolLineSession(jsonTools, (message) => jsonlMessages.push(message), {
      reconnect: (options) => jsonSupervisor.reconnect(options),
    });
    const disconnect = jsonTools.disconnect();
    const control = jsonl.handle(JSON.stringify({
      kind: "control",
      id: "reconnect",
      op: "connection.reconnect",
    }));
    await Promise.all([disconnect, control]);
    await jsonl.drain();
    await waitFor(() => lifecycle.includes("connected"), 10_000, "JSONL reconnect");
    const controlResult = jsonlMessages.find((message) => message.kind === "control" && message.id === "reconnect");
    assert.deepEqual(controlResult, {
      kind: "control",
      id: "reconnect",
      op: "connection.reconnect",
      ok: true,
      state: "connected",
    });
    const pages = await jsonlCall(jsonl, jsonlMessages, "pages", "terminal_browser_pages_list", {});
    assert.ok(Array.isArray(pages.pages));
    const opened = await jsonlCall(jsonl, jsonlMessages, "open", "terminal_browser_pages_open", {
      url: dataUrl(html),
    });
    pageId = opened.pageId;
    const snapshot = await jsonlCall(jsonl, jsonlMessages, "snapshot", "terminal_browser_page_snapshot", { pageId });
    assert.equal(typeof snapshot.revision, "number");
    const annotation = await jsonlCall(jsonl, jsonlMessages, "annotation", "terminal_browser_page_annotation_create", {
      pageId,
      target: { locator: { kind: "role", role: "main", name: "Protocol host", exact: true } },
      note: "Host protocol smoke annotation",
    });
    assert.equal(annotation.tag, "@tb-1");
    assert.equal(annotation.stale, false);
    const annotationList = await jsonlCall(jsonl, jsonlMessages, "annotations", "terminal_browser_page_annotation_list", { pageId });
    assert.equal(annotationList.annotations.length, 1);
    await jsonlCall(jsonl, jsonlMessages, "close", "terminal_browser_pages_close", { pageId });
    pageId = undefined;
    jsonSupervisor.dispose();
    await jsonTools.close();
    jsonTools = undefined;
    jsonClient = undefined;

    mcpClient = await AgentClient.connect(socket, { clientId: "host-mcp-smoke" });
    mcpTools = new AgentToolClient(mcpClient);
    const mcpMessages = [];
    const mcpLifecycle = [];
    const mcp = new McpServerSession(mcpTools, (message) => mcpMessages.push(message), {
      reconnect: (options) => mcpSupervisor.reconnect(options),
    });
    mcpSupervisor = superviseAgentConnection(mcpTools, (state) => {
      mcpLifecycle.push(state.state);
      mcp.notifyConnection(state);
    });
    await mcp.handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "host-protocol-smoke", version: "1" },
      },
    }));
    const mcpDisconnect = mcpClient.disconnect();
    const mcpControl = mcp.handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: MCP_CONNECTION_RECONNECT_METHOD,
    }));
    await Promise.all([mcpDisconnect, mcpControl]);
    await mcp.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    await mcp.handle(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
    await mcp.handle(JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "terminal_browser_pages_list", arguments: {} },
    }));
    await mcp.drain();
    const initializeResponse = rpcResponse(mcpMessages, 1);
    const reconnectResponse = rpcResponse(mcpMessages, 2);
    const listResponse = rpcResponse(mcpMessages, 3);
    const callResponse = rpcResponse(mcpMessages, 4);
    assert.equal(initializeResponse.result.protocolVersion, "2025-11-25");
    assert.deepEqual(reconnectResponse.result, { state: "connected" });
    assert.ok(listResponse.result.tools.some((tool) => tool.name === "terminal_browser_pages_open"));
    assert.equal(callResponse.result.isError, undefined);
    assert.ok(Array.isArray(callResponse.result.structuredContent.pages));
    mcpSupervisor.dispose();
    await mcpTools.close();
    mcpTools = undefined;
    mcpClient = undefined;

    console.log(JSON.stringify({
      protocol: "terminal-browser.agent/1",
      jsonl: {
        manifestTools: manifest.tools.length,
        lifecycle,
        explicitReconnect: controlResult.ok,
        pages: pages.pages.length,
        snapshotRevision: snapshot.revision,
        annotationTag: annotation.tag,
      },
      mcp: {
        protocolVersion: initializeResponse.result.protocolVersion,
        lifecycle: mcpLifecycle,
        explicitReconnect: reconnectResponse.result.state === "connected",
        tools: listResponse.result.tools.length,
        pages: callResponse.result.structuredContent.pages.length,
      },
    }));
  } finally {
    if (jsonSupervisor) jsonSupervisor.dispose();
    if (mcpSupervisor) mcpSupervisor.dispose();
    if (pageId && jsonClient) await jsonClient.call("pages.close", { pageId }).catch(() => {});
    if (jsonTools) await jsonTools.close().catch(() => {});
    else if (jsonClient) await jsonClient.close().catch(() => {});
    if (mcpTools) await mcpTools.close().catch(() => {});
    else if (mcpClient) await mcpClient.close().catch(() => {});
    stopHost(host);
  }
}

function rpcResponse(messages, id) {
  const response = messages.find((message) => message.id === id);
  assert.ok(response, `MCP response was not returned for ${id}`);
  assert.equal(response.error, undefined, JSON.stringify(response));
  return response;
}

async function jsonlCall(session, messages, id, name, argumentsValue) {
  const start = messages.length;
  await session.handle(JSON.stringify({ id, name, arguments: argumentsValue }));
  await session.drain();
  const result = messages.slice(start).find((message) => message.kind === "result" && message.id === id);
  assert.ok(result, `JSONL result was not returned for ${id}`);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.result;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} did not complete within ${timeoutMs}ms`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
