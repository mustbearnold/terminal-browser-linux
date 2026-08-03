import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { createWezterm } from "./wezterm";

test("passes split size to WezTerm", async () => {
  const calls: string[][] = [];
  const backend = createWezterm({}, async (_file, args) => {
    calls.push(args);
    return { stdout: "42\n" };
  });

  await backend.split("left", ["bash", "-lc", "printf ready"], 0.4);
  deepStrictEqual(calls, [[
    "cli", "split-pane", "--left", "--percent", "40", "--", "bash", "-lc", "printf ready",
  ]]);
});

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

test("toggles zoom on a matching WezTerm pane", async () => {
  const calls: string[][] = [];
  const backend = createWezterm({}, async (_file, args) => {
    calls.push(args);
    if (args[1] === "list") {
      return { stdout: JSON.stringify([{ window_id: 1, tab_id: 2, pane_id: 42, title: "agent" }]) };
    }
    return { stdout: "" };
  });

  strictEqual(await backend.zoomPane?.("agent"), true);
  deepStrictEqual(calls, [
    ["cli", "list", "--format", "json"],
    ["cli", "zoom-pane", "--pane-id", "42", "--toggle"],
  ]);
});
