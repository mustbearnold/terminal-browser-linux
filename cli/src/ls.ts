import type { Backend } from "pixel-terminals";

import { browsers, recordKey, targets } from "./instances";
import type { Browser, TabTarget } from "./instances";

interface Listed {
  key: string;
  pid: number;
  cdpPort: number | null;
  socket: string;
  tty: string | null;
  pane: { window: string | null; tab: string | null; pane: string | null };
  splitDir: Browser["splitDir"];
  parentTty: string | null;
  inCurrentTab: boolean;
  loading: boolean;
  ready: boolean;
  viewport: { width: number; height: number } | null;
  tabs: TabTarget[];
}

export function browserReady(browser: Pick<Browser, "cdpPort">, tabs: TabTarget[]): boolean {
  return browser.cdpPort !== null && tabs.some((tab) => tab.targetId !== null);
}

async function collect(list: Browser[]): Promise<Listed[]> {
  return Promise.all(
    list.map(async (browser) => {
      const tabs = await targets(browser).catch(() => []);
      return {
        key: recordKey(browser),
        pid: browser.pid,
        cdpPort: browser.cdpPort,
        socket: browser.socket,
        tty: browser.tty,
        pane: { window: browser.window, tab: browser.tab, pane: browser.pane },
        splitDir: browser.splitDir,
        parentTty: browser.parentTty,
        inCurrentTab: browser.inCurrentTab,
        loading: browser.loading,
        ready: browserReady(browser, tabs),
        viewport: browser.viewport,
        tabs,
      };
    }),
  );
}

function render(list: Listed[]): string {
  if (list.length === 0) return "no terminal browsers running\n";
  const lines: string[] = [];
  for (const browser of list) {
    const where = browser.pane.window
      ? `${browser.pane.window}:${browser.pane.tab}:${browser.pane.pane}`
      : "no pane";
    const state = browser.ready ? (browser.loading ? "loading" : "ready") : "starting";
    lines.push(`${browser.key}  ${where}${browser.inCurrentTab ? "  (this tab)" : ""}  [${state}]`);
    for (const tab of browser.tabs) {
      const mark = tab.active ? "*" : " ";
      lines.push(`  ${mark} ${tab.id}  ${tab.title || tab.url}`);
      lines.push(`      ${tab.url}`);
      lines.push(`      target ${tab.targetId ?? "pending"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function lsCommand(backend: Backend, all: boolean, json: boolean) {
  const found = await browsers(backend);
  const scoped = all ? found : found.filter((browser) => browser.inCurrentTab);
  const list = await collect(scoped);
  if (!json) {
    process.stdout.write(render(list));
    if (!all && found.length > list.length) {
      process.stdout.write(`\n${found.length - list.length} more elsewhere — terminal-browser ls --all\n`);
    }
    return;
  }
  const panes = await backend.panes();
  const self = panes.find((pane) => pane.self);
  process.stdout.write(
    `${JSON.stringify(
      {
        self: self ? { window: self.window, tab: self.tab, pane: self.pane } : null,
        browsers: list,
      },
      null,
      2,
    )}\n`,
  );
}
