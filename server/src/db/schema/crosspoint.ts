import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, pgSequence, pgTable, serial, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { users } from './auth';
import { bookFiles, books } from './books';
import { annotations } from './reader';

// One clock for every clipping write, so a device paging by `revision > cursor` never skips a
// row that shares a timestamp with another.
export const crosspointClippingRevisionSeq = pgSequence('crosspoint_clipping_revision_seq');

/**
 * CrossPoint clippings as the firmware holds them, keyed by the device-derived id. Layout fields
 * are kept verbatim so the device restores its own clipping exactly; the BookOrbit annotation is
 * linked through annotationId. A deleted row is a permanent tombstone for that id.
 */
export const crosspointClippings = pgTable(
  'crosspoint_clippings',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookFileId: integer('book_file_id')
      .notNull()
      .references(() => bookFiles.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    annotationId: integer('annotation_id').references(() => annotations.id, { onDelete: 'set null' }),
    clippingId: varchar('clipping_id', { length: 64 }).notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    deleted: boolean('deleted').notNull().default(false),
    spineIndex: integer('spine_index').notNull().default(0),
    startPage: integer('start_page').notNull().default(0),
    endPage: integer('end_page').notNull().default(0),
    pageCount: integer('page_count').notNull().default(1),
    startWord: integer('start_word').notNull().default(0),
    endWord: integer('end_word').notNull().default(0),
    wordCount: integer('word_count').notNull().default(0),
    paragraphIndex: integer('paragraph_index'),
    chapterTitle: varchar('chapter_title', { length: 64 }).notNull().default(''),
    text: text('text').notNull().default(''),
    // Device unix seconds; immutable part of the clipping id.
    deviceCreatedAt: bigint('device_created_at', { mode: 'number' }).notNull().default(0),
    layoutSignature: bigint('layout_signature', { mode: 'number' }).notNull().default(0),
    startOffset: bigint('start_offset', { mode: 'number' }),
    endOffset: bigint('end_offset', { mode: 'number' }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('crosspoint_clippings_user_file_clipping_uidx').on(t.userId, t.bookFileId, t.clippingId),
    index('crosspoint_clippings_user_file_revision_idx').on(t.userId, t.bookFileId, t.revision),
    uniqueIndex('crosspoint_clippings_file_annotation_uidx')
      .on(t.bookFileId, t.annotationId)
      .where(sql`${t.annotationId} is not null`),
    index('crosspoint_clippings_annotation_id_idx').on(t.annotationId),
    check('crosspoint_clippings_offsets_chk', sql`(${t.startOffset} is null) = (${t.endOffset} is null)`),
  ],
);

export type CrosspointClippingRow = typeof crosspointClippings.$inferSelect;
export type NewCrosspointClipping = typeof crosspointClippings.$inferInsert;
