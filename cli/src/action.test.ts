import { strictEqual, rejects } from "node:assert";
import test from "node:test";

import { closeAgentSession, waitForReadyTab } from "./action";
import type { Browser, TabTarget } from "./instances";

const browser = { key: "browser-1" } as Browser;

function tab(targetId: string | null): TabTarget {
  return { id: 1, url: "https://example.com", title: "Example", active: true, targetId };
}

test("waits for the selected tab to expose its CDP target", async () => {
  let attempts = 0;
  const ready = await waitForReadyTab(browser, 1, 200, 1, async () => {
    attempts += 1;
    return [tab(attempts === 1 ? null : "target-1")];
  });

  strictEqual(ready.targetId, "target-1");
  strictEqual(attempts, 2);
});

test("fails closed when the selected tab disappears", async () => {
  await rejects(
    waitForReadyTab(browser, 1, 200, 1, async () => [
      { ...tab("target-1"), id: 2, url: "https://other.example" },
    ]),
    /no tab 1 in browser browser-1/,
  );
});

test("does not start an agent helper when the browser has no session", () => {
  strictEqual(closeAgentSession(`missing-${process.pid}`), false);
});
