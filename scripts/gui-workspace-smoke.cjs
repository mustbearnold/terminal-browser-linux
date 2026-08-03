"use strict";

const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { AgentClient } = require(path.resolve(__dirname, "..", "agent", "dist", "index.js"));

const run = promisify(execFile);
const root = path.resolve(__dirname, "..");
const directory = fs.mkdtempSync(path.join("/tmp", "terminal-browser-gui-smoke-"));
const runtimeDirectory = path.join(directory, "runtime");
const dataDirectory = path.join(directory, "data");
const stateDirectory = path.join(directory, "state");
const appDataDirectory = path.join(directory, "appdata");
const kittySocket = path.join(directory, "kitty.sock");
const environment = {
  ...process.env,
  TERM: "xterm-kitty",
  KITTY_DISABLE_WAYLAND: "1",
  TERMINAL_BROWSER_SKIP_GRAPHICS_CHECK: "1",
  XDG_SESSION_TYPE: "x11",
  XDG_RUNTIME_DIR: runtimeDirectory,
  XDG_DATA_HOME: dataDirectory,
  XDG_STATE_HOME: stateDirectory,
  TERMINAL_BROWSER_APPDATA: appDataDirectory,
  KITTY_LISTEN_ON: `unix:${kittySocket}`,
};

for (const directoryPath of [runtimeDirectory, dataDirectory, stateDirectory, appDataDirectory]) {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
}

let display;
let xvfb;
let kitty;
let browserPaneId;

function fail(message) {
  throw new Error(message);
}

