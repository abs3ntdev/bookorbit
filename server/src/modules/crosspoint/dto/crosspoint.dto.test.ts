import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CrosspointClippingsQueryDto, CrosspointPutClippingsDto, CrosspointSaveProgressDto } from './crosspoint.dto';

const strict = { whitelist: true, forbidNonWhitelisted: true };
const ITEM = {
  id: 'c0ffee0011223344',
  spine: 7,
  start_page: 12,
  end_page: 13,
  pages: 40,
  start_word: 5,
  end_word: 22,
  words: 30,
  para: 96,
  chapter: 'Chapter 8',
  text: 'So we beat on',
  created_at: 1752300000,
  layout_signature: 99,
  start_offset: 10,
  end_offset: 23,
};

async function errorsFor<T extends object>(cls: new () => T, body: unknown) {
  return validate(plainToInstance(cls, body) as object, strict);
}

describe('CrosspointSaveProgressDto', () => {
  it('accepts the CrossPoint body with metadata and a rich position', async () => {
    const body = {
      document: 'a1b2',
      progress: '/body/DocFragment[8]/body/p[4]/text().96',
      percentage: 0.4867,
      device: 'CrossPoint',
      device_id: 'A1B2C3D4',
      metadata: { filename: 'b.epub', title: 'B', authors: 'A' },
      position: { pctQ: 486700, spine: 7, page: 143, pages: 412, para: 96, xpath: '/body/DocFragment[8]' },
    };
    expect(await errorsFor(CrosspointSaveProgressDto, body)).toHaveLength(0);
  });

  it('still rejects unknown top-level fields', async () => {
    expect(await errorsFor(CrosspointSaveProgressDto, { document: 'a', percentage: 0.1, extra: 1 })).not.toHaveLength(0);
  });
});

describe('CrosspointClippingsQueryDto', () => {
  it('accepts the firmware probe', async () => {
    const dto = plainToInstance(CrosspointClippingsQueryDto, { cursor: '0', limit: '1', format: 'reader' });
    expect(await validate(dto, strict)).toHaveLength(0);
    expect(dto).toMatchObject({ cursor: 0, limit: 1 });
  });

  it('rejects a negative cursor', async () => {
    expect(await errorsFor(CrosspointClippingsQueryDto, { cursor: '-1' })).not.toHaveLength(0);
  });
});

describe('CrosspointPutClippingsDto', () => {
  it('accepts an encoded firmware clipping and a bare deletion', async () => {
    expect(await errorsFor(CrosspointPutClippingsDto, { items: [ITEM] })).toHaveLength(0);
    expect(await errorsFor(CrosspointPutClippingsDto, { items: [{ id: 'abc', deleted: 1 }] })).toHaveLength(0);
  });

  it.each([
    ['uint16 overflow', { spine: 70000 }],
    ['one offset only', { end_offset: undefined }],
    ['empty text', { text: '' }],
    ['non-printable id', { id: 'has space' }],
  ])('rejects %s', async (_label, patch) => {
    expect(await errorsFor(CrosspointPutClippingsDto, { items: [{ ...ITEM, ...patch }] })).not.toHaveLength(0);
  });

  it('caps the batch at 50', async () => {
    expect(await errorsFor(CrosspointPutClippingsDto, { items: Array.from({ length: 51 }, () => ITEM) })).not.toHaveLength(0);
  });
});
