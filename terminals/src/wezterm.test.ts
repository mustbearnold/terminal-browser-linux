import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { createWezterm } from "./wezterm";

test("closes a matching WezTerm pane", async () => {
  const calls: string[][] = [];
  const backend = createWezterm(
    { WEZTERM_PANE: "7" },
    async (_file, args) => {
      calls.push(args);
      if (args[1] === "list") {
        return {
          stdout: JSON.stringify([
            { window_id: 1, tab_id: 2, pane_id: 7, title: "shell" },
            { window_id: 1, tab_id: 2, pane_id: 42, title: "terminal-browser:browser-1" },
          ]),
        };
      }
      return { stdout: "" };
    },
  );

  strictEqual(await backend.closePane?.("terminal-browser:browser-1"), true);
  deepStrictEqual(calls, [
    ["cli", "list", "--format", "json"],
    ["cli", "kill-pane", "--pane-id", "42"],
  ]);
});

test("does not issue a kill command for a missing WezTerm pane", async () => {
  const calls: string[][] = [];
  const backend = createWezterm({}, async (_file, args) => {
    calls.push(args);
    return { stdout: "[]" };
  });

  strictEqual(await backend.closePane?.("terminal-browser:missing"), false);
  deepStrictEqual(calls, [["cli", "list", "--format", "json"]]);
});