function spawnDetached(command, args, env = environment) {
  return spawn(command, args, {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForOutput(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${child.spawnargs?.[0] ?? "process"}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += String(chunk);
      const line = output.match(/(^|\n)([^\n]+)(?:\n|$)/);
      if (!line) return;
      cleanup();
      resolve(line[2].trim());
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`process exited before reporting readiness (${code ?? signal ?? "unknown"})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.on("exit", onExit);
  });
}

async function kittyCommand(args) {
  const result = await run("kitten", ["@", "--to", `unix:${kittySocket}`, ...args], {
    env: environment,
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8000,
  });
  return result.stdout;
}

async function kittyWindows() {
  return JSON.parse(await kittyCommand(["ls"]));
}

function allKittyWindows(windows) {
  return windows.flatMap((osWindow) => osWindow.tabs.flatMap((tab) => tab.windows));
}

async function waitFor(description, read, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

async function listedBrowsers() {
  const result = await run("terminal-browser", ["ls", "--all", "--json"], {
    env: { ...environment, DISPLAY: display },
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8000,
  });
  return JSON.parse(result.stdout).browsers;
}

async function workspaceBindings() {
  const result = await run("terminal-browser", ["workspace", "list"], {
    env: { ...environment, DISPLAY: display },
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8000,
  });
  return JSON.parse(result.stdout);
}

async function reloadThroughAgent(browserKey) {
  const socket = path.join(environment.XDG_RUNTIME_DIR, "terminal-browser", "instances", `${browserKey}.agent.sock`);
  const client = await AgentClient.connect(socket, { clientId: "gui-workspace-smoke" });
  try {
    const pages = await client.call("pages.list", {});
    const page = pages.pages.find((candidate) => candidate.active) ?? pages.pages[0];
    if (!page) fail("agent did not expose a page to reload");
    await client.call("page.act", { pageId: page.pageId, action: { type: "reload" } });
  } finally {
    await client.close();
  }
}

async function paneText(paneId) {
  return kittyCommand(["get-text", "--match", `id:${paneId}`, "--extent", "screen"]);
}

async function assertPaneText(paneId, expected, description, timeoutMs = 20000) {
  const text = await waitFor(description, () => paneText(paneId), (value) => value.includes(expected), timeoutMs);
  process.stdout.write(`${description}: ok\n`);
  return text;
}

async function startDisplay() {
  xvfb = spawn("Xvfb", ["-screen", "0", "1600x900x24", "-ac", "-nolisten", "tcp", "-displayfd", "1"], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  display = `:${await waitForOutput(xvfb)}`;
  environment.DISPLAY = display;
}

async function startKitty() {
  kitty = spawnDetached("kitty", [
    "--config", "NONE",
    "--override", "allow_remote_control=yes",
    "--override", "enable_audio_bell=no",
    "--start-as", "maximized",
    "--listen-on", `unix:${kittySocket}`,
    "--title", "terminal-browser-gui-driver",
    "--",
    "bash",
    "-lc",
    "printf 'DRIVER_START\\n'; sleep 2; terminal-browser workspace open https://example.com right --left --agent claude; printf 'DRIVER_STATUS=%s\\n' \"$?\"; sleep 30",
  ]);
  await waitFor("Kitty control socket", kittyWindows, (windows) => allKittyWindows(windows).length >= 1);
  const initialWindows = allKittyWindows(await kittyWindows());
  const driver = initialWindows.find((window) => window.is_focused) ?? initialWindows[0];
  if (!driver) fail("Kitty did not expose its driver pane");
  await kittyCommand(["launch", "--location=vsplit", "--title=claude", "--", "bash", "--noprofile", "--norc"]);
  const panes = await waitFor("agent pane", kittyWindows, (windows) => {
    const candidates = allKittyWindows(windows).filter((window) => window.id !== driver.id);
    return candidates.length === 1 ? candidates : false;
  });
  return;
}

async function openWorkspace() {
  const browsers = await waitFor("workspace browser", listedBrowsers, (value) => value.length === 1 ? value : false);
  const browser = browsers[0];
  if (!browser?.key || !browser.pane?.pane) fail("workspace browser did not expose a pane binding");
  browserPaneId = Number(browser.pane.pane);
  if (!Number.isSafeInteger(browserPaneId)) fail("workspace browser pane id is invalid");
  const bindings = await waitFor(
    "workspace binding",
    workspaceBindings,
    (value) => value.length === 1 && value[0].agentPane ? value : false,
  );
  const agentPaneId = Number(bindings[0].agentPane);
  if (!Number.isSafeInteger(agentPaneId)) fail("workspace binding agent pane id is invalid");
  return { browser, agentPaneId };
}

async function clickDomNote(browserPane) {
  await kittyCommand(["focus-window", "--match", `id:${browserPane}`]);
  await run("xdotool", ["mousemove", "--sync", "1200", "250", "click", "3"], { env: environment, timeout: 8000 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await run("xdotool", ["mousemove", "--sync", "1200", "334", "click", "1"], { env: environment, timeout: 8000 });
}

async function runSmoke() {
  await startDisplay();
  await startKitty();
  const { browser, agentPaneId } = await openWorkspace();
  await clickDomNote(browserPaneId);
  await run("xdotool", ["type", "--delay", "2", "GUI smoke handoff"], { env: environment, timeout: 8000 });
  await run("xdotool", ["key", "--clearmodifiers", "Return"], { env: environment, timeout: 8000 });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const agentText = await assertPaneText(agentPaneId, "@tb-1", "annotation tag reached agent pane", 30000);
  if (!agentText.includes("schema=1") || !agentText.includes("observation={")) fail("agent pane received an unversioned annotation payload");
  if (!agentText.includes("note=GUI smoke handoff")) fail("agent pane received the tag without the note payload");
  const notesResult = await run("terminal-browser", ["workspace", "notes", "--browser", browser.key], {
    env: { ...environment, DISPLAY: display },
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8000,
  });
  const notes = JSON.parse(notesResult.stdout);
  if (notes.annotations?.length !== 1 || notes.annotations[0].annotationId !== "annotation-1") {
    fail("workspace notes did not expose the stored DOM annotation");
  }
  const replayResult = await run("terminal-browser", [
    "workspace", "note", "--browser", browser.key, "--annotation", notes.annotations[0].annotationId,
  ], {
    env: { ...environment, DISPLAY: display },
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8000,
  });
  if (!JSON.parse(replayResult.stdout).replayed) fail("workspace note replay did not report replayed");
  await assertPaneText(agentPaneId, "status=fresh", "stored annotation replay reached agent pane", 30000);
  await reloadThroughAgent(browser.key);
  const staleNotes = await waitFor("stale annotation", async () => {
    const result = await run("terminal-browser", ["workspace", "notes", "--browser", browser.key], {
      env: { ...environment, DISPLAY: display },
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 8000,
    });
    return JSON.parse(result.stdout);
  }, (value) => value.annotations?.[0]?.stale === true ? value : false, 30000);
  let staleReplayRejected = false;
  try {
    await run("terminal-browser", [
      "workspace", "note", "--browser", browser.key, "--annotation", staleNotes.annotations[0].annotationId,
    ], {
      env: { ...environment, DISPLAY: display },
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 8000,
    });
  } catch (error) {
    staleReplayRejected = String(error.stderr ?? error).includes("pass --force");
  }
  if (!staleReplayRejected) fail("workspace note replay accepted a stale annotation without --force");
  const forcedReplay = await run("terminal-browser", [
    "workspace", "note", "--browser", browser.key, "--annotation", staleNotes.annotations[0].annotationId, "--force",
  ], {
    env: { ...environment, DISPLAY: display },
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8000,
  });
  const forcedPayload = JSON.parse(forcedReplay.stdout);
  if (!forcedPayload.replayed || !forcedPayload.promptTag.includes("status=stale")) {
    fail("forced workspace note replay did not preserve stale status");
  }
  await assertPaneText(agentPaneId, "status=stale", "forced stale annotation replay reached agent pane", 30000);
  const closeResult = await run("terminal-browser", ["workspace", "close", "--browser", browser.key], {
    env: { ...environment, DISPLAY: display },
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8000,
  });
  if (!JSON.parse(closeResult.stdout).closed) fail("workspace close did not report a closed browser");
  await waitFor("browser pane close", kittyWindows, (windows) => {
    return allKittyWindows(windows).some((window) => window.id === browserPaneId) ? false : windows;
  });
  const remainingBindings = await workspaceBindings();
  if (remainingBindings.length !== 0) fail("workspace close left a persisted binding");
  process.stdout.write("workspace close cleanup: ok\n");
  process.stdout.write(`browser=${browser.key}\n`);
  process.stdout.write("packaged GUI workspace handoff: passed\n");
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (browserPaneId !== undefined) {
    await kittyCommand(["close-window", "--match", `id:${browserPaneId}`]).catch(() => {});
  }
  if (kitty?.pid) {
    try {
      process.kill(-kitty.pid, "SIGTERM");
    } catch {}
  }
  if (xvfb?.pid) xvfb.kill("SIGTERM");
  fs.rmSync(directory, { recursive: true, force: true });
}

let cleaned = false;
const finishOnSignal = () => {
  void cleanup().finally(() => process.exit(1));
};
process.once("SIGINT", finishOnSignal);
process.once("SIGTERM", finishOnSignal);

runSmoke()
  .then(() => cleanup())
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    try {
      const windows = allKittyWindows(await kittyWindows());
      for (const window of windows) {
        process.stderr.write(`--- pane ${window.id} ---\n${await paneText(window.id)}`);
      }
      const logRoot = path.join(stateDirectory, "terminal-browser");
      if (fs.existsSync(logRoot)) {
        for (const file of fs.readdirSync(logRoot, { recursive: true })) {
          const filePath = path.join(logRoot, String(file));
          if (fs.statSync(filePath).isFile()) process.stderr.write(`--- ${filePath} ---\n${fs.readFileSync(filePath, "utf8")}`);
        }
      }
    } catch (diagnosticError) {
      process.stderr.write(`diagnostics unavailable: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}\n`);
    }
    await cleanup();
    process.exitCode = 1;
  });
