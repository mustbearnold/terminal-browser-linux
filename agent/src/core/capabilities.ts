import type { AgentAction, AgentCapability } from "../protocol/types";

export type AgentActionCapability = Extract<AgentCapability, `page.act.${string}`>;

export function actionCapability(action: AgentAction): AgentActionCapability {
  switch (action.type) {
    case "click":
      return "page.act.click";
    case "fill":
      return "page.act.fill";
    case "type":
      return "page.act.type";
    case "press":
      return "page.act.press";
    case "select":
      return "page.act.select";
    case "check":
      return "page.act.check";
    case "hover":
      return "page.act.hover";
    case "scroll":
      return "page.act.scroll";
    case "navigate":
      return "page.act.navigate";
  }
}
