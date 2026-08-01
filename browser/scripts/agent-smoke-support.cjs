"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const electron = path.join(root, "browser/node_modules/.bin/electron");
const browserMain = path.join(root, "browser/dist/main.js");
const runtimeHome = process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".local/state");
const instancesDir = path.join(runtimeHome, "terminal-browser", "instances");

function launchHost() {
  const electronSwitch = ` --ozone-platform=x11${process.env.TERMINAL_BROWSER_SMOKE_NO_SANDBOX === "1" ? " --no-sandbox" : ""}`;
  const host = spawn(
    "script",
    ["-qefc", `${shellQuote(electron)}${electronSwitch} ${shellQuote(browserMain)} --no-toolbar`, "/dev/null"],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_OZONE_PLATFORM_HINT: "x11" },
    },
  );
  const output = [];
  const capture = (chunk) => {
    output.push(chunk.toString());
    if (output.length > 40) output.shift();
  };
  host.stdout?.on("data", capture);
  host.stderr?.on("data", capture);
  return { host, output };
}

function listSockets() {
  try {
    return fs
      .readdirSync(instancesDir)
      .filter((name) => name.endsWith(".agent.sock"))
      .map((name) => path.join(instancesDir, name));
  } catch {
    return [];
  }
}

async function waitForSocket(existing, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socket = listSockets().find((candidate) => !existing.has(candidate));
    if (socket) return socket;
    await delay(100);
  }
  const details = output?.join("").trim();
  const message = `agent socket did not appear in ${instancesDir}`;
  throw new Error(details ? `${message}\nElectron host output:\n${details}` : message);
}

function stopHost(host) {
  if (!host.pid) return;
  try {
    process.kill(-host.pid, "SIGTERM");
  } catch {}
  try {
    host.kill("SIGTERM");
  } catch {}
}

function dataUrl(value) {
  return `data:text/html;base64,${Buffer.from(value).toString("base64")}`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  dataUrl,
  launchHost,
  listSockets,
  stopHost,
  waitForSocket,
};
