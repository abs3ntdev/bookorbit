import { createHash, randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';

import * as schema from '../src/db/schema';
import { createZipArchiveFixture } from './e2e/reader-state-isolation/reader-state-isolation-fixture-builder';
import {
  authHeader,
  closeReaderStateIsolationE2EContext,
  createLibraryWithFolder,
  createReaderStateIsolationE2EContext,
  locateBookByAbsolutePath,
  triggerAndWaitForLibraryScan,
  type CreatedLibrary,
  type LocatedBookFile,
  type ReaderStateIsolationE2EContext,
} from './e2e/reader-state-isolation/reader-state-isolation-harness';

const USERNAME = `crosspoint-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'CrossPointPass123';
// The firmware sends md5(password) as x-auth-key.
const KEY = createHash('md5').update(PASSWORD).digest('hex');
const CHAPTER = 'Hello brave new world.Second paragraph here.';

interface Page {
  document: string;
  sync_version: number;
  cursor: number;
  more: boolean;
  items: Record<string, unknown>[];
}

async function createChapterEpub(folder: string, name: string): Promise<string> {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="uid" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:${randomUUID()}</dc:identifier><dc:title>CrossPoint ${randomUUID()}</dc:title><dc:language>en</dc:language></metadata>
  <manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml" /></manifest>
  <spine><itemref idref="c1" /></spine>
</package>`;
  const chapter = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p>Hello brave new world.</p><p>Second paragraph here.</p></body></html>`;
  return createZipArchiveFixture(folder, name, [
    { path: 'mimetype', content: 'application/epub+zip', store: true },
    {
      path: 'META-INF/container.xml',
      content: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles></container>`,
    },
    { path: 'OPS/content.opf', content: opf },
    { path: 'OPS/chapter.xhtml', content: chapter },
  ]);
}

function clipping(id: string, text: string, start: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    spine: 0,
    start_page: 0,
    end_page: 0,
    pages: 1,
    start_word: 1,
    end_word: 2,
    words: 4,
    para: 1,
    chapter: 'Chapter 1',
    text,
    created_at: 1_780_000_000,
    layout_signature: 123456,
    start_offset: start,
    end_offset: start + text.length,
    ...extra,
  };
}

