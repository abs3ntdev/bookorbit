import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';

import { LibraryScopeService } from '../../common/library-scope/library-scope.service';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../common/types/request-user';
import type { CrosspointClippingRow } from '../../db/schema';
import { KoreaderRepository } from '../koreader/koreader.repository';
import { KoreaderService } from '../koreader/koreader.service';
import {
  cfiFromRangePoints,
  chapterIndexFromSpineStep,
  isTextNode,
  joinCfiIndirection,
  parseCfi,
  resolveCfiParts,
  spineCfiForChapterIndex,
} from '../position-converter/cfi.utils';
import { EpubDomService } from '../position-converter/epub-dom.service';
import { CrosspointClippingRepository, type ClippingContent, type CrosspointTx } from './crosspoint-clipping.repository';
import { VisibleTextMap } from './crosspoint-visible-text';
import { CLIPPING_TEXT_MAX_BYTES, type CrosspointClippingItemDto, type CrosspointSaveProgressDto } from './dto/crosspoint.dto';

const DEVICE_NAME = 'CrossPoint';
const SYNC_VERSION = 2;
const DEFAULT_PAGE_SIZE = 50;
const MIRROR_BATCH = 50;
const CHAPTER_TITLE_MAX = 64;
const XPATH_MAX = 120;
const CLIPPINGS_EVENT = 'crosspoint.clippings_sync';

export interface ClippingPage {
  document: string;
  sync_version: number;
  cursor: number;
  until: number;
  more: boolean;
  items: Record<string, unknown>[];
}

interface ResolvedFile {
  id: number;
  bookId: number;
  format: string | null;
}

