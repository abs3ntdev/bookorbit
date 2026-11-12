import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { RequestUser } from '../../common/types/request-user';
import { parseChapterDocument } from '../position-converter/position-converter.core';
import { clippingIdFor, CrosspointService } from './crosspoint.service';

const CHAPTER =
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p>Hello brave new world.</p><p>Second paragraph here.</p></body></html>';
const FILE = { id: 11, bookId: 22, libraryId: 1, format: 'epub' };

function build() {
  const koreaderService = { saveProgress: vi.fn().mockResolvedValue({ document: 'h', timestamp: 1 }), getProgress: vi.fn().mockResolvedValue(null) };
  const koreaderRepo = { resolveBookFileByHash: vi.fn().mockResolvedValue(FILE) };
  const libraryScope = { visibleIdsOrAllForUserId: vi.fn().mockResolvedValue(null) };
  const repo = {
    transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn('tx')),
    findPage: vi.fn().mockResolvedValue([]),
    findByClippingId: vi.fn().mockResolvedValue(null),
    insertTombstone: vi.fn(),
    markDeleted: vi.fn(),
    insertLive: vi.fn(),
    updateLive: vi.fn(),
    softDeleteAnnotation: vi.fn(),
    findAnnotation: vi.fn(),
    insertAnnotation: vi.fn().mockResolvedValue(99),
    updateAnnotationContent: vi.fn(),
    upsertCfiPosition: vi.fn(),
    findOrphanedLive: vi.fn().mockResolvedValue([]),
    findUnmirroredAnnotations: vi.fn().mockResolvedValue([]),
  };
  const epubDom = { getChapter: vi.fn().mockResolvedValue(parseChapterDocument(CHAPTER)) };
  const service = new CrosspointService(koreaderService as never, koreaderRepo as never, libraryScope as never, repo as never, epubDom as never);
  return { service, koreaderService, koreaderRepo, repo };
}

const ITEM = { id: 'abc', spine: 0, text: 'brave new', created_at: 1_780_000_000, start_offset: 6, end_offset: 15, layout_signature: 5 };

describe('CrosspointService', () => {
  describe('progress', () => {
    it('labels the device CrossPoint and falls back to the position xpath', async () => {
      const { service, koreaderService } = build();
      await service.saveProgress({ id: 1 } as RequestUser, { document: 'h', percentage: 0.2, position: { xpath: '/body/DocFragment[1]/body/p' } });
      expect(koreaderService.saveProgress).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ device: 'CrossPoint', progress: '/body/DocFragment[1]/body/p', percentage: 0.2 }),
      );
    });

    it('answers an unknown document with an empty object', async () => {
      const { service } = build();
      await expect(service.getProgress(1, 'h')).resolves.toEqual({});
    });
  });

  describe('getClippings', () => {
    it('serves the v2 envelope with an unchanged cursor when there is nothing new', async () => {
      const { service } = build();
      await expect(service.getClippings(1, 'h', 7, 1)).resolves.toMatchObject({ sync_version: 2, cursor: 7, more: false, items: [] });
    });

    it('pages one item at a time and advances the cursor to its revision', async () => {
      const { service, repo } = build();
      const row = (revision: number, deleted = false) => ({
        clippingId: `id${revision}`,
        revision,
        deleted,
        spineIndex: 0,
        startPage: 0,
        endPage: 0,
        pageCount: 1,
        startWord: 0,
        endWord: 0,
        wordCount: 0,
        paragraphIndex: null,
        chapterTitle: '',
        text: 'x',
        deviceCreatedAt: 5,
        layoutSignature: 0,
        startOffset: null,
        endOffset: null,
      });
      repo.findPage.mockResolvedValue([row(3), row(4, true)]);
      const page = await service.getClippings(1, 'h', 2, 1);
      expect(page).toMatchObject({ cursor: 3, more: true });
      expect(page.items).toEqual([expect.objectContaining({ id: 'id3', revision: 3, deleted: 0, created_at: 5 })]);
      expect(page.items[0]).not.toHaveProperty('para');
      expect(page.items[0]).not.toHaveProperty('start_offset');
    });

    it('mirrors web annotations into clippings on a fresh pull', async () => {
      const { service, repo } = build();
      const createdAt = new Date(1_780_000_000_000);
      repo.findUnmirroredAnnotations.mockResolvedValue([
        { id: 5, text: 'paragraph', chapterTitle: null, createdAt, cfi: 'epubcfi(/6/2!/4/4,/1:7,/1:16)' },
      ]);
      await service.getClippings(1, 'h', 0, 1);
      expect(repo.insertLive).toHaveBeenCalledWith(
        expect.objectContaining({
          annotationId: 5,
          clippingId: clippingIdFor(1_780_000_000, 'paragraph'),
          text: 'paragraph',
          startOffset: 29,
          endOffset: 38,
        }),
        'tx',
      );
    });
  });

  describe('putClippings', () => {
    it('throws when the document does not resolve', async () => {
      const { service, koreaderRepo } = build();
      koreaderRepo.resolveBookFileByHash.mockResolvedValue(null);
      await expect(service.putClippings(1, 'h', [ITEM])).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects offsets out of order', async () => {
      const { service } = build();
      await expect(service.putClippings(1, 'h', [{ ...ITEM, start_offset: 9, end_offset: 9 }])).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates a crosspoint annotation anchored by the visible offsets', async () => {
      const { service, repo } = build();
      await expect(service.putClippings(1, 'h', [ITEM])).resolves.toMatchObject({ accepted: 1 });
      expect(repo.insertAnnotation).toHaveBeenCalledWith(expect.objectContaining({ origin: 'crosspoint', text: 'brave new', bookId: 22 }), 'tx');
      expect(repo.upsertCfiPosition).toHaveBeenCalledWith(99, 1, 11, 'epubcfi(/6/2!/4/2,/1:6,/1:15)', 'tx');
      expect(repo.insertLive).toHaveBeenCalledWith(expect.objectContaining({ clippingId: 'abc', annotationId: 99, layoutSignature: 5 }), 'tx');
    });

    it('anchors by quote when offsets do not match the text', async () => {
      const { service, repo } = build();
      await service.putClippings(1, 'h', [{ ...ITEM, start_offset: 0, end_offset: 9 }]);
      expect(repo.upsertCfiPosition).toHaveBeenCalledWith(99, 1, 11, 'epubcfi(/6/2!/4/2,/1:6,/1:15)', 'tx');
    });

    it('never resurrects a tombstoned id', async () => {
      const { service, repo } = build();
      repo.findByClippingId.mockResolvedValue({ id: 1, deleted: true });
      await service.putClippings(1, 'h', [ITEM]);
      expect(repo.insertAnnotation).not.toHaveBeenCalled();
      expect(repo.updateLive).not.toHaveBeenCalled();
    });

    it('tombstones a deletion and trashes its annotation', async () => {
      const { service, repo } = build();
      repo.findByClippingId.mockResolvedValue({ id: 1, deleted: false, annotationId: 42 });
      await service.putClippings(1, 'h', [{ id: 'abc', deleted: 1 }]);
      expect(repo.softDeleteAnnotation).toHaveBeenCalledWith(42, 1, 'tx');
      expect(repo.insertTombstone).toHaveBeenCalledWith(1, 11, 22, 'abc', 'tx');
    });
  });
});
