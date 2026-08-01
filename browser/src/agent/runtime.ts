import {
  AgentError,
  RevisionedPageSession,
  RevisionLedger,
  asPageId,
} from "terminal-browser-agent";
import type {
  AgentCapability,
  AgentRuntime,
  AgentJournal,
  PageBackend,
  PageIdentity,
  PageSession,
  PageId,
} from "terminal-browser-agent";
import type { Tab, TabManager } from "../session/tabs";
import { ElectronPageBackend } from "./page-backend";

interface Entry {
  tab: Tab;
  backend: PageBackend;
  session: PageSession;
}

export class BrowserAgentRuntime implements AgentRuntime {
  private readonly entries = new Map<PageId, Entry>();

  constructor(
    private readonly key: string,
    private readonly tabs: TabManager,
    private readonly openTab: (url: string) => Tab,
    private readonly journal?: AgentJournal,
  ) {}

  capabilities(): readonly AgentCapability[] {
    return [
      "pages.list",
      "pages.open",
      "pages.activate",
      "pages.close",
      "snapshot.read",
      "snapshot.delta",
      "page.frames",
      "page.read",
      "page.capture",
      "page.act",
      "page.act.click",
      "page.act.fill",
      "page.act.type",
      "page.act.press",
      "page.act.select",
      "page.act.check",
      "page.act.hover",
      "page.act.scroll",
      "page.act.navigate",
      "page.act.reload",
      "page.act.history",
      "page.wait",
      "page.observe",
    ];
  }

  async listPages(): Promise<readonly PageIdentity[]> {
    return Promise.all(this.tabs.all().map((tab) => this.entry(tab).backend.identity()));
  }

  getPage(pageId: PageId): PageSession | undefined {
    const tab = this.tabFor(pageId);
    return tab ? this.entry(tab).session : undefined;
  }

  async openPage(url: string): Promise<PageIdentity> {
    const tab = this.openTab(url);
    return this.entry(tab).backend.identity();
  }

  async activatePage(pageId: PageId): Promise<PageIdentity> {
    const tab = this.tabFor(pageId);
    if (!tab) throw new AgentError("PAGE_NOT_FOUND", `unknown page: ${pageId}`);
    this.tabs.activate(tab.id);
    return this.entry(tab).backend.identity();
  }

  async closePage(pageId: PageId): Promise<void> {
    const tab = this.tabFor(pageId);
    if (!tab) throw new AgentError("PAGE_NOT_FOUND", `unknown page: ${pageId}`);
    this.tabs.close(tab.id);
    this.entries.delete(pageId);
  }

  private entry(tab: Tab): Entry {
    const pageId = this.pageId(tab.id);
    const existing = this.entries.get(pageId);
    if (existing && existing.tab.controller === tab.controller) return existing;
    const backend = new ElectronPageBackend(
      pageId,
      tab.controller,
      () => tab.state,
      () => this.tabs.active?.id === tab.id,
      this.journal?.eventHistory(pageId),
    );
    const session = new RevisionedPageSession(backend, new RevisionLedger());
    const entry = { tab, backend, session };
    this.entries.set(pageId, entry);
    return entry;
  }

  private tabFor(pageId: PageId): Tab | null {
    const prefix = `${this.key}/tab/`;
    if (!String(pageId).startsWith(prefix)) return null;
    const id = Number(String(pageId).slice(prefix.length));
    return Number.isInteger(id) ? this.tabs.get(id) : null;
  }

  private pageId(id: number): PageId {
    return asPageId(`${this.key}/tab/${id}`);
  }
}
