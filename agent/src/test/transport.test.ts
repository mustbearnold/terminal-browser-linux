import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentError } from "../protocol/errors";
import { UnixSocketAgentServer } from "../transport/unix";

test("reports an incomplete frame when a Unix transport closes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-agent-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = new UnixSocketAgentServer(socketPath);
  let transportError: unknown;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  try {
    server.accept((transport) => {
      transport.onError((error) => {
        transportError = error;
      });
      transport.onClose(resolveClosed);
    });
    await server.listen();

    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.end('{"kind":"request"');
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("transport did not close")), 1000)),
    ]);

    assert.ok(transportError instanceof AgentError);
    assert.equal(transportError.code, "INVALID_MESSAGE");
    assert.equal(transportError.message, "transport ended mid-frame");
  } finally {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