describe('CrossPoint sync (e2e)', { timeout: 120_000 }, () => {
  let ctx!: ReaderStateIsolationE2EContext;
  let library!: CreatedLibrary;
  let epub!: LocatedBookFile;
  let hash!: string;
  const headers = () => ({ 'x-auth-user': USERNAME, 'x-auth-key': KEY, 'content-type': 'application/json' });

  async function get(url: string) {
    const response = await ctx.app.inject({ method: 'GET', url, headers: headers() });
    expect(response.statusCode).toBe(200);
    return response.json() as Page;
  }

  async function put(item: Record<string, unknown>) {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/crosspoint/api/v1/clippings/${hash}`,
      headers: headers(),
      payload: { items: [item] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: 1 });
  }

  // The firmware's pull loop: limit=1 pages until `more` is false, with its pagination checks.
  async function pullAll(): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let cursor = 0;
    let page: Page;
    do {
      page = await get(`/api/v1/crosspoint/api/v1/clippings/${hash}?limit=1&format=reader&cursor=${cursor}`);
      expect(page.items.length).toBeLessThanOrEqual(1);
      expect(page.cursor).toBeGreaterThanOrEqual(cursor);
      if (page.items.length) expect(page.cursor).toBeGreaterThan(cursor);
      if (page.more) expect(page.items.length).toBe(1);
      items.push(...page.items);
      cursor = page.cursor;
    } while (page.more);
    return items;
  }

  beforeAll(async () => {
    ctx = await createReaderStateIsolationE2EContext();
    library = await createLibraryWithFolder(ctx, { name: `crosspoint-${randomUUID()}` });
    const path = await createChapterEpub(library.folderPath, 'crosspoint.epub');
    await triggerAndWaitForLibraryScan(ctx, library.libraryId);
    epub = await locateBookByAbsolutePath(ctx, path);
    const [file] = await ctx.db
      .select({ fileHash: schema.bookFiles.fileHash })
      .from(schema.bookFiles)
      .where(eq(schema.bookFiles.id, epub.bookFileId));
    hash = file!.fileHash!;

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/koreader/credentials',
      headers: authHeader(ctx.adminToken),
      payload: { username: USERNAME, password: PASSWORD },
    });
    if (created.statusCode === 409) {
      const updated = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/koreader/credentials',
        headers: authHeader(ctx.adminToken),
        payload: { username: USERNAME, password: PASSWORD },
      });
      expect(updated.statusCode).toBe(200);
    } else {
      expect([200, 201]).toContain(created.statusCode);
    }
  }, 120_000);

  afterAll(async () => {
    if (ctx) await closeReaderStateIsolationE2EContext(ctx);
  });

  it('authenticates with the KOReader credentials and refuses registration', async () => {
    const auth = await ctx.app.inject({ method: 'GET', url: '/api/v1/crosspoint/users/auth', headers: headers() });
    expect(auth.statusCode).toBe(200);
    expect(auth.json()).toEqual({ authorized: 'OK', username: USERNAME });

    const bad = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/crosspoint/users/auth',
      headers: { 'x-auth-user': USERNAME, 'x-auth-key': 'nope' },
    });
    expect(bad.statusCode).toBe(401);

    const create = await ctx.app.inject({ method: 'POST', url: '/api/v1/crosspoint/users/create', headers: headers(), payload: {} });
    expect(create.statusCode).toBe(403);
  });

  it('stores progress sent with a rich position and serves it back', async () => {
    const xpath = '/body/DocFragment[1]/body/p[2]/text().0';
    const saved = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/crosspoint/syncs/progress',
      headers: headers(),
      payload: {
        document: hash,
        metadata: { filename: 'crosspoint.epub', title: 'CrossPoint', authors: 'Author' },
        progress: xpath,
        percentage: 0.5,
        device: 'CrossPoint',
        device_id: 'A1B2C3D4',
        position: { pctQ: 500000, spine: 0, page: 1, pages: 2, para: 2, xpath },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ document: hash });

    const fetched = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/crosspoint/syncs/progress/${hash}?position_kinds=locator,percentage`,
      headers: headers(),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ document: hash, percentage: 0.5, progress: xpath });

    const [device] = await ctx.db
      .select({ device: schema.koreaderDeviceProgress.device, progress: schema.koreaderDeviceProgress.progress })
      .from(schema.koreaderDeviceProgress)
      .where(and(eq(schema.koreaderDeviceProgress.bookFileId, epub.bookFileId), eq(schema.koreaderDeviceProgress.deviceId, 'A1B2C3D4')));
    expect(device).toEqual({ device: 'CrossPoint', progress: xpath });
  });

  it('runs the firmware clipping sequence: probe, deletions, uploads, paged pull', async () => {
    const probe = await get(`/api/v1/crosspoint/api/v1/clippings/${hash}?cursor=0&limit=1&format=reader`);
    expect(probe).toMatchObject({ sync_version: 2, cursor: 0, more: false, items: [] });

    await put({ id: 'never-uploaded', deleted: 1 });
    await put(clipping('c0ffee0011223344', 'brave new', 6));
    await put(clipping('c0ffee0011223355', 'Second paragraph', 22));

    const items = await pullAll();
    const live = items.filter((item) => item.deleted === 0);
    expect(items.find((item) => item.id === 'never-uploaded')).toEqual({ id: 'never-uploaded', revision: expect.any(Number), deleted: 1 });
    expect(live.map((item) => item.id).sort()).toEqual(['c0ffee0011223344', 'c0ffee0011223355']);
    const first = live.find((item) => item.id === 'c0ffee0011223344')!;
    expect(first).toEqual({ ...clipping('c0ffee0011223344', 'brave new', 6), revision: expect.any(Number), deleted: 0 });

    const annotations = await ctx.db
      .select({ text: schema.annotations.text, origin: schema.annotations.origin, cfi: schema.annotationPositions.pos0 })
      .from(schema.annotations)
      .innerJoin(schema.annotationPositions, eq(schema.annotationPositions.annotationId, schema.annotations.id))
      .where(and(eq(schema.annotations.bookId, epub.bookId), eq(schema.annotations.origin, 'crosspoint')));
    expect(annotations).toEqual(
      expect.arrayContaining([
        { text: 'brave new', origin: 'crosspoint', cfi: 'epubcfi(/6/2!/4/2,/1:6,/1:15)' },
        { text: 'Second paragraph', origin: 'crosspoint', cfi: 'epubcfi(/6/2!/4/4,/1:0,/1:16)' },
      ]),
    );
  });

  it('keeps deleted ids deleted and removes their BookOrbit annotation', async () => {
    await put({ id: 'c0ffee0011223355', deleted: 1 });
    await put(clipping('c0ffee0011223355', 'Second paragraph', 22));

    const items = await pullAll();
    expect(items.find((item) => item.id === 'c0ffee0011223355')).toMatchObject({ deleted: 1 });
    const [row] = await ctx.db
      .select({ deletedAt: schema.annotations.deletedAt })
      .from(schema.annotations)
      .where(and(eq(schema.annotations.bookId, epub.bookId), eq(schema.annotations.text, 'Second paragraph')));
    expect(row.deletedAt).not.toBeNull();
  });

  it('serves web-reader highlights as clippings and tombstones them once deleted', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/books/${epub.bookId}/annotations`,
      headers: authHeader(ctx.adminToken),
      payload: { cfi: 'epubcfi(/6/2!/4/4,/1:7,/1:16)', text: 'paragraph', color: 'yellow', bookFileId: epub.bookFileId },
    });
    expect([200, 201]).toContain(created.statusCode);
    const annotationId = (created.json() as { id: number }).id;

    const items = await pullAll();
    const web = items.find((item) => item.text === 'paragraph');
    expect(web).toMatchObject({ deleted: 0, spine: 0, start_offset: 29, end_offset: 38, layout_signature: 0, pages: 1 });
    expect(String(web!.id)).toMatch(/^[0-9a-f]{16}$/);
    expect(CHAPTER.slice(29, 38)).toBe('paragraph');

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/books/${epub.bookId}/annotations/${annotationId}`,
      headers: authHeader(ctx.adminToken),
    });
    expect([200, 204]).toContain(removed.statusCode);

    const after = await pullAll();
    expect(after.find((item) => item.id === web!.id)).toMatchObject({ deleted: 1 });
  });

  it('rejects an incompatible clipping body', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/crosspoint/api/v1/clippings/${hash}`,
      headers: headers(),
      payload: { items: [{ ...clipping('bad', 'x', 0), spine: 70000 }] },
    });
    expect(response.statusCode).toBe(400);
  });
});
