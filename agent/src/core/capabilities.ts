import type { AgentAction, AgentCapability, AgentRequest } from "../protocol/types";

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
    case "history":
      return "page.act.history";
    case "reload":
      return "page.act.reload";
  }
}

export function operationCapability(request: AgentRequest): AgentCapability | undefined {
  switch (request.op) {
    case "pages.list":
      return "pages.list";
    case "pages.open":
      return "pages.open";
    case "pages.activate":
      return "pages.activate";
    case "pages.close":
      return "pages.close";
    case "page.frames":
      return "page.frames";
    case "page.query":
      return "page.query";
    case "page.snapshot":
      return "snapshot.read";
    case "page.snapshot.window":
      return "snapshot.window";
    case "page.snapshot.delta":
      return "snapshot.delta";
    case "page.capture":
      return "page.capture";
    case "page.read":
      return "page.read";
    case "page.act":
      return "page.act";
    case "page.act.batch":
      return "page.act.batch";
    case "page.act.status":
      return "page.act.status";
    case "page.wait":
      return "page.wait";
    case "page.observe":
      return "page.observe";
    case "page.dialog":
      return "page.dialog";
    case "hello":
    case "request.cancel":
      return undefined;
  }
}
