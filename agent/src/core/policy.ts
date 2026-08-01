import type { AgentAction, AgentCapability, PageId } from "../protocol/types";

export interface PolicyContext {
  clientId: string;
  pageId?: PageId;
  capability?: AgentCapability;
  action?: AgentAction;
  origin?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  requiresConfirmation?: boolean;
}

export interface PolicyEngine {
  decide(context: PolicyContext): Promise<PolicyDecision> | PolicyDecision;
}

export class DefaultPolicy implements PolicyEngine {
  decide(context: PolicyContext): PolicyDecision {
    if (context.capability === "unsafe.eval") {
      return { allowed: false, reason: "unsafe evaluation is disabled by default" };
    }
    return { allowed: true };
  }
}
