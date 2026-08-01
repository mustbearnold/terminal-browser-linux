import net from "node:net";
import path from "node:path";

import { INSTANCES_DIR } from "pixel-store";
import type { Backend } from "pixel-terminals";

import { browsers, recordKey } from "./instances";
import type { Browser } from "./instances";

export interface AgentOptions {
  browserKey?: string;
}

export async function agentCommand(backend: Backend, options: AgentOptions): Promise<number> {
  const browser = await selectBrowser(backend, options.browserKey);
  const socketPath = path.join(INSTANCES_DIR, `${recordKey(browser)}.agent.sock`);
  const socket = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  await new Promise<void>((resolve, reject) => {
    socket.once("close", resolve);
    socket.once("error", reject);
  });
  return 0;
}

async function selectBrowser(backend: Backend, key: string | undefined): Promise<Browser> {
  const all = await browsers(backend);
  if (all.length === 0) throw new Error("no terminal browsers running — start one with: terminal-browser open");
  if (key) {
    const browser = all.find((candidate) => recordKey(candidate) === key);
    if (browser) return browser;
    throw new Error(`no browser ${key}\n\nrunning:\n  ${all.map((candidate) => recordKey(candidate)).join("\n  ")}`);
  }
  const here = all.filter((candidate) => candidate.inCurrentTab);
  if (here.length === 1) return here[0];
  if (here.length === 0) throw new Error("no terminal browser in this terminal tab — pass --browser <key>");
  throw new Error(`several browsers match — pass --browser <key>\n\nmatching:\n  ${here.map((candidate) => recordKey(candidate)).join("\n  ")}`);
}
