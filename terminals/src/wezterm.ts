import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Backend } from "./shared";

const run = promisify(execFile);

type WeztermRun = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; maxBuffer: number; timeout: number },
) => Promise<{ stdout: string }>;

interface WeztermPane {
  window_id: number;
  tab_id: number;
  pane_id: number;
  title: string;
  cwd?: string;
  cwd_url?: string;
}

export function createWezterm(env: NodeJS.ProcessEnv = process.env, execute: WeztermRun = run): Backend {
  function wezterm(args: string[]) {
    return execute("wezterm", args, { env, maxBuffer: 4 * 1024 * 1024, timeout: 8000 });
  }

  const backend: Backend = {
    app: "wezterm",
    async panes() {
      const selfId = Number(env.WEZTERM_PANE ?? -1);
      const { stdout } = await wezterm(["cli", "list", "--format", "json"]);
      const list = JSON.parse(stdout) as WeztermPane[];
      return list.map((pane) => ({
        window: String(pane.window_id),
        tab: String(pane.tab_id),
        pane: String(pane.pane_id),
        title: pane.title,
        cwd: pane.cwd ?? pane.cwd_url,
        self: pane.pane_id === selfId,
      }));
    },
    async split(direction, command) {
      const flag = { right: "--right", left: "--left", down: "--bottom", up: "--top" }[direction];
      await wezterm(["cli", "split-pane", flag, "--", ...command]);
    },
    async listAll() {
      return backend.panes();
    },
    async sendText(paneId, text) {
      await wezterm(["cli", "send-text", "--pane-id", paneId, "--no-paste", text]);
      await wezterm(["cli", "activate-pane", "--pane-id", paneId]);
      return true;
    },
    async focusPane(titleNeedle) {
      const target = (await backend.panes()).find((pane) => pane.title.includes(titleNeedle));
      if (!target) return false;
      await wezterm(["cli", "activate-pane", "--pane-id", target.pane]);
      return true;
    },
    async focusSelf() {
      const selfId = env.WEZTERM_PANE;
      if (!selfId) return false;
      await wezterm(["cli", "activate-pane", "--pane-id", selfId]);
      return true;
    },
    async closePane(titleNeedle) {
      const target = (await backend.panes()).find((pane) => pane.title.includes(titleNeedle));
      if (!target) return false;
      await wezterm(["cli", "kill-pane", "--pane-id", target.pane]);
      return true;
    },
  };
  return backend;
}
