import fs from "node:fs";
import path from "node:path";

import { AgentError } from "../protocol/errors";
import type { PageAnnotation, PageId } from "../protocol/types";

export type NewPageAnnotation = Omit<PageAnnotation, "annotationId" | "tag" | "createdAt">;

export interface AnnotationStore {
  create(annotation: NewPageAnnotation): PageAnnotation;
  list(pageId: PageId): readonly PageAnnotation[];
  get(pageId: PageId, annotationId: string): PageAnnotation | undefined;
  delete(pageId: PageId, annotationId: string): boolean;
}

export class MemoryAnnotationStore implements AnnotationStore {
  private readonly annotations = new Map<string, PageAnnotation>();
  private nextSequence = 1;

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly limit = 4096,
  ) {
    validateLimit(limit);
  }

  create(annotation: NewPageAnnotation): PageAnnotation {
    if (this.annotations.size >= this.limit) {
      throw new AgentError("RESOURCE_EXHAUSTED", "annotation store is full", {
        details: { scope: "page-annotations", limit: this.limit },
      });
    }
    const sequence = this.nextSequence++;
    const result: PageAnnotation = {
      ...annotation,
      annotationId: `annotation-${sequence}`,
      tag: `@tb-${sequence}`,
      createdAt: this.now(),
    };
    this.annotations.set(result.annotationId, result);
    return result;
  }

  list(pageId: PageId): readonly PageAnnotation[] {
    return [...this.annotations.values()].filter((annotation) => annotation.pageId === pageId);
  }

  get(pageId: PageId, annotationId: string): PageAnnotation | undefined {
    const annotation = this.annotations.get(annotationId);
    return annotation?.pageId === pageId ? annotation : undefined;
  }

  delete(pageId: PageId, annotationId: string): boolean {
    const annotation = this.get(pageId, annotationId);
    return annotation === undefined ? false : this.annotations.delete(annotationId);
  }
}

interface PersistedAnnotations {
  version: 1;
  nextSequence: number;
  annotations: PageAnnotation[];
}

export class DurableAnnotationStore implements AnnotationStore {
  private readonly annotations = new Map<string, PageAnnotation>();
  private nextSequence = 1;
  private readonly now: () => string;
  private readonly limit: number;

  constructor(
    private readonly filePath: string,
    limit = 4096,
    now: () => string = () => new Date().toISOString(),
  ) {
    validateLimit(limit);
    this.limit = limit;
    this.now = now;
    this.load();
  }

  create(annotation: NewPageAnnotation): PageAnnotation {
    if (this.annotations.size >= this.limit) {
      throw new AgentError("RESOURCE_EXHAUSTED", "annotation store is full", {
        details: { scope: "page-annotations", limit: this.limit },
      });
    }
    const sequence = this.nextSequence++;
    const result: PageAnnotation = {
      ...annotation,
      annotationId: `annotation-${sequence}`,
      tag: `@tb-${sequence}`,
      createdAt: this.now(),
    };
    this.annotations.set(result.annotationId, result);
    try {
      this.persist();
    } catch (error) {
      this.annotations.delete(result.annotationId);
      throw error;
    }
    return result;
  }

  list(pageId: PageId): readonly PageAnnotation[] {
    return [...this.annotations.values()].filter((annotation) => annotation.pageId === pageId);
  }

  get(pageId: PageId, annotationId: string): PageAnnotation | undefined {
    const annotation = this.annotations.get(annotationId);
    return annotation?.pageId === pageId ? annotation : undefined;
  }

  delete(pageId: PageId, annotationId: string): boolean {
    if (!this.get(pageId, annotationId)) return false;
    this.annotations.delete(annotationId);
    try {
      this.persist();
    } catch (error) {
      const parsed = this.readEntry(annotationId);
      if (parsed) this.annotations.set(annotationId, parsed);
      throw error;
    }
    return true;
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new AgentError("INTERNAL_ERROR", `could not read annotation store: ${errorMessage(error)}`);
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.annotations)) {
      throw new AgentError("INTERNAL_ERROR", "annotation store has an unsupported format");
    }
    const nextSequence = parsed.nextSequence;
    if (!Number.isSafeInteger(nextSequence) || Number(nextSequence) < 1) {
      throw new AgentError("INTERNAL_ERROR", "annotation store has an invalid sequence");
    }
    for (const value of parsed.annotations) {
      const annotation = validateAnnotation(value);
      this.annotations.set(annotation.annotationId, annotation);
      this.nextSequence = Math.max(this.nextSequence, sequenceOf(annotation.annotationId) + 1);
    }
    this.nextSequence = Math.max(this.nextSequence, Number(nextSequence));
  }

  private persist(): void {
    const data: PersistedAnnotations = {
      version: 1,
      nextSequence: this.nextSequence,
      annotations: [...this.annotations.values()],
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }

  private readEntry(annotationId: string): PageAnnotation | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return undefined;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.annotations)) return undefined;
    const value = parsed.annotations.find((candidate) => isRecord(candidate) && candidate.annotationId === annotationId);
    return value === undefined ? undefined : validateAnnotation(value);
  }
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new AgentError("INVALID_REQUEST", "annotation store limit must be a positive safe integer");
  }
}

function validateAnnotation(value: unknown): PageAnnotation {
  if (!isRecord(value)) throw new AgentError("INTERNAL_ERROR", "annotation store contains an invalid annotation");
  for (const field of ["annotationId", "tag", "pageId", "documentId", "url", "title", "note", "createdAt"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new AgentError("INTERNAL_ERROR", `annotation store contains an invalid ${field}`);
    }
  }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    throw new AgentError("INTERNAL_ERROR", "annotation store contains an invalid revision");
  }
  if (!isRecord(value.target) || !isRecord(value.node)) {
    throw new AgentError("INTERNAL_ERROR", "annotation store contains an invalid target or node");
  }
  return value as unknown as PageAnnotation;
}

function sequenceOf(annotationId: string): number {
  const match = /^annotation-(\d+)$/.exec(annotationId);
  return match ? Number(match[1]) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
