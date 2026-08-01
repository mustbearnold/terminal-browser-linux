import type { AgentCapability, PageId, PageIdentity } from "../protocol/types";
import type { PageSession } from "./page";

export interface AgentRuntime {
  capabilities(): readonly AgentCapability[];
  listPages(): Promise<readonly PageIdentity[]>;
  getPage(pageId: PageId): PageSession | undefined;
  openPage(url: string): Promise<PageIdentity>;
  closePage(pageId: PageId): Promise<void>;
}
