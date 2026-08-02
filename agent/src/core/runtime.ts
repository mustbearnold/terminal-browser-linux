import type { AgentCapability, PageId, PageIdentity } from "../protocol/types";
import type { PageSession } from "./page";
import type { AnnotationStore } from "./annotations";

export interface AgentRuntime {
  capabilities(): readonly AgentCapability[];
  listPages(): Promise<readonly PageIdentity[]>;
  getPage(pageId: PageId): PageSession | undefined;
  openPage(url: string): Promise<PageIdentity>;
  activatePage(pageId: PageId): Promise<PageIdentity>;
  closePage(pageId: PageId): Promise<void>;
  readonly annotations?: AnnotationStore;
  onPageClosed?(listener: (pageId: PageId) => void): () => void;
}
