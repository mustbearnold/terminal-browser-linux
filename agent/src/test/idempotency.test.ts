import assert from "node:assert/strict";
import test from "node:test";

import { AgentError } from "../protocol/errors";
import { IdempotencyCache, stableSerialize } from "../core/idempotency";

test("shares an in-flight operation and marks later results as replayed", async () => {
  const cache = new IdempotencyCache<string>();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = async () => {
    calls += 1;
    await gate;
    return "done";
  };

  const first = cache.execute("key", "fingerprint", operation);
  const second = cache.execute("key", "fingerprint", operation);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();

  assert.deepEqual(await first, { result: "done", replayed: false });
  assert.deepEqual(await second, { result: "done", replayed: true });
});

test("reports missing, running, and completed action states", async () => {
  const cache = new IdempotencyCache<string>();
  assert.deepEqual(cache.status("missing"), { status: "missing" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = cache.execute("key", "fingerprint", async () => {
    await gate;
    return "done";
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(cache.status("key"), { status: "running" });
  release();
  await pending;
  assert.deepEqual(cache.status("key"), { status: "completed", result: "done" });
});

test("rejects a key reused with a different fingerprint and forgets failures", async () => {
  const cache = new IdempotencyCache<string>();
  await cache.execute("key", "first", async () => "done");
  assert.throws(
    () => cache.execute("key", "second", async () => "done"),
    (error: unknown) => error instanceof AgentError && error.code === "IDEMPOTENCY_CONFLICT",
  );

  await assert.rejects(cache.execute("failure", "fingerprint", async () => {
    throw new Error("transient");
  }), /transient/);
  assert.deepEqual(await cache.execute("failure", "fingerprint", async () => "recovered"), {
    result: "recovered",
    replayed: false,
  });
});

test("serializes request values independently of object key order", () => {
  assert.equal(
    stableSerialize({ action: { value: "Ada", type: "fill" }, pageId: "page-1" }),
    stableSerialize({ pageId: "page-1", action: { type: "fill", value: "Ada" } }),
  );
});