/** The firmware derives ids as the first 16 hex chars of sha256(created_at + text). */
export function clippingIdFor(createdAt: number, text: string): string {
  return createHash('sha256').update(`${createdAt}${text}`).digest('hex').slice(0, 16);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toWire(row: CrosspointClippingRow): Record<string, unknown> {
  if (row.deleted) return { id: row.clippingId, revision: row.revision, deleted: 1 };
  return {
    id: row.clippingId,
    revision: row.revision,
    deleted: 0,
    spine: row.spineIndex,
    start_page: row.startPage,
    end_page: row.endPage,
    pages: row.pageCount,
    start_word: row.startWord,
    end_word: row.endWord,
    words: row.wordCount,
    ...(row.paragraphIndex != null ? { para: row.paragraphIndex } : {}),
    chapter: row.chapterTitle,
    text: row.text,
    created_at: row.deviceCreatedAt,
    layout_signature: row.layoutSignature,
    ...(row.startOffset != null && row.endOffset != null ? { start_offset: row.startOffset, end_offset: row.endOffset } : {}),
  };
}

@Injectable()
export class CrosspointService {
  private readonly logger = new Logger(CrosspointService.name);

  constructor(
    private readonly koreaderService: KoreaderService,
    private readonly koreaderRepo: KoreaderRepository,
    private readonly libraryScope: LibraryScopeService,
    private readonly repo: CrosspointClippingRepository,
    private readonly epubDom: EpubDomService,
  ) {}

  saveProgress(user: RequestUser, dto: CrosspointSaveProgressDto) {
    const xpath = dto.position?.xpath;
    const progress = dto.progress || (typeof xpath === 'string' && xpath.length <= XPATH_MAX ? xpath : undefined);
    return this.koreaderService.saveProgress(user, {
      document: dto.document,
      percentage: dto.percentage,
      progress,
      device: dto.device || DEVICE_NAME,
      device_id: dto.device_id,
      timestamp: dto.timestamp,
    });
  }

  async getProgress(userId: number, document: string) {
    return (await this.koreaderService.getProgress(userId, document)) ?? {};
  }

  async getClippings(userId: number, document: string, cursor: number, limit = DEFAULT_PAGE_SIZE): Promise<ClippingPage> {
    const file = await this.resolveFile(userId, document);
    const empty = { document, sync_version: SYNC_VERSION, cursor, until: nowSeconds(), more: false, items: [] };
    if (!file) return empty;

    if (cursor === 0) await this.mirrorAnnotations(userId, file);

    const rows = await this.repo.findPage(userId, file.id, cursor, limit + 1);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    return {
      ...empty,
      cursor: page.length ? page[page.length - 1].revision : cursor,
      more,
      items: page.map(toWire),
    };
  }

  async putClippings(userId: number, document: string, items: CrosspointClippingItemDto[]): Promise<{ until: number; accepted: number }> {
    const startedAt = Date.now();
    const file = await this.resolveFile(userId, document);
    if (!file) throw new NotFoundException('Book not found for the given document hash');
    for (const item of items) {
      if (item.deleted === 1) continue;
      if (Buffer.byteLength(item.text ?? '') > CLIPPING_TEXT_MAX_BYTES) throw new BadRequestException('Clipping text too long');
      if (item.start_offset != null && item.end_offset != null && item.end_offset <= item.start_offset) {
        throw new BadRequestException('Clipping offsets out of order');
      }
    }

    try {
      await this.repo.transaction(async (tx) => {
        for (const item of items) {
          if (item.deleted === 1) await this.applyDeletion(userId, file, item.id, tx);
          else await this.applyLive(userId, file, item, tx);
        }
      });
    } catch (error) {
      this.logger.warn(
        `[${CLIPPINGS_EVENT}] [fail] userId=${userId} bookFileId=${file.id} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.constructor.name : 'UnknownError'} error="${sanitizeLogValue(error instanceof Error ? error.message : 'unknown error')}" - clipping upload failed`,
      );
      throw error;
    }
    return { until: nowSeconds(), accepted: items.length };
  }

  private async resolveFile(userId: number, document: string): Promise<ResolvedFile | null> {
    const libraryIds = await this.libraryScope.visibleIdsOrAllForUserId(userId);
    return this.koreaderRepo.resolveBookFileByHash(document, libraryIds, userId);
  }

  private async applyDeletion(userId: number, file: ResolvedFile, clippingId: string, tx: CrosspointTx): Promise<void> {
    const existing = await this.repo.findByClippingId(userId, file.id, clippingId, tx);
    if (existing?.annotationId) await this.repo.softDeleteAnnotation(existing.annotationId, userId, tx);
    await this.repo.insertTombstone(userId, file.id, file.bookId, clippingId, tx);
  }

  private async applyLive(userId: number, file: ResolvedFile, item: CrosspointClippingItemDto, tx: CrosspointTx): Promise<void> {
    const existing = await this.repo.findByClippingId(userId, file.id, item.id, tx);
    // A deleted id stays deleted; the device saves the quote again under a new id.
    if (existing?.deleted) return;

    const text = item.text!;
    const content: ClippingContent = {
      spineIndex: item.spine!,
      startPage: item.start_page ?? 0,
      endPage: item.end_page ?? 0,
      pageCount: item.pages ?? 1,
      startWord: item.start_word ?? 0,
      endWord: item.end_word ?? 0,
      wordCount: item.words ?? 0,
      paragraphIndex: item.para ?? null,
      chapterTitle: (item.chapter ?? '').slice(0, CHAPTER_TITLE_MAX),
      text,
      deviceCreatedAt: item.created_at || existing?.deviceCreatedAt || nowSeconds(),
      layoutSignature: item.layout_signature ?? 0,
      startOffset: item.start_offset ?? null,
      endOffset: item.end_offset ?? null,
    };
    const chapterTitle = content.chapterTitle || null;

    if (existing) {
      const annotation = existing.annotationId ? await this.repo.findAnnotation(existing.annotationId, userId, tx) : null;
      if (annotation && !annotation.deletedAt && (annotation.text !== text || existing.spineIndex !== content.spineIndex)) {
        await this.repo.updateAnnotationContent(annotation.id, { text, chapterTitle: chapterTitle ?? annotation.chapterTitle }, tx);
        await this.repo.upsertCfiPosition(annotation.id, userId, file.id, await this.clippingToCfi(file, content), tx);
      }
      await this.repo.updateLive(existing.id, content, tx);
      return;
    }

    const annotationId = await this.repo.insertAnnotation(
      {
        userId,
        bookId: file.bookId,
        text,
        chapterTitle,
        origin: 'crosspoint',
        sourceCreatedAt: new Date(content.deviceCreatedAt! * 1000),
      },
      tx,
    );
    await this.repo.upsertCfiPosition(annotationId, userId, file.id, await this.clippingToCfi(file, content), tx);
    await this.repo.insertLive({ userId, bookFileId: file.id, bookId: file.bookId, clippingId: item.id, annotationId, ...content }, tx);
  }

  /** Anchors a clipping by its visible offsets, falling back to the quote within the spine item. */
  async clippingToCfi(
    file: ResolvedFile,
    content: Pick<ClippingContent, 'spineIndex' | 'text' | 'startOffset' | 'endOffset'>,
  ): Promise<string | null> {
    const chapterIndex = content.spineIndex ?? 0;
    const doc = await this.loadChapter(file, chapterIndex);
    if (!doc) return null;
    const map = new VisibleTextMap(doc.root);
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();

    let range: { start: number; end: number } | null = null;
    if (content.startOffset != null && content.endOffset != null && content.endOffset <= map.length) {
      const candidate = { start: content.startOffset, end: content.endOffset };
      if (normalize(map.text(candidate.start, candidate.end)) === normalize(content.text ?? '')) range = candidate;
    }
    range ??= map.find(content.text ?? '');
    if (!range) return null;

    const start = map.pointAt(range.start, false);
    const end = map.pointAt(range.end, true);
    if (!start || !end) return null;
    try {
      return joinCfiIndirection(spineCfiForChapterIndex(chapterIndex), cfiFromRangePoints(start, end));
    } catch {
      return null;
    }
  }

  /** Derives the clipping a CFI range annotation would be on the device, or null when it cannot be anchored. */
  async cfiToClipping(file: ResolvedFile, cfi: string): Promise<{ spineIndex: number; startOffset: number; endOffset: number; text: string } | null> {
    const parsed = parseCfi(cfi);
    const chapterIndex = chapterIndexFromSpineStep(parsed?.spineStep ?? null);
    if (!parsed || chapterIndex == null) return null;
    const doc = await this.loadChapter(file, chapterIndex);
    if (!doc) return null;
    const startPoint = resolveCfiParts(doc.root, parsed.start);
    const endPoint = resolveCfiParts(doc.root, parsed.end);
    if (!startPoint?.node || !endPoint?.node || !isTextNode(startPoint.node) || !isTextNode(endPoint.node)) return null;
    const map = new VisibleTextMap(doc.root);
    const startOffset = map.offsetOf(startPoint.node, startPoint.offset ?? 0);
    const endOffset = map.offsetOf(endPoint.node, endPoint.offset ?? 0);
    if (startOffset == null || endOffset == null || endOffset <= startOffset) return null;
    const text = map.text(startOffset, endOffset).trim();
    if (!text) return null;
    return { spineIndex: chapterIndex, startOffset, endOffset, text };
  }

  private async loadChapter(file: ResolvedFile, chapterIndex: number) {
    const format = (file.format ?? '').toLowerCase();
    if (format !== 'epub' && format !== 'kepub') return null;
    return this.epubDom.getChapter(file.id, chapterIndex);
  }

  /**
   * Brings BookOrbit-side changes into the clipping feed: annotations created elsewhere become
   * clippings, and clippings whose annotation was deleted become tombstones. Bounded per pull.
   */
  private async mirrorAnnotations(userId: number, file: ResolvedFile): Promise<void> {
    await this.repo.markDeleted(await this.repo.findOrphanedLive(userId, file.id, MIRROR_BATCH));

    const candidates = await this.repo.findUnmirroredAnnotations(userId, file.bookId, file.id, MIRROR_BATCH);
    if (candidates.length === 0) return;
    await this.repo.transaction(async (tx) => {
      for (const annotation of candidates) {
        const clipping = annotation.cfi ? await this.cfiToClipping(file, annotation.cfi) : null;
        const createdAt = Math.floor(annotation.createdAt.getTime() / 1000);
        const clippingId = clipping ? clippingIdFor(createdAt, clipping.text) : null;
        if (
          !clipping ||
          !clippingId ||
          Buffer.byteLength(clipping.text) > CLIPPING_TEXT_MAX_BYTES ||
          (await this.repo.findByClippingId(userId, file.id, clippingId, tx))
        ) {
          // Recorded as a tombstone so the next pull does not retry it; the device has never held this id.
          await this.repo.insertTombstone(userId, file.id, file.bookId, `bookorbit-${annotation.id}`, tx, annotation.id);
          continue;
        }
        await this.repo.insertLive(
          {
            userId,
            bookFileId: file.id,
            bookId: file.bookId,
            clippingId,
            annotationId: annotation.id,
            spineIndex: clipping.spineIndex,
            chapterTitle: (annotation.chapterTitle ?? '').slice(0, CHAPTER_TITLE_MAX),
            text: clipping.text,
            deviceCreatedAt: createdAt,
            startOffset: clipping.startOffset,
            endOffset: clipping.endOffset,
          },
          tx,
        );
      }
    });
  }
}
