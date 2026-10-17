import { desc, eq, sql } from 'drizzle-orm';
import type { AuditEntry } from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { auditLogs, users } from '../db/schema';

type Writer = Pick<DrizzleDB, 'insert'>;

export interface AuditInput {
  userId: string | null;
  action: string;
  tableName?: string;
  recordId?: string;
  oldValues?: unknown;
  newValues?: unknown;
}

export class AuditService {
  async record(writer: Writer, input: AuditInput): Promise<void> {
    await writer.insert(auditLogs).values({
      userId: input.userId,
      action: input.action,
      tableName: input.tableName ?? null,
      recordId: input.recordId ?? null,
      oldValues: input.oldValues ?? null,
      newValues: input.newValues ?? null,
    });
  }

  async list(
    db: DrizzleDB,
    options: { page: number; limit: number; recordId?: string },
  ): Promise<{ items: AuditEntry[]; total: number }> {
    const where = options.recordId ? eq(auditLogs.recordId, options.recordId) : undefined;
    const offset = (options.page - 1) * options.limit;

    const rows = await db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        tableName: auditLogs.tableName,
        recordId: auditLogs.recordId,
        oldValues: auditLogs.oldValues,
        newValues: auditLogs.newValues,
        createdAt: auditLogs.createdAt,
        actorId: users.id,
        actorEmail: users.email,
        actorName: users.fullName,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(options.limit)
      .offset(offset);

    const [counted] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(where);

    return {
      items: rows.map((row) => ({
        id: row.id,
        action: row.action,
        tableName: row.tableName,
        recordId: row.recordId,
        oldValues: row.oldValues,
        newValues: row.newValues,
        createdAt: row.createdAt.toISOString(),
        actor: row.actorId
          ? { id: row.actorId, email: row.actorEmail!, fullName: row.actorName! }
          : null,
      })),
      total: Number(counted?.total ?? 0),
    };
  }
}
