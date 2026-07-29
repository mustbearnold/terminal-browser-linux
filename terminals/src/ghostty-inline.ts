import { Backend } from "./shared";

// Ghostty's GTK build has no scripting bridge, so outside macOS the browser
// can only take over the current pane; splits cannot be created or controlled.
function unavailable(): never {
  throw new Error(
    "Ghostty outside macOS can't be scripted for splits, so directions are unavailable — run terminal-browser without a direction, or use kitty, WezTerm, or tmux",
  );
}

export const ghosttyInline: Backend = {
  app: "ghostty",
  async panes() {
    return [];
  },
  async listAll() {
    return [];
  },
  async split() {
    unavailable();
  },
  async focusPane() {
    unavailable();
  },
  async focusSelf() {
    unavailable();
  },
  async sendText() {
    unavailable();
  },
};
