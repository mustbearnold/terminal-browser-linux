import { ghostty } from "./ghostty";
import { ghosttyInline } from "./ghostty-inline";
import { createKitty } from "./kitty";
import { createTmux } from "./tmux";
import { createWezterm } from "./wezterm";
import { Backend } from "./shared";

export type { Backend, Direction, Pane } from "./shared";
export { callerTty, setPaneTitle } from "./shared";
export { prepareTmux } from "./tmux";
export type { GraphicsSupport } from "./graphics";
export type { PixelUnit } from "./pixels";
export { reportedPixelUnit } from "./pixels";
export {
  checkKittyGraphics,
  graphicsFromEnv,
  probeKittyGraphics,
  unsupportedGraphicsMessage,
  SKIP_ENV as GRAPHICS_SKIP_ENV,
} from "./graphics";

export function detectBackend(env: NodeJS.ProcessEnv = process.env): Backend {
  const term = env.TERM ?? "";
  const ghosttyBackend = process.platform === "darwin" ? ghostty : ghosttyInline;
  if (env.TMUX) return createTmux(env);
  if (term.includes("ghostty")) return ghosttyBackend;
  if (term.includes("kitty")) return createKitty(env);
  if (env.TERM_PROGRAM === "ghostty" || env.GHOSTTY_RESOURCES_DIR) {
    return ghosttyBackend;
  }
  if (env.KITTY_WINDOW_ID || env.KITTY_PID) return createKitty(env);
  if (env.TERM_PROGRAM === "WezTerm" || env.WEZTERM_PANE) return createWezterm(env);
  throw new Error(
    "terminal-browser cannot control this terminal. We recommend Ghostty (https://ghostty.org/download). kitty, WezTerm, and tmux also work.",
  );
}
