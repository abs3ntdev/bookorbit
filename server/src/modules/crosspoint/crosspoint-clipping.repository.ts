import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, notExists, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import {
  annotationPositions,
  annotations,
  crosspointClippingRevisionSeq,
  crosspointClippings,
  type CrosspointClippingRow,
  type NewCrosspointClipping,
} from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;
export type CrosspointTx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | CrosspointTx;

const nextRevision = sql<number>`nextval(${sql.raw(`'${crosspointClippingRevisionSeq.seqName}'`)})`;

export type ClippingContent = Omit<
  NewCrosspointClipping,
  'id' | 'userId' | 'bookFileId' | 'bookId' | 'clippingId' | 'revision' | 'deleted' | 'annotationId'
>;

/** Owns crosspoint_clippings and the annotation rows they mirror. */
@Injectable()
export class CrosspointClippingRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  transaction<T>(fn: (tx: CrosspointTx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  async findPage(userId: number, bookFileId: number, cursor: number, limit: number): Promise<CrosspointClippingRow[]> {
    return this.db
      .select()
      .from(crosspointClippings)
      .where(and(eq(crosspointClippings.userId, userId), eq(crosspointClippings.bookFileId, bookFileId), gt(crosspointClippings.revision, cursor)))
      .orderBy(asc(crosspointClippings.revision))
      .limit(limit);
  }

  async findByClippingId(userId: number, bookFileId: number, clippingId: string, tx: Executor = this.db): Promise<CrosspointClippingRow | null> {
    const [row] = await tx
      .select()
      .from(crosspointClippings)
      .where(
        and(eq(crosspointClippings.userId, userId), eq(crosspointClippings.bookFileId, bookFileId), eq(crosspointClippings.clippingId, clippingId)),
      )
      .for('update')
      .limit(1);
    return row ?? null;
  }

  async insertTombstone(
    userId: number,
    bookFileId: number,
    bookId: number,
    clippingId: string,
    tx: Executor,
    annotationId: number | null = null,
  ): Promise<void> {
    await tx
      .insert(crosspointClippings)
      .values({ userId, bookFileId, bookId, clippingId, annotationId, deleted: true, revision: nextRevision })
      .onConflictDoUpdate({
        target: [crosspointClippings.userId, crosspointClippings.bookFileId, crosspointClippings.clippingId],
        set: { deleted: true, revision: nextRevision },
      });
  }

  async markDeleted(ids: number[], tx: Executor = this.db): Promise<void> {
    if (ids.length === 0) return;
    await tx.update(crosspointClippings).set({ deleted: true, revision: nextRevision }).where(inArray(crosspointClippings.id, ids));
  }

  async insertLive(
    row: { userId: number; bookFileId: number; bookId: number; clippingId: string; annotationId: number | null } & ClippingContent,
    tx: Executor,
  ): Promise<void> {
    await tx.insert(crosspointClippings).values({ ...row, revision: nextRevision });
  }

  async updateLive(id: number, content: ClippingContent & { annotationId?: number | null }, tx: Executor): Promise<void> {
    await tx
      .update(crosspointClippings)
      .set({ ...content, revision: nextRevision })
      .where(eq(crosspointClippings.id, id));
  }

  async softDeleteAnnotation(annotationId: number, userId: number, tx: Executor): Promise<void> {
    await tx
      .update(annotations)
      .set({ deletedAt: sql`now()`, version: sql`${annotations.version} + 1` })
      .where(and(eq(annotations.id, annotationId), eq(annotations.userId, userId), isNull(annotations.deletedAt)));
  }

  async findAnnotation(annotationId: number, userId: number, tx: Executor) {
    const [row] = await tx
      .select()
      .from(annotations)
      .where(and(eq(annotations.id, annotationId), eq(annotations.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  async insertAnnotation(values: typeof annotations.$inferInsert, tx: Executor): Promise<number> {
    const [row] = await tx.insert(annotations).values(values).returning({ id: annotations.id });
    return row.id;
  }

  async updateAnnotationContent(annotationId: number, content: { text: string; chapterTitle: string | null }, tx: Executor): Promise<void> {
    await tx
      .update(annotations)
      .set({ ...content, contentUpdatedAt: sql`now()`, version: sql`${annotations.version} + 1` })
      .where(eq(annotations.id, annotationId));
  }

  async upsertCfiPosition(annotationId: number, userId: number, bookFileId: number, cfi: string | null, tx: Executor): Promise<void> {
    const values = { pos0: cfi, status: cfi ? ('exact' as const) : ('failed' as const), bookFileId };
    await tx
      .insert(annotationPositions)
      .values({ annotationId, userId, format: 'cfi', ...values })
      .onConflictDoUpdate({ target: [annotationPositions.annotationId, annotationPositions.format], set: values });
  }

  /** Clippings whose BookOrbit annotation was deleted or purged since the device last saw them. */
  async findOrphanedLive(userId: number, bookFileId: number, limit: number): Promise<number[]> {
    const rows = await this.db
      .select({ id: crosspointClippings.id })
      .from(crosspointClippings)
      .leftJoin(annotations, eq(annotations.id, crosspointClippings.annotationId))
      .where(
        and(
          eq(crosspointClippings.userId, userId),
          eq(crosspointClippings.bookFileId, bookFileId),
          eq(crosspointClippings.deleted, false),
          sql`(${annotations.id} is null or ${annotations.deletedAt} is not null)`,
        ),
      )
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /** Live annotations on the book with a CFI and no clipping for this file yet. */
  async findUnmirroredAnnotations(userId: number, bookId: number, bookFileId: number, limit: number) {
    return this.db
      .select({
        id: annotations.id,
        text: annotations.text,
        chapterTitle: annotations.chapterTitle,
        createdAt: sql<Date>`coalesce(${annotations.sourceCreatedAt}, ${annotations.createdAt})`.mapWith((v: string | Date) => new Date(v)),
        cfi: annotationPositions.pos0,
      })
      .from(annotations)
      .innerJoin(annotationPositions, and(eq(annotationPositions.annotationId, annotations.id), eq(annotationPositions.format, 'cfi')))
      .where(
        and(
          eq(annotations.userId, userId),
          eq(annotations.bookId, bookId),
          isNull(annotations.deletedAt),
          sql`${annotationPositions.pos0} is not null`,
          sql`(${annotationPositions.bookFileId} is null or ${annotationPositions.bookFileId} = ${bookFileId})`,
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(crosspointClippings)
              .where(and(eq(crosspointClippings.bookFileId, bookFileId), eq(crosspointClippings.annotationId, annotations.id))),
          ),
        ),
      )
      .orderBy(asc(annotations.id))
      .limit(limit);
  }
}
