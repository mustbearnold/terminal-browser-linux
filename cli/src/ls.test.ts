import { strictEqual } from "node:assert";
import test from "node:test";

import { browserReady } from "./ls";
import type { Browser, TabTarget } from "./instances";

const browser = { cdpPort: 43123 } as Browser;

function tab(targetId: string | null): TabTarget {
  return { id: 1, url: "https://example.com", title: "Example", active: true, targetId };
}

test("reports a browser ready when its debugging port and a tab target exist", () => {
  strictEqual(browserReady(browser, [tab("target-1")]), true);
});

test("reports a browser starting while its target is pending", () => {
  strictEqual(browserReady(browser, [tab(null)]), false);
  strictEqual(browserReady({ cdpPort: null } as Browser, [tab("target-1")]), false);
});
